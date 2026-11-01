import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from './jsonc.js';
import type { ServerEntry, Transport } from './types.js';

/** Repo-level files that hold MCP server definitions. */
export const SERVER_FILES = [
  '.mcp.json', // Claude Code
  '.cursor/mcp.json', // Cursor
  '.vscode/mcp.json', // VS Code / Copilot
  '.gemini/settings.json', // Gemini CLI
  '.roo/mcp.json', // Roo Code
  '.kiro/settings/mcp.json', // Kiro
  '.amazonq/mcp.json', // Amazon Q
];

/** Repo-level settings files that can switch on auto-approve. */
export const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.vscode/settings.json'];

export interface Discovered {
  files: string[];
  servers: ServerEntry[];
  settings: Array<{ file: string; data: Record<string, unknown> }>;
  errors: Array<{ file: string; message: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function strRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, val] of Object.entries(v)) if (val != null) out[k] = String(val);
  return out;
}

export function toServer(file: string, name: string, raw: Record<string, unknown>): ServerEntry {
  const url = [raw.url, raw.httpUrl, raw.serverUrl].find((u): u is string => typeof u === 'string');
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  let transport: Transport = 'stdio';
  if (url && typeof raw.command !== 'string') transport = type === 'sse' || (!type && /\/sse\/?$/.test(url)) ? 'sse' : 'http';
  return {
    id: `${file}#${name}`,
    file,
    name,
    transport,
    config: raw,
    command: typeof raw.command === 'string' ? raw.command : undefined,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: strRecord(raw.env),
    url,
    headers: strRecord(raw.headers),
  };
}

/** Read every known MCP config file under `root` (plus any extra paths). */
export function discover(root: string, extra: string[] = []): Discovered {
  const result: Discovered = { files: [], servers: [], settings: [], errors: [] };
  const serverFiles = [...new Set([...SERVER_FILES, ...extra])];
  const all = [...new Set([...serverFiles, ...SETTINGS_FILES])];

  for (const file of all) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let data: unknown;
    try {
      data = parseJsonc(readFileSync(path, 'utf8'));
    } catch (e) {
      result.errors.push({ file, message: `Could not parse JSON: ${(e as Error).message}` });
      continue;
    }
    if (!isObj(data)) {
      result.errors.push({ file, message: 'Top level is not a JSON object' });
      continue;
    }
    result.files.push(file);
    if (SETTINGS_FILES.includes(file) || file === '.gemini/settings.json') result.settings.push({ file, data });
    if (!serverFiles.includes(file)) continue;
    const block = isObj(data.mcpServers) ? data.mcpServers : isObj(data.servers) ? data.servers : undefined;
    if (!block) continue;
    for (const [name, raw] of Object.entries(block)) {
      if (isObj(raw)) result.servers.push(toServer(file, name, raw));
    }
  }
  return result;
}
