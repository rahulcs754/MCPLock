import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Drift, LockFile, LockServer, ServerEntry, Tool } from './types.js';

export const LOCK_NAME = 'mcp.lock';

/** JSON with object keys sorted, so the same data always gives the same hash. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export const sha256 = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

export const configHash = (s: ServerEntry) => sha256(canonical(s.config));

export function toolHash(t: Tool): string {
  const { name, title, description, inputSchema, outputSchema, annotations } = t;
  return sha256(canonical({ name, title, description, inputSchema, outputSchema, annotations }));
}

export function hashTools(tools: Tool[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of [...tools].sort((a, b) => (a.name < b.name ? -1 : 1))) out[t.name] = toolHash(t);
  return out;
}

export const emptyLock = (): LockFile => ({ lockfileVersion: 1, servers: {} });

export function parseLock(text: string, where = LOCK_NAME): LockFile {
  const data = JSON.parse(text) as Partial<LockFile>;
  if (data.lockfileVersion !== 1 || typeof data.servers !== 'object' || data.servers === null) {
    throw new Error(`${where} is not a valid MCPLock v1 lockfile`);
  }
  return data as LockFile;
}

export function readLock(path: string): LockFile | undefined {
  return existsSync(path) ? parseLock(readFileSync(path, 'utf8'), path) : undefined;
}

/** The lockfile as it is on another git ref (e.g. the PR base). Empty if missing there. */
export function readLockAtRef(ref: string, lockPath: string, cwd: string): LockFile {
  try {
    const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd, encoding: 'utf8' }).trim();
    const text = execFileSync('git', ['show', `${ref}:${prefix}${lockPath}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseLock(text, `${ref}:${lockPath}`);
  } catch (e) {
    if (e instanceof Error && e.message.includes('not a valid')) throw e;
    return emptyLock();
  }
}

export function serializeLock(lock: LockFile): string {
  const servers: Record<string, LockServer> = {};
  for (const id of Object.keys(lock.servers).sort()) {
    const s = lock.servers[id]!;
    servers[id] = { file: s.file, name: s.name, transport: s.transport, config: s.config, ...(s.tools ? { tools: s.tools } : {}) };
  }
  return `${JSON.stringify({ lockfileVersion: 1, servers }, null, 2)}\n`;
}

export function writeLock(path: string, lock: LockFile): void {
  writeFileSync(path, serializeLock(lock));
}

/**
 * Build a new lock from the current servers. Tool hashes come from `probed`,
 * or are kept from `previous` when the server config did not change.
 */
export function buildLock(servers: ServerEntry[], previous: LockFile | undefined, probed: Map<string, Record<string, string>>): LockFile {
  const lock = emptyLock();
  for (const s of servers) {
    const config = configHash(s);
    const prev = previous?.servers[s.id];
    const tools = probed.get(s.id) ?? (prev && prev.config === config ? prev.tools : undefined);
    lock.servers[s.id] = { file: s.file, name: s.name, transport: s.transport, config, ...(tools ? { tools } : {}) };
  }
  return lock;
}

export function diffTools(locked: Record<string, string>, now: Record<string, string>) {
  const added = Object.keys(now).filter((n) => !(n in locked));
  const removed = Object.keys(locked).filter((n) => !(n in now));
  const changed = Object.keys(now).filter((n) => n in locked && locked[n] !== now[n]);
  return { added, removed, changed };
}

/** Compare the servers in the repo (and probed tools) with a lockfile. */
export function compare(servers: ServerEntry[], lock: LockFile, probed: Map<string, Record<string, string>> = new Map()): Drift[] {
  const drift: Drift[] = [];
  const seen = new Set<string>();
  for (const s of servers) {
    seen.add(s.id);
    const locked = lock.servers[s.id];
    if (!locked) {
      drift.push({ kind: 'added', id: s.id, file: s.file, name: s.name, message: 'New server, not in mcp.lock.' });
      continue;
    }
    if (locked.config !== configHash(s)) {
      drift.push({ kind: 'config-changed', id: s.id, file: s.file, name: s.name, message: 'Server config changed since mcp.lock was written.' });
      continue;
    }
    const tools = probed.get(s.id);
    if (tools && locked.tools) {
      const d = diffTools(locked.tools, tools);
      if (d.added.length + d.removed.length + d.changed.length > 0) {
        drift.push({ kind: 'tools-changed', id: s.id, file: s.file, name: s.name, message: 'Server tools changed with no config change (possible rug pull).', tools: d });
      }
    }
  }
  for (const [id, l] of Object.entries(lock.servers)) {
    if (!seen.has(id)) drift.push({ kind: 'removed', id, file: l.file, name: l.name, message: 'Server is in mcp.lock but no longer in any config.' });
  }
  return drift;
}

/** What a PR changes in mcp.lock compared with the base branch (for reviewers). */
export function lockChanges(base: LockFile, head: LockFile): Drift[] {
  const out: Drift[] = [];
  for (const [id, h] of Object.entries(head.servers)) {
    const b = base.servers[id];
    if (!b) out.push({ kind: 'added', id, file: h.file, name: h.name, message: 'Added to mcp.lock.' });
    else if (b.config !== h.config) out.push({ kind: 'config-changed', id, file: h.file, name: h.name, message: 'Config changed in mcp.lock.' });
    else if (b.tools && h.tools) {
      const d = diffTools(b.tools, h.tools);
      if (d.added.length + d.removed.length + d.changed.length > 0) out.push({ kind: 'tools-changed', id, file: h.file, name: h.name, message: 'Tool list changed in mcp.lock.', tools: d });
    }
  }
  for (const [id, b] of Object.entries(base.servers)) {
    if (!head.servers[id]) out.push({ kind: 'removed', id, file: b.file, name: b.name, message: 'Removed from mcp.lock.' });
  }
  return out;
}
