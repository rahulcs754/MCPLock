import type { Discovered } from './discover.js';
import type { Finding, ServerEntry } from './types.js';

export const RULES = {
  MCP001: 'Auto-approve is on',
  MCP002: 'Unpinned package',
  MCP003: 'Raw shell command',
  MCP004: 'Secret in config',
  MCP005: 'Remote server over plain http',
} as const;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const SHELL_OPS = /(\|\s*(ba|z|da)?sh\b|&&|\|\||;|\$\(|`|>\s*\S|\b(curl|wget|iwr|Invoke-WebRequest|Invoke-Expression|iex)\b)/i;

/** Split a command string into tokens, honouring simple quotes. */
export function splitWords(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

const base = (cmd: string) => cmd.replace(/\\/g, '/').split('/').pop()!.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();

/** The full argv of a stdio server: command (possibly with spaces) + args. */
export function argv(s: ServerEntry): string[] {
  if (!s.command) return [];
  const head = s.args.length === 0 && /\s/.test(s.command.trim()) ? splitWords(s.command) : [s.command];
  return [...head, ...s.args];
}

// ---------- MCP002: unpinned packages ----------

const SEMVER = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/i;

/** Is an npm package spec pinned to one exact version? */
export function npmPinned(spec: string): boolean {
  if (/^(\.|\/|~|file:|[A-Za-z]:\\)/.test(spec)) return true; // local path
  if (/^(git\+|github:|gitlab:|bitbucket:|https?:|git:)/.test(spec) || /^[\w-]+\/[\w.-]+(#.*)?$/.test(spec)) {
    const ref = spec.split('#')[1];
    return !!ref && SHA.test(ref);
  }
  const at = spec.lastIndexOf('@');
  if (at <= 0) return false;
  return SEMVER.test(spec.slice(at + 1));
}

/** Is a Python package spec pinned (pkg==1.2.3 or pkg@1.2.3)? */
export function pyPinned(spec: string): boolean {
  if (/^(\.|\/|~|file:)/.test(spec)) return true;
  if (/^git\+/.test(spec)) return SHA.test(spec.split('@').pop() ?? '');
  const m = spec.match(/(===?|@)\s*([^,;\s]+)$/);
  return !!m && /^\d+(\.\d+)*([a-z]+\d*)?$/i.test(m[2]!) && !/[<>~!*,]/.test(spec);
}

interface Pkg {
  runner: string;
  spec: string;
  pinned: boolean;
  level?: 'high' | 'low';
}

/** Flags that take a value, per runner, so we skip the value when looking for the package. */
const NPX_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig', '-w', '--workspace']);
const DOCKER_VALUE_FLAGS = new Set([
  '-e', '--env', '--env-file', '-v', '--volume', '--mount', '-p', '--publish', '--name', '--network', '--net', '-w', '--workdir',
  '-u', '--user', '-l', '--label', '--entrypoint', '--platform', '--add-host', '--cpus', '-m', '--memory', '--pull', '--restart',
  '--hostname', '-h', '--cap-add', '--cap-drop', '--security-opt', '--device', '--ulimit', '--log-driver', '--tmpfs', '--gpus',
]);

function firstPositional(tokens: string[], valueFlags: Set<string>): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--') return tokens[i + 1];
    if (t.startsWith('-')) {
      if (!t.includes('=') && valueFlags.has(t)) i++;
      continue;
    }
    return t;
  }
  return undefined;
}

function flagValue(tokens: string[], names: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    for (const n of names) {
      if (t === n) return tokens[i + 1];
      if (t.startsWith(`${n}=`)) return t.slice(n.length + 1);
    }
  }
  return undefined;
}

/** Find the package a stdio server downloads and runs, if any. */
export function findPackage(tokens: string[]): Pkg | undefined {
  if (tokens.length === 0) return undefined;
  const cmd = base(tokens[0]!);
  const rest = tokens.slice(1);

  if (cmd === 'npx' || cmd === 'bunx') {
    const spec = flagValue(rest, ['-p', '--package']) ?? firstPositional(rest, NPX_VALUE_FLAGS);
    return spec ? { runner: cmd, spec, pinned: npmPinned(spec) } : undefined;
  }
  if ((cmd === 'npm' && (rest[0] === 'exec' || rest[0] === 'x')) || ((cmd === 'pnpm' || cmd === 'yarn') && rest[0] === 'dlx') || (cmd === 'bun' && rest[0] === 'x')) {
    const sub = rest.slice(1);
    const spec = flagValue(sub, ['-p', '--package']) ?? firstPositional(sub, NPX_VALUE_FLAGS);
    return spec ? { runner: `${cmd} ${rest[0]}`, spec, pinned: npmPinned(spec) } : undefined;
  }
  if (cmd === 'uvx' || (cmd === 'uv' && rest[0] === 'tool' && rest[1] === 'run')) {
    const sub = cmd === 'uvx' ? rest : rest.slice(2);
    const spec = flagValue(sub, ['--from']) ?? firstPositional(sub, new Set(['--with', '--python', '-p', '--index-url', '--index']));
    return spec ? { runner: cmd === 'uvx' ? 'uvx' : 'uv tool run', spec, pinned: pyPinned(spec) } : undefined;
  }
  if (cmd === 'pipx' && rest[0] === 'run') {
    const sub = rest.slice(1);
    const spec = flagValue(sub, ['--spec']) ?? firstPositional(sub, new Set(['--python', '--index-url', '--pip-args']));
    return spec ? { runner: 'pipx run', spec, pinned: pyPinned(spec) } : undefined;
  }
  if ((cmd === 'docker' || cmd === 'podman') && rest[0] === 'run') {
    const image = firstPositional(rest.slice(1), DOCKER_VALUE_FLAGS);
    if (!image) return undefined;
    if (/@sha256:[0-9a-f]{64}$/i.test(image)) return { runner: cmd, spec: image, pinned: true };
    const tag = image.includes(':') && !image.endsWith(':') ? image.slice(image.lastIndexOf(':') + 1) : '';
    const hasTag = !!tag && !tag.includes('/') && tag !== 'latest';
    return { runner: cmd, spec: image, pinned: false, level: hasTag ? 'low' : 'high' };
  }
  return undefined;
}

// ---------- MCP004: secrets ----------

const TOKEN_PATTERNS: Array<[string, RegExp]> = [
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{30,}/],
  ['OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{40,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Stripe live key', /\b(sk|rk)_live_[A-Za-z0-9]{24,}/],
  ['Razorpay live key', /\brzp_live_[A-Za-z0-9]{14,}/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['Private key', /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/],
];
const SECRET_NAME = /(token|secret|passw(or)?d|passwd|api[-_]?key|access[-_]?key|private[-_]?key|auth|credential|cookie|session)/i;
const DUMMY = /^(x+|\*+|\.+|<.*>|\[.*\]|your[-_ ].*|changeme|change-me|todo|tbd|placeholder|example|none|null|false|true|redacted)$/i;

/** True for values that point to a variable instead of holding a secret. */
export function isPlaceholder(v: string): boolean {
  const s = v.trim();
  return s === '' || /\$\{[^}]+\}/.test(s) || /^\$[A-Z_][A-Z0-9_]*$/i.test(s) || /\{\{.*\}\}/.test(s) || /^%[A-Z_][A-Z0-9_]*%$/i.test(s) || DUMMY.test(s);
}

export function mask(v: string): string {
  return v.length <= 8 ? '***' : `${v.slice(0, 4)}…${'*'.repeat(4)}`;
}

/** Return what kind of secret `value` looks like, or undefined. */
export function secretKind(key: string, value: string): string | undefined {
  for (const [label, re] of TOKEN_PATTERNS) if (re.test(value)) return label;
  if (isPlaceholder(value)) return undefined;
  let v = value.trim();
  const bearer = v.match(/^(Bearer|Basic|token)\s+(.+)$/i);
  if (bearer) {
    v = bearer[2]!.trim();
    if (isPlaceholder(v)) return undefined;
    if (v.length >= 8) return `${bearer[1]} credential`;
  }
  const randomLooking = (/\d/.test(v) && /[A-Za-z]/.test(v)) || v.length >= 24;
  if (SECRET_NAME.test(key) && v.length >= 8 && randomLooking && !/\s/.test(v) && !/^https?:\/\//.test(v)) return `value of ${key}`;
  return undefined;
}

// ---------- MCP005: http ----------

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[\w.-]+\.localhost)$/i;

function plainHttpRemote(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && !LOCAL_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

// ---------- run all rules ----------

function serverFindings(s: ServerEntry): Finding[] {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, 'file' | 'server'>) => out.push({ ...f, file: s.file, server: s.name });
  const c = s.config;

  // MCP001
  const auto = c.autoApprove ?? c.alwaysAllow;
  if (auto === true || (Array.isArray(auto) && auto.length > 0)) {
    const which = Array.isArray(auto) ? ` for ${auto.length} tool(s): ${auto.slice(0, 5).join(', ')}${auto.length > 5 ? ', …' : ''}` : ' for all tools';
    add({ rule: 'MCP001', severity: 'high', message: `Tools run with no human approval${which}.`, fix: `Remove "${c.autoApprove !== undefined ? 'autoApprove' : 'alwaysAllow'}" and approve tools per call.` });
  }
  if (c.trust === true) add({ rule: 'MCP001', severity: 'high', message: '"trust": true skips every tool confirmation.', fix: 'Remove "trust": true.' });

  // MCP002 + MCP003 (stdio only)
  const tokens = argv(s);
  let segments = [tokens];
  if (tokens.length > 0) {
    const cmd = base(tokens[0]!);
    if (SHELLS.has(cmd)) {
      const flagIdx = tokens.findIndex((t, i) => i > 0 && /^(-c|-lc|-ic|-command|\/c|\/k|-encodedcommand|-e|-ec)$/i.test(t));
      if (flagIdx > 0) {
        const script = tokens.slice(flagIdx + 1).join(' ');
        const benignCmd = (cmd === 'cmd' || cmd === 'powershell' || cmd === 'pwsh') && !SHELL_OPS.test(script);
        if (!benignCmd) {
          add({ rule: 'MCP003', severity: 'high', message: `Runs a raw shell script: \`${cmd} ${tokens[flagIdx]} ${truncate(script, 80)}\`.`, fix: 'Call the server binary directly with "command" and "args", no shell.' });
        }
        segments = script.split(/&&|\|\||;|\|/).map((part) => splitWords(part.trim()));
      }
    } else if (SHELL_OPS.test(tokens.slice(1).join(' ')) && /(curl|wget|iwr|Invoke-WebRequest)[^|]*\|/i.test(tokens.join(' '))) {
      add({ rule: 'MCP003', severity: 'high', message: 'Downloads a script and pipes it to a shell.', fix: 'Install the server as a pinned package instead.' });
    }
    for (const pkg of segments.map(findPackage)) {
      if (!pkg || pkg.pinned) continue;
      const docker = pkg.runner === 'docker' || pkg.runner === 'podman';
      add({
        rule: 'MCP002',
        severity: pkg.level ?? 'high',
        message: docker
          ? pkg.level === 'low'
            ? `Image \`${pkg.spec}\` uses a tag, which can be moved to new code.`
            : `Image \`${pkg.spec}\` has no version, so it runs whatever "latest" is today.`
          : `\`${pkg.runner} ${pkg.spec}\` is not pinned, so it runs whatever version is newest today.`,
        fix: docker ? 'Pin the image by digest: image@sha256:…' : /uv|pipx/.test(pkg.runner) ? 'Pin an exact version, e.g. pkg==1.2.3.' : 'Pin an exact version, e.g. pkg@1.2.3.',
      });
    }
  }

  // MCP004
  const secrets: string[] = [];
  for (const [k, v] of Object.entries(s.env)) {
    const kind = secretKind(k, v);
    if (kind) secrets.push(`env.${k} (${kind}, ${mask(v)})`);
  }
  for (const [k, v] of Object.entries(s.headers)) {
    const kind = secretKind(k, v);
    if (kind) secrets.push(`headers.${k} (${kind})`);
  }
  s.args.forEach((a, i) => {
    const m = a.match(/^--?([\w-]+)=(.+)$/);
    const prevFlag = s.args[i - 1]?.match(/^--?([\w-]+)$/)?.[1];
    const kind = m ? secretKind(m[1]!, m[2]!) : secretKind(prevFlag ?? '', a);
    if (kind) secrets.push(`args[${i}] (${kind})`);
  });
  if (s.url) {
    try {
      for (const [k, v] of new URL(s.url).searchParams) {
        const kind = secretKind(k, v);
        if (kind) secrets.push(`url ?${k}= (${kind})`);
      }
    } catch {
      /* not a URL */
    }
  }
  if (secrets.length > 0) {
    add({ rule: 'MCP004', severity: 'high', message: `Secret written in the config: ${secrets.join('; ')}.`, fix: 'Rotate it now, then use "${env:NAME}" / "${NAME}" or an input variable instead.' });
  }

  // MCP005
  if (s.url && plainHttpRemote(s.url)) {
    add({ rule: 'MCP005', severity: 'medium', message: `Remote server uses plain http: ${hostOf(s.url)}.`, fix: 'Use https://.' });
  }
  return out;
}

function settingsFindings(file: string, data: Record<string, unknown>): Finding[] {
  const out: Finding[] = [];
  const add = (key: string, message: string) =>
    out.push({ rule: 'MCP001', severity: 'high', file, message, fix: `Remove "${key}" from ${file}.` });
  if (data.enableAllProjectMcpServers === true) add('enableAllProjectMcpServers', 'Every server in .mcp.json starts with no prompt, including ones added later.');
  for (const key of ['chat.tools.autoApprove', 'chat.tools.global.autoApprove']) {
    if (data[key] === true) add(key, `"${key}": true runs every tool with no confirmation.`);
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function runRules(d: Discovered): Finding[] {
  return [...d.settings.flatMap((s) => settingsFindings(s.file, s.data)), ...d.servers.flatMap(serverFindings)];
}
