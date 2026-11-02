import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseFailOn } from './config.js';
import { prContext, upsertComment } from './github.js';
import { toMarkdown, toText } from './report.js';
import { check, lock, scan, type RunOptions } from './run.js';

const HELP = `mcplock - lockfile and PR check for MCP server configs

Usage:
  mcplock scan               Flag risky settings in .mcp.json, .cursor/mcp.json, .vscode/mcp.json, ...
  mcplock lock [--probe]     Write mcp.lock (config hashes; --probe also starts each server and hashes its tools)
  mcplock check [--probe]    Fail if configs are risky or do not match mcp.lock

Options:
  --root <dir>         Repo folder (default: current folder)
  --probe              Start servers and lock/compare their tool lists
  --base <ref>         (check) Git ref of the PR base: list mcp.lock changes for review,
                       and only probe servers already approved there
  --fail-on <level>    high | medium | low | none (default: high, or mcplock.json)
  --comment            (check) Post or update one PR comment (needs GITHUB_TOKEN)
  --timeout <sec>      Probe timeout per server (default 60)
  --json               Print the report as JSON
  -h, --help           Show this help
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      probe: { type: 'boolean' },
      base: { type: 'string' },
      'fail-on': { type: 'string' },
      comment: { type: 'boolean' },
      timeout: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0] ?? 'check';
  if (values.help || !['scan', 'lock', 'check'].includes(cmd)) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }

  const opts: RunOptions = {
    root: resolve(values.root ?? '.'),
    probe: values.probe,
    base: values.base || undefined,
    failOn: values['fail-on'] ? parseFailOn(values['fail-on']) : undefined,
    timeoutMs: values.timeout ? Number(values.timeout) * 1000 : 60_000,
    log: (m) => process.stderr.write(`${m}\n`),
  };

  if (cmd === 'lock') {
    const { report, lock: next, changes } = await lock(opts);
    process.stdout.write(values.json ? `${JSON.stringify({ report, lock: next, changes }, null, 2)}\n` : toText(report));
    const n = Object.keys(next.servers).length;
    process.stdout.write(`\nWrote mcp.lock: ${n} server${n === 1 ? '' : 's'}, ${changes.length} change${changes.length === 1 ? '' : 's'}.\n`);
    for (const c of changes) process.stdout.write(`  ${c.kind.padEnd(14)} ${c.id}\n`);
    if (report.failing.length) process.stdout.write('\nNote: risky settings above will still fail `mcplock check`.\n');
    return 0;
  }

  const report = cmd === 'scan' ? scan(opts) : await check(opts);
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : toText(report));

  const md = toMarkdown(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (values.comment) {
    const pr = prContext();
    const token = process.env.GITHUB_TOKEN;
    if (!pr) process.stderr.write('--comment: not a pull_request event, skipping comment\n');
    else if (!token) process.stderr.write('--comment: GITHUB_TOKEN is not set, skipping comment\n');
    else if (report.files.length > 0 || report.failed) {
      try {
        const how = await upsertComment(token, pr, md);
        process.stderr.write(`PR comment ${how}\n`);
      } catch (e) {
        process.stderr.write(`::warning::Could not post PR comment: ${(e as Error).message}\n`);
      }
    }
  }
  return report.failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`mcplock: ${e.message}\n`);
    process.exit(2);
  },
);
