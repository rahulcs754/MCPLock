import { spawn } from 'node:child_process';
import type { ServerEntry, Tool } from './types.js';
import { argv } from './rules.js';

export const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'mcplock', version: '0.1.0' };

interface RpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Expand ${VAR}, ${env:VAR} and $VAR from the environment. Unknown inputs stay empty. */
export function expand(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => env[n] ?? '')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_, n: string, _d, def: string | undefined) => env[n] ?? def ?? '')
    .replace(/^\$([A-Za-z_][A-Za-z0-9_]*)$/, (_, n: string) => env[n] ?? '');
}

function expandAll(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, expand(v)]));
}

/** Start a server, call initialize + tools/list, and return its tools. */
export async function probe(s: ServerEntry, timeoutMs = 60_000): Promise<Tool[]> {
  const unresolved = JSON.stringify(s.config).match(/\$\{input:[^}]+\}/);
  if (unresolved) throw new Error(`needs a VS Code input (${unresolved[0]}), which MCPLock cannot fill in`);
  if (s.transport === 'stdio') return probeStdio(s, timeoutMs);
  if (s.transport === 'http') return probeHttp(s, timeoutMs);
  throw new Error('legacy SSE transport is not supported for probing yet');
}

async function listAll(call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await call('tools/list', cursor ? { cursor } : {});
    tools.push(...((res.tools as Tool[] | undefined) ?? []));
    cursor = typeof res.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools;
}

function initParams() {
  return { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO };
}

function probeStdio(s: ServerEntry, timeoutMs: number): Promise<Tool[]> {
  const [cmd, ...args] = argv(s).map((a) => expand(a));
  if (!cmd) return Promise.reject(new Error('no command'));
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...expandAll(s.env) },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: typeof s.config.cwd === 'string' ? s.config.cwd : undefined,
    });
    let buf = '';
    let stderr = '';
    let nextId = 1;
    const pending = new Map<number, { ok: (r: Record<string, unknown>) => void; fail: (e: Error) => void }>();
    let done = false;

    const finish = (err?: Error, tools?: Tool[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (err) reject(err);
      else resolve(tools ?? []);
    };
    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);

    child.on('error', (e) => finish(new Error(`could not start: ${e.message}`)));
    child.on('exit', (code) => finish(new Error(`exited early (code ${code})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`)));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: RpcResponse;
        try {
          msg = JSON.parse(line) as RpcResponse;
        } catch {
          continue; // servers sometimes log to stdout
        }
        const p = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
        if (!p) continue;
        pending.delete(msg.id as number);
        if (msg.error) p.fail(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.ok(msg.result ?? {});
      }
    });

    const send = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((ok, fail) => {
        const id = nextId++;
        pending.set(id, { ok, fail });
        send({ jsonrpc: '2.0', id, method, params });
      });

    (async () => {
      const init = await call('initialize', initParams());
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const caps = (init.capabilities ?? {}) as Record<string, unknown>;
      return caps.tools ? listAll(call) : [];
    })().then(
      (tools) => finish(undefined, tools),
      (e: Error) => finish(e),
    );
  });
}

async function probeHttp(s: ServerEntry, timeoutMs: number): Promise<Tool[]> {
  const url = expand(s.url!);
  const headers = expandAll(s.headers);
  let session: string | undefined;
  let nextId = 1;
  const deadline = AbortSignal.timeout(timeoutMs);

  const post = async (body: Record<string, unknown>): Promise<RpcResponse | undefined> => {
    const res = await fetch(url, {
      method: 'POST',
      signal: deadline,
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
        ...(body.method !== 'initialize' ? { 'mcp-protocol-version': PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify(body),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${String(body.method)}`);
    if (body.id === undefined) return undefined;
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (type.includes('text/event-stream')) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as RpcResponse;
          if (msg.id === body.id) return msg;
        } catch {
          /* skip */
        }
      }
      throw new Error(`no response to ${String(body.method)} in event stream`);
    }
    return JSON.parse(text) as RpcResponse;
  };

  const call = async (method: string, params: Record<string, unknown>) => {
    const msg = await post({ jsonrpc: '2.0', id: nextId++, method, params });
    if (msg?.error) throw new Error(`${msg.error.message} (${msg.error.code})`);
    return msg?.result ?? {};
  };

  const init = await call('initialize', initParams());
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const caps = (init.capabilities ?? {}) as Record<string, unknown>;
  return caps.tools ? listAll(call) : [];
}
