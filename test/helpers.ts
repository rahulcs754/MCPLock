import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toServer } from '../src/discover.js';
import type { ServerEntry } from '../src/types.js';

export const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-server.mjs');

/** Make a temp repo folder with the given files (path -> JSON value or text). */
export function makeRepo(files: Record<string, unknown>, git = false): string {
  const root = mkdtempSync(join(tmpdir(), 'mcplock-'));
  writeFiles(root, files);
  if (git) {
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'test');
    g('config', 'commit.gpgsign', 'false');
    g('add', '-A');
    g('commit', '-qm', 'base');
  }
  return root;
}

export function writeFiles(root: string, files: Record<string, unknown>): void {
  for (const [p, v] of Object.entries(files)) {
    const full = join(root, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
}

export function server(raw: Record<string, unknown>, name = 's', file = '.mcp.json'): ServerEntry {
  return toServer(file, name, raw);
}

/** Build fake secrets at runtime so no secret-looking string is committed. */
export const fake = {
  github: () => 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  openai: () => 's' + 'k-proj-' + 'x'.repeat(10) + 'Abc123'.repeat(6),
};
