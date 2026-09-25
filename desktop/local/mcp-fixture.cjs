const readline = require('node:readline');
const tool = { name: 'echo_text', description: 'Echo text from a local MCP fixture.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'botconnector-fixture', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [tool] };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: String(request.params?.arguments?.text || '') }] };
  else result = {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
