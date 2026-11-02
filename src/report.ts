import { RULES } from './rules.js';
import type { Drift, Finding, ProbeNote } from './types.js';

export const MARKER = '<!-- mcplock-report -->';

export interface Report {
  files: string[];
  serverCount: number;
  findings: Finding[];
  allowed: Finding[];
  failing: Finding[];
  /** Repo configs vs mcp.lock. Undefined for `scan`. */
  drift?: Drift[];
  lockMissing?: boolean;
  /** mcp.lock in this PR vs the base branch. */
  baseChanges?: Drift[];
  baseRef?: string;
  probes: ProbeNote[];
  errors: Array<{ file: string; message: string }>;
  failed: boolean;
}

const ICON = { high: '🔴', medium: '🟠', low: '🟡' } as const;
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function where(f: { file: string; server?: string; name?: string }): string {
  const s = f.server ?? f.name;
  return s ? `\`${f.file}\` → \`${s}\`` : `\`${f.file}\``;
}

function toolDetail(d: Drift): string {
  if (!d.tools) return '';
  const parts: string[] = [];
  if (d.tools.added.length) parts.push(`added: ${d.tools.added.map((t) => `\`${t}\``).join(', ')}`);
  if (d.tools.removed.length) parts.push(`removed: ${d.tools.removed.map((t) => `\`${t}\``).join(', ')}`);
  if (d.tools.changed.length) parts.push(`changed: ${d.tools.changed.map((t) => `\`${t}\``).join(', ')}`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

export function headline(r: Report): string {
  const problems = r.failing.length + (r.drift?.length ?? 0) + (r.lockMissing ? 1 : 0) + r.errors.length;
  if (r.failed) return `❌ MCPLock: ${problems} problem${problems === 1 ? '' : 's'} in MCP configs`;
  if (r.files.length === 0) return '✅ MCPLock: no MCP config files found';
  return '✅ MCPLock: MCP configs look safe and match mcp.lock';
}

export function toMarkdown(r: Report): string {
  const out: string[] = [MARKER, `### ${headline(r)}`];
  out.push(`Scanned ${r.files.length} file${r.files.length === 1 ? '' : 's'} and ${r.serverCount} server${r.serverCount === 1 ? '' : 's'}${r.files.length ? `: ${r.files.map((f) => `\`${f}\``).join(', ')}` : ''}.`);

  if (r.errors.length) {
    out.push('', '**Could not read**');
    for (const e of r.errors) out.push(`- \`${e.file}\`: ${e.message}`);
  }

  if (r.findings.length) {
    out.push('', '**Risky settings**', '', '| | Rule | Where | Problem | Fix |', '|---|---|---|---|---|');
    for (const f of r.findings) {
      out.push(`| ${ICON[f.severity]} | ${f.rule} ${RULES[f.rule as keyof typeof RULES] ?? ''} | ${where(f)} | ${esc(f.message)} | ${esc(f.fix)} |`);
    }
  }
  if (r.allowed.length) {
    out.push('', `<details><summary>${r.allowed.length} finding(s) allowed in mcplock.json</summary>`, '');
    for (const f of r.allowed) out.push(`- ${f.rule} ${where(f)}: ${f.message}`);
    out.push('', '</details>');
  }

  if (r.lockMissing) {
    out.push('', '**No mcp.lock yet.** Run `npx mcplock lock` (add `--probe` to also lock tool lists) and commit `mcp.lock`.');
  } else if (r.drift?.length) {
    out.push('', '**Out of sync with mcp.lock**');
    for (const d of r.drift) out.push(`- ${where(d)}: ${d.message}${toolDetail(d)}`);
    out.push('', 'If these changes are expected, run `npx mcplock lock --probe` and commit `mcp.lock` so a reviewer can approve them.');
  }

  if (r.baseChanges?.length) {
    out.push('', `**This PR changes mcp.lock** (vs \`${r.baseRef}\`). Please review each server before merging:`);
    for (const d of r.baseChanges) out.push(`- ${where(d)}: ${d.message}${toolDetail(d)}`);
  }

  if (r.probes.length) {
    out.push('', '<details><summary>Tool probe</summary>', '');
    for (const p of r.probes) out.push(`- ${p.status === 'ok' ? '✅' : p.status === 'skipped' ? '⏭️' : '⚠️'} \`${p.id}\`: ${p.message}`);
    out.push('', '</details>');
  }

  out.push('', '<sub>[MCPLock](https://github.com/rahulcs754/mcplock) · lockfile and PR check for MCP server configs</sub>');
  return `${out.join('\n')}\n`;
}

export function toText(r: Report): string {
  const out: string[] = [headline(r).replace(/^[✅❌] /u, ''), `Files: ${r.files.join(', ') || 'none'} (${r.serverCount} servers)`];
  for (const e of r.errors) out.push(`  ERROR ${e.file}: ${e.message}`);
  for (const f of r.findings) {
    out.push(`  ${f.severity.toUpperCase().padEnd(6)} ${f.rule} ${f.file}${f.server ? ` > ${f.server}` : ''}: ${f.message}`, `         fix: ${f.fix}`);
  }
  for (const f of r.allowed) out.push(`  allowed ${f.rule} ${f.file}${f.server ? ` > ${f.server}` : ''}`);
  if (r.lockMissing) out.push('  LOCK   no mcp.lock yet: run `mcplock lock` and commit it');
  for (const d of r.drift ?? []) out.push(`  DRIFT  ${d.id}: ${d.message}${toolDetail(d).replace(/`/g, '')}`);
  for (const d of r.baseChanges ?? []) out.push(`  REVIEW ${d.id}: ${d.message}${toolDetail(d).replace(/`/g, '')}`);
  for (const p of r.probes) out.push(`  probe  ${p.status.padEnd(7)} ${p.id}: ${p.message}`);
  return `${out.join('\n')}\n`;
}
