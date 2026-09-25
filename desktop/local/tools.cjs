const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_TOOL_CALLS_PER_TURN = 4;
const TOOL_TIMEOUT_MS = 10_000;

const BUILTIN_TOOLS = [
  {
    id: 'get_current_time', name: 'get_current_time',
    description: 'Return the current time in the requested IANA timezone.',
    inputSchema: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA timezone such as Asia/Jakarta.' } }, additionalProperties: false },
    source: 'builtin', permissionClass: 'READ', enabled: false, status: 'READY',
  },
  {
    id: 'echo_text', name: 'echo_text',
    description: 'Echo text supplied by the user for deterministic tool testing.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    source: 'builtin', permissionClass: 'READ', enabled: false, status: 'READY',
  },
];

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function validateArgs(schema, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Argumen harus berupa objek JSON.';
  const properties = schema?.properties || {};
  for (const key of schema?.required || []) if (!(key in value)) return `Argumen wajib '${key}' belum diisi.`;
  if (schema?.additionalProperties === false) for (const key of Object.keys(value)) if (!properties[key]) return `Argumen '${key}' tidak dikenal.`;
  for (const [key, spec] of Object.entries(properties)) {
    if (!(key in value) || value[key] === null) continue;
    const actual = Array.isArray(value[key]) ? 'array' : typeof value[key];
    if (spec.type && actual !== spec.type && !(spec.type === 'integer' && actual === 'number' && Number.isInteger(value[key]))) return `Argumen '${key}' harus bertipe ${spec.type}.`;
  }
  return null;
}

function withTimeout(promise, ms, message = 'Tool timed out.') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

function openRpcProcess(server) {
  const child = spawn(server.command, server.args || [], {
    cwd: server.cwd || process.cwd(),
    env: { ...process.env, ...(server.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message || 'MCP error')) : waiter.resolve(message.result); }
      } catch { /* Ignore malformed fixture output; request timeout reports failure. */ }
    }
  });
  const fail = error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.once('exit', code => fail(new Error(`MCP server berhenti (exit ${code ?? 'unknown'}).`)));
  child.once('error', fail);
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, request };
}

class ToolRegistry {
  constructor({ modelsDir, emit = () => {} } = {}) {
    this.modelsDir = path.resolve(modelsDir || process.cwd());
    this.emit = emit;
    this.tools = new Map(BUILTIN_TOOLS.map(tool => [tool.id, clone(tool)]));
    this.servers = new Map();
  }

  list() { return [...this.tools.values()].map(clone); }
  findTool(name) { return this.tools.get(String(name)) || [...this.tools.values()].find(tool => tool.name === String(name)); }
  schemas() {
    return this.list().filter(tool => tool.enabled && tool.status === 'READY').map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  }
  setEnabled(id, enabled) {
    const tool = this.tools.get(String(id));
    if (!tool) throw new Error(`Tool tidak dikenal: ${id}`);
    tool.enabled = Boolean(enabled);
    this.emit('tools:changed', this.list());
    return clone(tool);
  }

