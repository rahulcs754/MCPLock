import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expand, probe } from '../src/probe.js';
import { FAKE_SERVER, server } from './helpers.js';

describe('expand', () => {
  it('fills ${VAR}, ${env:VAR}, defaults and $VAR', () => {
    const env = { A: '1', B: '2' };
    expect(expand('x-${A}-${env:B}-${C:-3}', env)).toBe('x-1-2-3');
    expect(expand('$A', env)).toBe('1');
  });
});

describe('stdio probe', () => {
  it('lists tools from a stdio server and ignores non-JSON stdout', async () => {
    const tools = await probe(server({ command: process.execPath, args: [FAKE_SERVER] }));
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'list_dir']);
  });

  it('follows pagination', async () => {
    const list = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}` }));
    const tools = await probe(server({ command: process.execPath, args: [FAKE_SERVER], env: { FAKE_TOOLS: JSON.stringify(list), FAKE_PAGE_SIZE: '2' } }));
    expect(tools.map((t) => t.name)).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('fails clearly when the command does not exist or exits', async () => {
    await expect(probe(server({ command: 'mcplock-no-such-binary' }))).rejects.toThrow(/could not start/);
    await expect(probe(server({ command: process.execPath, args: ['-e', 'process.exit(3)'] }))).rejects.toThrow(/exited early \(code 3\)/);
  });

  it('refuses configs that need VS Code inputs', async () => {
    await expect(probe(server({ command: 'x', env: { T: '${input:token}' } }))).rejects.toThrow(/VS Code input/);
  });
});

describe('http probe', () => {
  let http: Server;
  let url: string;
  const seen: Array<{ method: string; session?: string; auth?: string }> = [];

  beforeAll(async () => {
    http = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number; method: string };
        seen.push({ method: msg.method, session: req.headers['mcp-session-id'] as string | undefined, auth: req.headers.authorization });
        if (msg.id === undefined) return res.writeHead(202).end();
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { tools: {} } } }));
        }
        // answer tools/list as an event stream
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search' }] } })}\n\n`);
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => http.close());

  it('lists tools over streamable HTTP with session id and headers', async () => {
    process.env.MCPLOCK_TEST_TOKEN = 'abc';
    const tools = await probe(server({ type: 'http', url, headers: { Authorization: 'Bearer ${MCPLOCK_TEST_TOKEN}' } }));
    expect(tools.map((t) => t.name)).toEqual(['search']);
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(seen[2]).toMatchObject({ session: 'sess-1', auth: 'Bearer abc' });
  });
});
