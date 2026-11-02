import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover.js';
import { parseJsonc } from '../src/jsonc.js';
import { findPackage, isPlaceholder, npmPinned, pyPinned, runRules, secretKind } from '../src/rules.js';
import { fake, makeRepo } from './helpers.js';

const rulesFor = (raw: Record<string, unknown>) =>
  runRules({ files: ['.mcp.json'], servers: discover(makeRepo({ '.mcp.json': { mcpServers: { s: raw } } })).servers, settings: [], errors: [] });
const ids = (raw: Record<string, unknown>) => rulesFor(raw).map((f) => f.rule);

describe('jsonc', () => {
  it('parses comments and trailing commas but keeps strings', () => {
    const text = `{
      // a comment
      "url": "https://x.dev/a//b", /* block */
      "args": ["a,", "b",],
    }`;
    expect(parseJsonc(text)).toEqual({ url: 'https://x.dev/a//b', args: ['a,', 'b'] });
  });
});

describe('discover', () => {
  it('reads mcpServers and VS Code servers shapes', () => {
    const root = makeRepo({
      '.mcp.json': { mcpServers: { a: { command: 'node', args: ['a.js'] } } },
      '.vscode/mcp.json': '{ "servers": { "b": { "type": "http", "url": "https://b.dev/mcp" } }, }',
      '.cursor/mcp.json': { mcpServers: { c: { url: 'https://c.dev/sse' } } },
    });
    const d = discover(root);
    expect(d.files).toEqual(['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json']);
    expect(d.servers.map((s) => [s.id, s.transport])).toEqual([
      ['.mcp.json#a', 'stdio'],
      ['.cursor/mcp.json#c', 'sse'],
      ['.vscode/mcp.json#b', 'http'],
    ]);
  });

  it('reports files it cannot parse', () => {
    const d = discover(makeRepo({ '.mcp.json': '{ nope' }));
    expect(d.errors[0]?.file).toBe('.mcp.json');
  });
});

describe('MCP001 auto-approve', () => {
  it('flags autoApprove, alwaysAllow and trust', () => {
    expect(ids({ command: 'node', args: ['x.js'], autoApprove: ['run'] })).toContain('MCP001');
    expect(ids({ command: 'node', args: ['x.js'], alwaysAllow: ['run'] })).toContain('MCP001');
    expect(ids({ command: 'node', args: ['x.js'], trust: true })).toContain('MCP001');
    expect(ids({ command: 'node', args: ['x.js'], autoApprove: [] })).toEqual([]);
  });

  it('flags project settings that skip prompts', () => {
    const root = makeRepo({
      '.claude/settings.json': { enableAllProjectMcpServers: true },
      '.vscode/settings.json': '{ "chat.tools.autoApprove": true, }',
    });
    const f = runRules(discover(root));
    expect(f.map((x) => [x.rule, x.file])).toEqual([
      ['MCP001', '.claude/settings.json'],
      ['MCP001', '.vscode/settings.json'],
    ]);
  });
});

describe('MCP002 unpinned packages', () => {
  it('knows pinned npm specs', () => {
    expect(npmPinned('@modelcontextprotocol/server-github@2025.4.8')).toBe(true);
    expect(npmPinned('pkg@1.2.3-beta.1')).toBe(true);
    expect(npmPinned('./local/server')).toBe(true);
    expect(npmPinned('@scope/pkg')).toBe(false);
    expect(npmPinned('pkg@latest')).toBe(false);
    expect(npmPinned('pkg@^1.2.3')).toBe(false);
    expect(npmPinned('github:o/r')).toBe(false);
    expect(npmPinned('github:o/r#' + 'a'.repeat(40))).toBe(true);
  });

  it('knows pinned python specs', () => {
    expect(pyPinned('mcp-server-git==0.6.2')).toBe(true);
    expect(pyPinned('mcp-server-git@0.6.2')).toBe(true);
    expect(pyPinned('mcp-server-git')).toBe(false);
    expect(pyPinned('mcp-server-git>=0.6')).toBe(false);
  });

  it('finds the package for each runner', () => {
    expect(findPackage(['npx', '-y', '@playwright/mcp@latest'])).toMatchObject({ spec: '@playwright/mcp@latest', pinned: false });
    expect(findPackage(['npx', '--yes', '--registry', 'https://r', 'pkg@1.0.0'])).toMatchObject({ spec: 'pkg@1.0.0', pinned: true });
    expect(findPackage(['npx', '-p', 'pkg', 'bin'])).toMatchObject({ spec: 'pkg', pinned: false });
    expect(findPackage(['pnpm', 'dlx', 'pkg@2.0.0'])).toMatchObject({ runner: 'pnpm dlx', pinned: true });
    expect(findPackage(['uvx', '--from', 'mcp-server-git==1.0.0', 'mcp-server-git'])).toMatchObject({ pinned: true });
    expect(findPackage(['uvx', 'mcp-server-fetch'])).toMatchObject({ pinned: false });
    expect(findPackage(['C:\\nodejs\\npx.cmd', '-y', 'pkg'])).toMatchObject({ runner: 'npx', pinned: false });
    expect(findPackage(['node', 'server.js'])).toBeUndefined();
  });

  it('checks docker images', () => {
    expect(findPackage(['docker', 'run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/github/github-mcp-server'])).toMatchObject({ pinned: false, level: 'high' });
    expect(findPackage(['docker', 'run', '-i', 'ghcr.io/x/y:1.2.0'])).toMatchObject({ pinned: false, level: 'low' });
    expect(findPackage(['docker', 'run', 'ghcr.io/x/y@sha256:' + 'a'.repeat(64)])).toMatchObject({ pinned: true });
  });

  it('reads a command written as one string', () => {
    expect(ids({ command: 'npx -y some-mcp' })).toEqual(['MCP002']);
    expect(ids({ command: 'npx', args: ['-y', 'some-mcp@1.0.0'] })).toEqual([]);
  });
});