  async execute(name, args = {}, { approved = false } = {}) {
    const tool = this.findTool(name);
    if (!tool) throw new Error(`Tool tidak dikenal: ${name}`);
    if (!tool.enabled) throw new Error(`Tool '${name}' belum diaktifkan.`);
    if (tool.permissionClass !== 'READ' && !approved) throw new Error(`Tool '${name}' membutuhkan persetujuan eksplisit.`);
    const validation = validateArgs(tool.inputSchema, args);
    if (validation) throw new Error(validation);
    const run = async () => {
      if (typeof tool.executor === 'function') return tool.executor(args);
      if (name === 'get_current_time') {
        const timezone = args.timezone || 'Asia/Jakarta';
        try { return { timezone, iso: new Date().toISOString(), local: new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeStyle: 'long', timeZone: timezone }).format(new Date()) }; }
        catch { throw new Error(`Timezone tidak valid: ${timezone}`); }
      }
      if (name === 'echo_text') return { text: args.text };
      throw new Error(`Tool '${name}' belum memiliki executor.`);
    };
    const result = await withTimeout(run(), TOOL_TIMEOUT_MS);
    this.emit('tool:activity', { name, source: tool.source, permissionClass: tool.permissionClass, arguments: args, result });
    return result;
  }

  async registerMcp(definition = {}) {
    const id = String(definition.id || 'local-fixture');
    if (this.servers.has(id)) return this.mcpStatus();
    const server = {
      id, name: String(definition.name || 'Local MCP fixture'), transport: 'stdio',
      command: definition.command || process.env.BOTCONNECTOR_NODE || 'node',
      args: Array.isArray(definition.args) ? definition.args.map(String) : [path.join(__dirname, 'mcp-fixture.cjs')],
      cwd: definition.cwd || process.cwd(), enabled: definition.enabled !== false,
      status: 'STARTING', tools: [], error: null,
    };
    this.servers.set(id, server);
    try {
      server.rpc = openRpcProcess(server);
      await withTimeout(server.rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'BotConnector', version: '0.2.0' } }), TOOL_TIMEOUT_MS, 'MCP server gagal diinisialisasi.');
      const discovered = await withTimeout(server.rpc.request('tools/list', {}), TOOL_TIMEOUT_MS, 'MCP discovery timed out.');
      server.tools = Array.isArray(discovered?.tools) ? discovered.tools.map(item => ({
        id: `${id}:${item.name}`, name: `mcp_${id}_${item.name}`, remoteName: item.name, description: item.description || 'MCP tool', inputSchema: item.inputSchema || { type: 'object' }, source: `mcp:${id}`, permissionClass: 'READ', enabled: false, status: 'READY', serverId: id,
      })) : [];
      for (const tool of server.tools) this.tools.set(tool.id, tool);
      server.status = 'READY';
      this.emit('mcp:changed', this.mcpStatus());
      return this.mcpStatus();
    } catch (error) {
      server.status = 'FAILED'; server.error = error.message || String(error);
      server.rpc?.child.kill();
      this.emit('mcp:changed', this.mcpStatus());
      return this.mcpStatus();
    }
  }

  mcpStatus() { return [...this.servers.values()].map(server => ({ id: server.id, name: server.name, transport: server.transport, command: server.command, args: server.args, enabled: server.enabled, status: server.status, error: server.error, tools: server.tools.map(clone) })); }

  async executeMcp(tool, args) {
    const server = this.servers.get(tool.serverId);
    if (!server || server.status !== 'READY') throw new Error('MCP server belum READY.');
    const validation = validateArgs(tool.inputSchema, args);
    if (validation) throw new Error(validation);
    const result = await withTimeout(server.rpc.request('tools/call', { name: tool.remoteName || tool.name, arguments: args }), TOOL_TIMEOUT_MS, 'MCP tool timed out.');
    this.emit('tool:activity', { name: tool.name, source: tool.source, permissionClass: tool.permissionClass, arguments: args, result });
    return result;
  }

  async invoke(name, args = {}, options = {}) {
    const tool = this.findTool(name);
    if (!tool) throw new Error(`Tool tidak dikenal: ${name}`);
    if (!tool.enabled) throw new Error(`Tool '${name}' belum diaktifkan.`);
    if (tool.serverId) return this.executeMcp(tool, args);
    return this.execute(name, args, options);
  }

  async close() {
    for (const server of this.servers.values()) { try { server.rpc?.child.stdin.destroy(); server.rpc?.child.kill(); server.rpc?.child.unref(); } catch {} server.status = 'STOPPED'; }
    this.servers.clear();
  }
}

module.exports = { ToolRegistry, BUILTIN_TOOLS, MAX_TOOL_CALLS_PER_TURN, validateArgs };
