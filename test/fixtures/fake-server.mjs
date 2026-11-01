// A tiny stdio MCP server for tests. Tools come from FAKE_TOOLS (JSON) or a default list.
import { createInterface } from 'node:readline';

const tools = process.env.FAKE_TOOLS
  ? JSON.parse(process.env.FAKE_TOOLS)
  : [
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'list_dir', description: 'List a folder', inputSchema: { type: 'object' } },
    ];
const pageSize = Number(process.env.FAKE_PAGE_SIZE ?? 0);

console.log('fake server starting (not JSON, should be ignored)');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    if (!pageSize) return send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    const start = Number(msg.params?.cursor ?? 0);
    const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.slice(start, start + pageSize), nextCursor: next } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
