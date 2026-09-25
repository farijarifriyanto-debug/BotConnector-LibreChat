const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry, MAX_TOOL_CALLS_PER_TURN, validateArgs } = require('./tools.cjs');

test('schema validation rejects missing, wrong, and unknown arguments', () => {
  const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
  assert.match(validateArgs(schema, {}), /wajib/);
  assert.match(validateArgs(schema, { text: 2 }), /bertipe/);
  assert.match(validateArgs(schema, { text: 'ok', extra: true }), /tidak dikenal/);
  assert.equal(validateArgs(schema, { text: 'ok' }), null);
});

test('disabled and unknown tools are rejected', async () => {
  const registry = new ToolRegistry();
  await assert.rejects(() => registry.invoke('echo_text', { text: 'x' }), /belum diaktifkan/);
  await assert.rejects(() => registry.invoke('missing', {}), /tidak dikenal/);
});

test('READ tool executes after explicit enablement', async () => {
  const registry = new ToolRegistry();
  await registry.setEnabled('echo_text', true);
  assert.deepEqual(await registry.invoke('echo_text', { text: 'hello' }), { text: 'hello' });
});

test('WRITE and EXECUTE tools require an approval gate', async () => {
  const registry = new ToolRegistry();
  registry.tools.set('write_fixture', { id: 'write_fixture', name: 'write_fixture', description: '', inputSchema: { type: 'object' }, permissionClass: 'WRITE', source: 'test', enabled: true, status: 'READY', executor: () => ({ ok: true }) });
  await assert.rejects(() => registry.invoke('write_fixture', {}), /persetujuan eksplisit/);
  assert.deepEqual(await registry.invoke('write_fixture', {}, { approved: true }), { ok: true });
});

test('bounded timeout and tool loop constant are enforced', async () => {
  const registry = new ToolRegistry();
  registry.tools.set('slow_fixture', { id: 'slow_fixture', name: 'slow_fixture', description: '', inputSchema: { type: 'object' }, permissionClass: 'READ', source: 'test', enabled: true, status: 'READY', executor: () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 11_000)) });
  await assert.rejects(() => registry.invoke('slow_fixture', {}), /timed out/);
  assert.ok(MAX_TOOL_CALLS_PER_TURN <= 4);
});

test('MCP fixture discovery, allowlist, invocation, and shutdown are isolated', async () => {
  const registry = new ToolRegistry();
  const servers = await registry.registerMcp({ id: 'fixture-test' });
  assert.equal(servers[0].status, 'READY');
  const discovered = registry.list().find(tool => tool.source === 'mcp:fixture-test');
  assert.ok(discovered);
  await assert.rejects(() => registry.invoke(discovered.name, { text: 'x' }), /belum diaktifkan/);
  await registry.setEnabled(discovered.id, true);
  const result = await registry.invoke(discovered.name, { text: 'x' });
  assert.deepEqual(result.content[0], { type: 'text', text: 'x' });
  await registry.close();
  assert.equal(registry.mcpStatus().length, 0);
});

test('bad MCP start reports FAILED without affecting registry', async () => {
  const registry = new ToolRegistry();
  const servers = await registry.registerMcp({ id: 'bad-test', command: 'definitely-missing-botconnector-mcp' });
  assert.equal(servers[0].status, 'FAILED');
  assert.equal(registry.list().some(tool => tool.serverId === 'bad-test'), false);
  await registry.close();
});
