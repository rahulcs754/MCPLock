import { join } from 'node:path';
import { failsAt, isAllowed, loadConfig, type FailOn } from './config.js';
import { discover } from './discover.js';
import { buildLock, compare, configHash, emptyLock, hashTools, LOCK_NAME, lockChanges, readLock, readLockAtRef, writeLock } from './lock.js';
import { probe } from './probe.js';
import type { Report } from './report.js';
import { runRules } from './rules.js';
import type { LockFile, ProbeNote, ServerEntry } from './types.js';

export interface RunOptions {
  root: string;
  probe?: boolean;
  base?: string;
  failOn?: FailOn;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

function scanAll(opts: RunOptions) {
  const cfg = loadConfig(opts.root);
  const failOn = opts.failOn ?? cfg.failOn;
  const d = discover(opts.root, cfg.include);
  const all = runRules(d);
  const allowed = all.filter((f) => isAllowed(f, cfg.allow));
  const findings = all.filter((f) => !isAllowed(f, cfg.allow));
  const failing = findings.filter((f) => failsAt(f, failOn));
  return { d, findings, allowed, failing };
}

async function probeServers(servers: ServerEntry[], trusted: LockFile | undefined, opts: RunOptions) {
  const probed = new Map<string, Record<string, string>>();
  const notes: ProbeNote[] = [];
  for (const s of servers) {
    if (trusted && trusted.servers[s.id]?.config !== configHash(s)) {
      notes.push({ id: s.id, status: 'skipped', message: 'not started: this config is not approved in the trusted mcp.lock yet' });
      continue;
    }
    opts.log?.(`probing ${s.id} …`);
    try {
      const tools = await probe(s, opts.timeoutMs);
      probed.set(s.id, hashTools(tools));
      notes.push({ id: s.id, status: 'ok', message: `${tools.length} tool${tools.length === 1 ? '' : 's'}` });
    } catch (e) {
      notes.push({ id: s.id, status: 'error', message: (e as Error).message });
    }
  }
  return { probed, notes };
}

/** `mcplock scan`: risky settings only. */
export function scan(opts: RunOptions): Report {
  const { d, findings, allowed, failing } = scanAll(opts);
  return { files: d.files, serverCount: d.servers.length, findings, allowed, failing, probes: [], errors: d.errors, failed: failing.length > 0 || d.errors.length > 0 };
}

/** `mcplock check`: risky settings + drift against mcp.lock (+ base branch review list). */
export async function check(opts: RunOptions): Promise<Report> {
  const { d, findings, allowed, failing } = scanAll(opts);
  const lockPath = join(opts.root, LOCK_NAME);
  const lock = readLock(lockPath);
  const lockMissing = !lock && d.servers.length > 0;
  const baseLock = opts.base ? readLockAtRef(opts.base, LOCK_NAME, opts.root) : undefined;

  let probes: ProbeNote[] = [];
  let probed = new Map<string, Record<string, string>>();
  if (opts.probe && lock) {
    // Only start servers that were already approved: on the base branch in a PR,
    // so a PR can never make CI run a command nobody reviewed.
    ({ probed, notes: probes } = await probeServers(d.servers, baseLock ?? lock, opts));
  }

  const drift = lock ? compare(d.servers, lock, probed) : [];
  for (const [id, tools] of probed) {
    if (!lock?.servers[id]?.tools) {
      const n = probes.find((p) => p.id === id);
      if (n) n.message += ` (not in mcp.lock yet: run \`mcplock lock --probe\` to lock ${Object.keys(tools).length} tool hashes)`;
    }
  }
  const baseChanges = baseLock ? lockChanges(baseLock, lock ?? emptyLock()) : undefined;

  return {
    files: d.files,
    serverCount: d.servers.length,
    findings,
    allowed,
    failing,
    drift,
    lockMissing,
    baseChanges,
    baseRef: opts.base,
    probes,
    errors: d.errors,
    failed: failing.length > 0 || drift.length > 0 || lockMissing || d.errors.length > 0,
  };
}

/** `mcplock lock`: write mcp.lock from the current configs. */
export async function lock(opts: RunOptions): Promise<{ report: Report; lock: LockFile; changes: ReturnType<typeof lockChanges> }> {
  const report = scan(opts);
  const d = discover(opts.root, loadConfig(opts.root).include);
  const lockPath = join(opts.root, LOCK_NAME);
  const previous = readLock(lockPath);
  let probed = new Map<string, Record<string, string>>();
  if (opts.probe) {
    const r = await probeServers(d.servers, undefined, opts);
    probed = r.probed;
    report.probes = r.notes;
  }
  const next = buildLock(d.servers, previous, probed);
  writeLock(lockPath, next);
  return { report, lock: next, changes: lockChanges(previous ?? emptyLock(), next) };
}