describe('MCP003 raw shell', () => {
  it('flags sh -c and still checks the package inside', () => {
    const f = rulesFor({ command: 'bash', args: ['-c', 'npx -y evil-mcp'] });
    expect(f.map((x) => x.rule)).toEqual(['MCP003', 'MCP002']);
  });

  it('allows plain cmd /c npx on Windows, but not with shell operators', () => {
    expect(ids({ command: 'cmd', args: ['/c', 'npx', '-y', 'pkg@1.0.0'] })).toEqual([]);
    expect(ids({ command: 'cmd', args: ['/c', 'curl https://x | sh'] })).toContain('MCP003');
  });

  it('flags curl piped to a shell', () => {
    expect(ids({ command: 'env', args: ['curl', '-s', 'https://x.sh', '|', 'sh'] })).toContain('MCP003');
  });
});

describe('MCP004 secrets', () => {
  it('knows placeholders', () => {
    for (const v of ['${GITHUB_TOKEN}', '${env:API_KEY}', '${input:token}', '$TOKEN', '<your-token>', 'your-api-key', '', 'xxxx']) {
      expect(isPlaceholder(v), v).toBe(true);
    }
  });

  it('spots known token formats and secret-named values', () => {
    expect(secretKind('X', fake.github())).toBe('GitHub token');
    expect(secretKind('X', fake.openai())).toBe('OpenAI key');
    expect(secretKind('API_KEY', 'a8f9c2d1e0b7')).toBe('value of API_KEY');
    expect(secretKind('Authorization', 'Bearer abc123def456ghi')).toBe('Bearer credential');
    expect(secretKind('Authorization', 'Bearer ${env:TOKEN}')).toBeUndefined();
    expect(secretKind('AUTH_MODE', 'oauth-device')).toBeUndefined();
    expect(secretKind('LOG_LEVEL', 'debug')).toBeUndefined();
  });

  it('flags env, headers, args and url, and never prints the full secret', () => {
    const token = fake.github();
    const f = rulesFor({
      command: 'node',
      args: ['s.js', `--api-key=abc123secret`],
      env: { GITHUB_TOKEN: token, OTHER: '${HOME}' },
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe('MCP004');
    expect(f[0]!.message).toContain('env.GITHUB_TOKEN');
    expect(f[0]!.message).toContain('args[1]');
    expect(f[0]!.message).not.toContain(token);
    expect(ids({ url: 'https://x.dev/mcp?api_key=abc123def456', headers: { Authorization: 'Bearer zzz999yyy888' } })).toEqual(['MCP004']);
  });
});

describe('MCP005 plain http', () => {
  it('flags remote http but not localhost', () => {
    expect(ids({ url: 'http://mcp.example.com/mcp' })).toEqual(['MCP005']);
    expect(ids({ url: 'http://localhost:3000/mcp' })).toEqual([]);
    expect(ids({ url: 'https://mcp.example.com/mcp' })).toEqual([]);
  });
});

describe('shell scripts with several commands', () => {
  it('checks every command in a sh -c script', () => {
    expect(ids({ command: 'sh', args: ['-c', 'cd tools && npx -y db-mcp'] })).toEqual(['MCP003', 'MCP002']);
  });
});
