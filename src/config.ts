import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from './jsonc.js';
import type { Finding, Severity } from './types.js';

export type FailOn = Severity | 'none';

export interface AllowEntry {
  rule: string;
  server?: string;
  file?: string;
  reason?: string;
}

export interface Config {
  /** Lowest finding severity that fails the check. */
  failOn: FailOn;
  /** Findings you reviewed and accept. */
  allow: AllowEntry[];
  /** Extra config files to scan (same shape as .mcp.json). */
  include: string[];
}

export const CONFIG_NAME = 'mcplock.json';
const LEVELS: FailOn[] = ['low', 'medium', 'high', 'none'];

export function loadConfig(root: string): Config {
  const cfg: Config = { failOn: 'high', allow: [], include: [] };
  const path = join(root, CONFIG_NAME);
  if (!existsSync(path)) return cfg;
  const raw = parseJsonc(readFileSync(path, 'utf8')) as Partial<Config>;
  if (raw.failOn !== undefined) cfg.failOn = parseFailOn(String(raw.failOn));
  if (Array.isArray(raw.allow)) cfg.allow = raw.allow.filter((a) => a && typeof a.rule === 'string');
  if (Array.isArray(raw.include)) cfg.include = raw.include.map(String);
  return cfg;
}

export function parseFailOn(v: string): FailOn {
  const l = v.toLowerCase() as FailOn;
  if (!LEVELS.includes(l)) throw new Error(`failOn must be one of ${LEVELS.join(', ')} (got "${v}")`);
  return l;
}

export function isAllowed(f: Finding, allow: AllowEntry[]): boolean {
  return allow.some((a) => a.rule === f.rule && (!a.server || a.server === f.server) && (!a.file || a.file === f.file));
}

export function failsAt(f: Finding, failOn: FailOn): boolean {
  if (failOn === 'none') return false;
  return LEVELS.indexOf(f.severity) >= LEVELS.indexOf(failOn);
}
