#!/usr/bin/env node

// src/cli.ts
import { appendFileSync } from "fs";
import { resolve } from "path";
import { parseArgs } from "util";

// src/config.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// src/jsonc.ts
function parseJsonc(text) {
  return JSON.parse(stripJsonc(text.replace(/^﻿/, "")));
}
function stripJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (c === "/" && next === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else if (c === ",") {
      let j = i + 1;
      while (j < n) {
        if (/\s/.test(text[j])) j++;
        else if (text[j] === "/" && text[j + 1] === "/") while (j < n && text[j] !== "\n") j++;
        else if (text[j] === "/" && text[j + 1] === "*") {
          j += 2;
          while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
          j += 2;
        } else break;
      }
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// src/config.ts
var CONFIG_NAME = "mcplock.json";
var LEVELS = ["low", "medium", "high", "none"];
function loadConfig(root) {
  const cfg = { failOn: "high", allow: [], include: [] };
  const path = join(root, CONFIG_NAME);
  if (!existsSync(path)) return cfg;
  const raw = parseJsonc(readFileSync(path, "utf8"));
  if (raw.failOn !== void 0) cfg.failOn = parseFailOn(String(raw.failOn));
  if (Array.isArray(raw.allow)) cfg.allow = raw.allow.filter((a) => a && typeof a.rule === "string");
  if (Array.isArray(raw.include)) cfg.include = raw.include.map(String);
  return cfg;
}
function parseFailOn(v) {
  const l = v.toLowerCase();
  if (!LEVELS.includes(l)) throw new Error(`failOn must be one of ${LEVELS.join(", ")} (got "${v}")`);
  return l;
}
function isAllowed(f, allow) {
  return allow.some((a) => a.rule === f.rule && (!a.server || a.server === f.server) && (!a.file || a.file === f.file));
}
function failsAt(f, failOn) {
  if (failOn === "none") return false;
  return LEVELS.indexOf(f.severity) >= LEVELS.indexOf(failOn);
}

// src/github.ts
import { readFileSync as readFileSync2 } from "fs";

// src/rules.ts
var RULES = {
  MCP001: "Auto-approve is on",
  MCP002: "Unpinned package",
  MCP003: "Raw shell command",
  MCP004: "Secret in config",
  MCP005: "Remote server over plain http"
};
var SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh"]);
var SHELL_OPS = /(\|\s*(ba|z|da)?sh\b|&&|\|\||;|\$\(|`|>\s*\S|\b(curl|wget|iwr|Invoke-WebRequest|Invoke-Expression|iex)\b)/i;
function splitWords(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}
var base = (cmd) => cmd.replace(/\\/g, "/").split("/").pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
function argv(s) {
  if (!s.command) return [];
  const head = s.args.length === 0 && /\s/.test(s.command.trim()) ? splitWords(s.command) : [s.command];
  return [...head, ...s.args];
}
var SEMVER = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
var SHA = /^[0-9a-f]{40}$/i;
function npmPinned(spec) {
  if (/^(\.|\/|~|file:|[A-Za-z]:\\)/.test(spec)) return true;
  if (/^(git\+|github:|gitlab:|bitbucket:|https?:|git:)/.test(spec) || /^[\w-]+\/[\w.-]+(#.*)?$/.test(spec)) {
    const ref = spec.split("#")[1];
    return !!ref && SHA.test(ref);
  }
  const at = spec.lastIndexOf("@");
  if (at <= 0) return false;
  return SEMVER.test(spec.slice(at + 1));
}
function pyPinned(spec) {
  if (/^(\.|\/|~|file:)/.test(spec)) return true;
  if (/^git\+/.test(spec)) return SHA.test(spec.split("@").pop() ?? "");
  const m = spec.match(/(===?|@)\s*([^,;\s]+)$/);
  return !!m && /^\d+(\.\d+)*([a-z]+\d*)?$/i.test(m[2]) && !/[<>~!*,]/.test(spec);
}
var NPX_VALUE_FLAGS = /* @__PURE__ */ new Set(["-p", "--package", "-c", "--call", "--registry", "--cache", "--userconfig", "-w", "--workspace"]);
var DOCKER_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "-e",
  "--env",
  "--env-file",
  "-v",
  "--volume",
  "--mount",
  "-p",
  "--publish",
  "--name",
  "--network",
  "--net",
  "-w",
  "--workdir",
  "-u",
  "--user",
  "-l",
  "--label",
  "--entrypoint",
  "--platform",
  "--add-host",
  "--cpus",
  "-m",
  "--memory",
  "--pull",
  "--restart",
  "--hostname",
  "-h",
  "--cap-add",
  "--cap-drop",
  "--security-opt",
  "--device",
  "--ulimit",
  "--log-driver",
  "--tmpfs",
  "--gpus"
]);
function firstPositional(tokens, valueFlags) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") return tokens[i + 1];
    if (t.startsWith("-")) {
      if (!t.includes("=") && valueFlags.has(t)) i++;
      continue;
    }
    return t;
  }
  return void 0;
}
function flagValue(tokens, names) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    for (const n of names) {
      if (t === n) return tokens[i + 1];
      if (t.startsWith(`${n}=`)) return t.slice(n.length + 1);
    }
  }
  return void 0;
}
function findPackage(tokens) {
  if (tokens.length === 0) return void 0;
  const cmd = base(tokens[0]);
  const rest = tokens.slice(1);
  if (cmd === "npx" || cmd === "bunx") {
    const spec = flagValue(rest, ["-p", "--package"]) ?? firstPositional(rest, NPX_VALUE_FLAGS);
    return spec ? { runner: cmd, spec, pinned: npmPinned(spec) } : void 0;
  }
  if (cmd === "npm" && (rest[0] === "exec" || rest[0] === "x") || (cmd === "pnpm" || cmd === "yarn") && rest[0] === "dlx" || cmd === "bun" && rest[0] === "x") {
    const sub = rest.slice(1);
    const spec = flagValue(sub, ["-p", "--package"]) ?? firstPositional(sub, NPX_VALUE_FLAGS);
    return spec ? { runner: `${cmd} ${rest[0]}`, spec, pinned: npmPinned(spec) } : void 0;
  }
  if (cmd === "uvx" || cmd === "uv" && rest[0] === "tool" && rest[1] === "run") {
    const sub = cmd === "uvx" ? rest : rest.slice(2);
    const spec = flagValue(sub, ["--from"]) ?? firstPositional(sub, /* @__PURE__ */ new Set(["--with", "--python", "-p", "--index-url", "--index"]));
    return spec ? { runner: cmd === "uvx" ? "uvx" : "uv tool run", spec, pinned: pyPinned(spec) } : void 0;
  }
  if (cmd === "pipx" && rest[0] === "run") {
    const sub = rest.slice(1);
    const spec = flagValue(sub, ["--spec"]) ?? firstPositional(sub, /* @__PURE__ */ new Set(["--python", "--index-url", "--pip-args"]));
    return spec ? { runner: "pipx run", spec, pinned: pyPinned(spec) } : void 0;
  }
  if ((cmd === "docker" || cmd === "podman") && rest[0] === "run") {
    const image = firstPositional(rest.slice(1), DOCKER_VALUE_FLAGS);
    if (!image) return void 0;
    if (/@sha256:[0-9a-f]{64}$/i.test(image)) return { runner: cmd, spec: image, pinned: true };
    const tag = image.includes(":") && !image.endsWith(":") ? image.slice(image.lastIndexOf(":") + 1) : "";
    const hasTag = !!tag && !tag.includes("/") && tag !== "latest";
    return { runner: cmd, spec: image, pinned: false, level: hasTag ? "low" : "high" };
  }
  return void 0;
}
var TOKEN_PATTERNS = [
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{30,}/],
  ["OpenAI key", /\bsk-(proj-)?[A-Za-z0-9_-]{40,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["Stripe live key", /\b(sk|rk)_live_[A-Za-z0-9]{24,}/],
  ["Razorpay live key", /\brzp_live_[A-Za-z0-9]{14,}/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["Private key", /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/]
];
var SECRET_NAME = /(token|secret|passw(or)?d|passwd|api[-_]?key|access[-_]?key|private[-_]?key|auth|credential|cookie|session)/i;
var DUMMY = /^(x+|\*+|\.+|<.*>|\[.*\]|your[-_ ].*|changeme|change-me|todo|tbd|placeholder|example|none|null|false|true|redacted)$/i;
function isPlaceholder(v) {
  const s = v.trim();
  return s === "" || /\$\{[^}]+\}/.test(s) || /^\$[A-Z_][A-Z0-9_]*$/i.test(s) || /\{\{.*\}\}/.test(s) || /^%[A-Z_][A-Z0-9_]*%$/i.test(s) || DUMMY.test(s);
}
function mask(v) {
  return v.length <= 8 ? "***" : `${v.slice(0, 4)}\u2026${"*".repeat(4)}`;
}
function secretKind(key, value) {
  for (const [label, re] of TOKEN_PATTERNS) if (re.test(value)) return label;
  if (isPlaceholder(value)) return void 0;
  let v = value.trim();
  const bearer = v.match(/^(Bearer|Basic|token)\s+(.+)$/i);
  if (bearer) {
    v = bearer[2].trim();
    if (isPlaceholder(v)) return void 0;
    if (v.length >= 8) return `${bearer[1]} credential`;
  }
  const randomLooking = /\d/.test(v) && /[A-Za-z]/.test(v) || v.length >= 24;
  if (SECRET_NAME.test(key) && v.length >= 8 && randomLooking && !/\s/.test(v) && !/^https?:\/\//.test(v)) return `value of ${key}`;
  return void 0;
}
var LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[\w.-]+\.localhost)$/i;
function plainHttpRemote(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && !LOCAL_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}
function serverFindings(s) {
  const out = [];
  const add = (f) => out.push({ ...f, file: s.file, server: s.name });
  const c = s.config;
  const auto = c.autoApprove ?? c.alwaysAllow;
  if (auto === true || Array.isArray(auto) && auto.length > 0) {
    const which = Array.isArray(auto) ? ` for ${auto.length} tool(s): ${auto.slice(0, 5).join(", ")}${auto.length > 5 ? ", \u2026" : ""}` : " for all tools";
    add({ rule: "MCP001", severity: "high", message: `Tools run with no human approval${which}.`, fix: `Remove "${c.autoApprove !== void 0 ? "autoApprove" : "alwaysAllow"}" and approve tools per call.` });
  }
  if (c.trust === true) add({ rule: "MCP001", severity: "high", message: '"trust": true skips every tool confirmation.', fix: 'Remove "trust": true.' });
  const tokens = argv(s);
  let segments = [tokens];
  if (tokens.length > 0) {
    const cmd = base(tokens[0]);
    if (SHELLS.has(cmd)) {
      const flagIdx = tokens.findIndex((t, i) => i > 0 && /^(-c|-lc|-ic|-command|\/c|\/k|-encodedcommand|-e|-ec)$/i.test(t));
      if (flagIdx > 0) {
        const script = tokens.slice(flagIdx + 1).join(" ");
        const benignCmd = (cmd === "cmd" || cmd === "powershell" || cmd === "pwsh") && !SHELL_OPS.test(script);
        if (!benignCmd) {
          add({ rule: "MCP003", severity: "high", message: `Runs a raw shell script: \`${cmd} ${tokens[flagIdx]} ${truncate(script, 80)}\`.`, fix: 'Call the server binary directly with "command" and "args", no shell.' });
        }
        segments = script.split(/&&|\|\||;|\|/).map((part) => splitWords(part.trim()));
      }
    } else if (SHELL_OPS.test(tokens.slice(1).join(" ")) && /(curl|wget|iwr|Invoke-WebRequest)[^|]*\|/i.test(tokens.join(" "))) {
      add({ rule: "MCP003", severity: "high", message: "Downloads a script and pipes it to a shell.", fix: "Install the server as a pinned package instead." });
    }
    for (const pkg of segments.map(findPackage)) {
      if (!pkg || pkg.pinned) continue;
      const docker = pkg.runner === "docker" || pkg.runner === "podman";
      add({
        rule: "MCP002",
        severity: pkg.level ?? "high",
        message: docker ? pkg.level === "low" ? `Image \`${pkg.spec}\` uses a tag, which can be moved to new code.` : `Image \`${pkg.spec}\` has no version, so it runs whatever "latest" is today.` : `\`${pkg.runner} ${pkg.spec}\` is not pinned, so it runs whatever version is newest today.`,
        fix: docker ? "Pin the image by digest: image@sha256:\u2026" : /uv|pipx/.test(pkg.runner) ? "Pin an exact version, e.g. pkg==1.2.3." : "Pin an exact version, e.g. pkg@1.2.3."
      });
    }
  }
  const secrets = [];
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
    const kind = m ? secretKind(m[1], m[2]) : secretKind(prevFlag ?? "", a);
    if (kind) secrets.push(`args[${i}] (${kind})`);
  });
  if (s.url) {
    try {
      for (const [k, v] of new URL(s.url).searchParams) {
        const kind = secretKind(k, v);
        if (kind) secrets.push(`url ?${k}= (${kind})`);
      }
    } catch {
    }
  }
  if (secrets.length > 0) {
    add({ rule: "MCP004", severity: "high", message: `Secret written in the config: ${secrets.join("; ")}.`, fix: 'Rotate it now, then use "${env:NAME}" / "${NAME}" or an input variable instead.' });
  }
  if (s.url && plainHttpRemote(s.url)) {
    add({ rule: "MCP005", severity: "medium", message: `Remote server uses plain http: ${hostOf(s.url)}.`, fix: "Use https://." });
  }
  return out;
}
function settingsFindings(file, data) {
  const out = [];
  const add = (key, message) => out.push({ rule: "MCP001", severity: "high", file, message, fix: `Remove "${key}" from ${file}.` });
  if (data.enableAllProjectMcpServers === true) add("enableAllProjectMcpServers", "Every server in .mcp.json starts with no prompt, including ones added later.");
  for (const key of ["chat.tools.autoApprove", "chat.tools.global.autoApprove"]) {
    if (data[key] === true) add(key, `"${key}": true runs every tool with no confirmation.`);
  }
  return out;
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}\u2026` : s;
}
function runRules(d) {
  return [...d.settings.flatMap((s) => settingsFindings(s.file, s.data)), ...d.servers.flatMap(serverFindings)];
}

// src/report.ts
var MARKER = "<!-- mcplock-report -->";
var ICON = { high: "\u{1F534}", medium: "\u{1F7E0}", low: "\u{1F7E1}" };
var esc = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
function where(f) {
  const s = f.server ?? f.name;
  return s ? `\`${f.file}\` \u2192 \`${s}\`` : `\`${f.file}\``;
}
function toolDetail(d) {
  if (!d.tools) return "";
  const parts = [];
  if (d.tools.added.length) parts.push(`added: ${d.tools.added.map((t) => `\`${t}\``).join(", ")}`);
  if (d.tools.removed.length) parts.push(`removed: ${d.tools.removed.map((t) => `\`${t}\``).join(", ")}`);
  if (d.tools.changed.length) parts.push(`changed: ${d.tools.changed.map((t) => `\`${t}\``).join(", ")}`);
  return parts.length ? ` (${parts.join("; ")})` : "";
}
function headline(r) {
  const problems = r.failing.length + (r.drift?.length ?? 0) + (r.lockMissing ? 1 : 0) + r.errors.length;
  if (r.failed) return `\u274C MCPLock: ${problems} problem${problems === 1 ? "" : "s"} in MCP configs`;
  if (r.files.length === 0) return "\u2705 MCPLock: no MCP config files found";
  return "\u2705 MCPLock: MCP configs look safe and match mcp.lock";
}
function toMarkdown(r) {
  const out = [MARKER, `### ${headline(r)}`];
  out.push(`Scanned ${r.files.length} file${r.files.length === 1 ? "" : "s"} and ${r.serverCount} server${r.serverCount === 1 ? "" : "s"}${r.files.length ? `: ${r.files.map((f) => `\`${f}\``).join(", ")}` : ""}.`);
  if (r.errors.length) {
    out.push("", "**Could not read**");
    for (const e of r.errors) out.push(`- \`${e.file}\`: ${e.message}`);
  }
  if (r.findings.length) {
    out.push("", "**Risky settings**", "", "| | Rule | Where | Problem | Fix |", "|---|---|---|---|---|");
    for (const f of r.findings) {
      out.push(`| ${ICON[f.severity]} | ${f.rule} ${RULES[f.rule] ?? ""} | ${where(f)} | ${esc(f.message)} | ${esc(f.fix)} |`);
    }
  }
  if (r.allowed.length) {
    out.push("", `<details><summary>${r.allowed.length} finding(s) allowed in mcplock.json</summary>`, "");
    for (const f of r.allowed) out.push(`- ${f.rule} ${where(f)}: ${f.message}`);
    out.push("", "</details>");
  }
  if (r.lockMissing) {
    out.push("", "**No mcp.lock yet.** Run `npx mcplock lock` (add `--probe` to also lock tool lists) and commit `mcp.lock`.");
  } else if (r.drift?.length) {
    out.push("", "**Out of sync with mcp.lock**");
    for (const d of r.drift) out.push(`- ${where(d)}: ${d.message}${toolDetail(d)}`);
    out.push("", "If these changes are expected, run `npx mcplock lock --probe` and commit `mcp.lock` so a reviewer can approve them.");
  }
  if (r.baseChanges?.length) {
    out.push("", `**This PR changes mcp.lock** (vs \`${r.baseRef}\`). Please review each server before merging:`);
    for (const d of r.baseChanges) out.push(`- ${where(d)}: ${d.message}${toolDetail(d)}`);
  }
  if (r.probes.length) {
    out.push("", "<details><summary>Tool probe</summary>", "");
    for (const p of r.probes) out.push(`- ${p.status === "ok" ? "\u2705" : p.status === "skipped" ? "\u23ED\uFE0F" : "\u26A0\uFE0F"} \`${p.id}\`: ${p.message}`);
    out.push("", "</details>");
  }
  out.push("", "<sub>[MCPLock](https://github.com/rahulcs754/mcplock) \xB7 lockfile and PR check for MCP server configs</sub>");
  return `${out.join("\n")}
`;
}
function toText(r) {
  const out = [headline(r).replace(/^[✅❌] /u, ""), `Files: ${r.files.join(", ") || "none"} (${r.serverCount} servers)`];
  for (const e of r.errors) out.push(`  ERROR ${e.file}: ${e.message}`);
  for (const f of r.findings) {
    out.push(`  ${f.severity.toUpperCase().padEnd(6)} ${f.rule} ${f.file}${f.server ? ` > ${f.server}` : ""}: ${f.message}`, `         fix: ${f.fix}`);
  }
  for (const f of r.allowed) out.push(`  allowed ${f.rule} ${f.file}${f.server ? ` > ${f.server}` : ""}`);
  if (r.lockMissing) out.push("  LOCK   no mcp.lock yet: run `mcplock lock` and commit it");
  for (const d of r.drift ?? []) out.push(`  DRIFT  ${d.id}: ${d.message}${toolDetail(d).replace(/`/g, "")}`);
  for (const d of r.baseChanges ?? []) out.push(`  REVIEW ${d.id}: ${d.message}${toolDetail(d).replace(/`/g, "")}`);
  for (const p of r.probes) out.push(`  probe  ${p.status.padEnd(7)} ${p.id}: ${p.message}`);
  return `${out.join("\n")}
`;
}

// src/github.ts
function prContext(env = process.env) {
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repo || !env.GITHUB_EVENT_PATH) return void 0;
  const event = JSON.parse(readFileSync2(env.GITHUB_EVENT_PATH, "utf8"));
  const number = event.pull_request?.number;
  if (typeof number !== "number") return void 0;
  return { owner, repo, number, apiUrl: env.GITHUB_API_URL ?? "https://api.github.com" };
}
async function gh(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json"
    }
  });
  if (!res.ok) throw new Error(`GitHub API ${init.method ?? "GET"} ${new URL(url).pathname} failed: ${res.status}`);
  return res;
}
async function upsertComment(token, pr, body) {
  const base2 = `${pr.apiUrl}/repos/${pr.owner}/${pr.repo}`;
  for (let page = 1; page <= 10; page++) {
    const res = await gh(token, `${base2}/issues/${pr.number}/comments?per_page=100&page=${page}`);
    const comments = await res.json();
    const ours = comments.find((c) => c.body?.includes(MARKER));
    if (ours) {
      await gh(token, `${base2}/issues/comments/${ours.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
      return "updated";
    }
    if (comments.length < 100) break;
  }
  await gh(token, `${base2}/issues/${pr.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  return "created";
}

// src/run.ts
import { join as join3 } from "path";

// src/discover.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "fs";
import { join as join2 } from "path";
var SERVER_FILES = [
  ".mcp.json",
  // Claude Code
  ".cursor/mcp.json",
  // Cursor
  ".vscode/mcp.json",
  // VS Code / Copilot
  ".gemini/settings.json",
  // Gemini CLI
  ".roo/mcp.json",
  // Roo Code
  ".kiro/settings/mcp.json",
  // Kiro
  ".amazonq/mcp.json"
  // Amazon Q
];
var SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json", ".vscode/settings.json"];
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function strRecord(v) {
  const out = {};
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) if (val != null) out[k] = String(val);
  }
  return out;
}
function toServer(file, name, raw) {
  const url = [raw.url, raw.httpUrl, raw.serverUrl].find((u) => typeof u === "string");
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  let transport = "stdio";
  if (url && typeof raw.command !== "string") transport = type === "sse" || !type && /\/sse\/?$/.test(url) ? "sse" : "http";
  return {
    id: `${file}#${name}`,
    file,
    name,
    transport,
    config: raw,
    command: typeof raw.command === "string" ? raw.command : void 0,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: strRecord(raw.env),
    url,
    headers: strRecord(raw.headers)
  };
}
function discover(root, extra = []) {
  const result = { files: [], servers: [], settings: [], errors: [] };
  const serverFiles = [.../* @__PURE__ */ new Set([...SERVER_FILES, ...extra])];
  const all = [.../* @__PURE__ */ new Set([...serverFiles, ...SETTINGS_FILES])];
  for (const file of all) {
    const path = join2(root, file);
    if (!existsSync2(path)) continue;
    let data;
    try {
      data = parseJsonc(readFileSync3(path, "utf8"));
    } catch (e) {
      result.errors.push({ file, message: `Could not parse JSON: ${e.message}` });
      continue;
    }
    if (!isObj(data)) {
      result.errors.push({ file, message: "Top level is not a JSON object" });
      continue;
    }
    result.files.push(file);
    if (SETTINGS_FILES.includes(file) || file === ".gemini/settings.json") result.settings.push({ file, data });
    if (!serverFiles.includes(file)) continue;
    const block = isObj(data.mcpServers) ? data.mcpServers : isObj(data.servers) ? data.servers : void 0;
    if (!block) continue;
    for (const [name, raw] of Object.entries(block)) {
      if (isObj(raw)) result.servers.push(toServer(file, name, raw));
    }
  }
  return result;
}

// src/lock.ts
import { createHash } from "crypto";
import { existsSync as existsSync3, readFileSync as readFileSync4, writeFileSync } from "fs";
import { execFileSync } from "child_process";
var LOCK_NAME = "mcp.lock";
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, val]) => val !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
var sha256 = (s) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
var configHash = (s) => sha256(canonical(s.config));
function toolHash(t) {
  const { name, title, description, inputSchema, outputSchema, annotations } = t;
  return sha256(canonical({ name, title, description, inputSchema, outputSchema, annotations }));
}
function hashTools(tools) {
  const out = {};
  for (const t of [...tools].sort((a, b) => a.name < b.name ? -1 : 1)) out[t.name] = toolHash(t);
  return out;
}
var emptyLock = () => ({ lockfileVersion: 1, servers: {} });
function parseLock(text, where2 = LOCK_NAME) {
  const data = JSON.parse(text);
  if (data.lockfileVersion !== 1 || typeof data.servers !== "object" || data.servers === null) {
    throw new Error(`${where2} is not a valid MCPLock v1 lockfile`);
  }
  return data;
}
function readLock(path) {
  return existsSync3(path) ? parseLock(readFileSync4(path, "utf8"), path) : void 0;
}
function readLockAtRef(ref, lockPath, cwd) {
  try {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd, encoding: "utf8" }).trim();
    const text = execFileSync("git", ["show", `${ref}:${prefix}${lockPath}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseLock(text, `${ref}:${lockPath}`);
  } catch (e) {
    if (e instanceof Error && e.message.includes("not a valid")) throw e;
    return emptyLock();
  }
}
function serializeLock(lock2) {
  const servers = {};
  for (const id of Object.keys(lock2.servers).sort()) {
    const s = lock2.servers[id];
    servers[id] = { file: s.file, name: s.name, transport: s.transport, config: s.config, ...s.tools ? { tools: s.tools } : {} };
  }
  return `${JSON.stringify({ lockfileVersion: 1, servers }, null, 2)}
`;
}
function writeLock(path, lock2) {
  writeFileSync(path, serializeLock(lock2));
}
function buildLock(servers, previous, probed) {
  const lock2 = emptyLock();
  for (const s of servers) {
    const config = configHash(s);
    const prev = previous?.servers[s.id];
    const tools = probed.get(s.id) ?? (prev && prev.config === config ? prev.tools : void 0);
    lock2.servers[s.id] = { file: s.file, name: s.name, transport: s.transport, config, ...tools ? { tools } : {} };
  }
  return lock2;
}
function diffTools(locked, now) {
  const added = Object.keys(now).filter((n) => !(n in locked));
  const removed = Object.keys(locked).filter((n) => !(n in now));
  const changed = Object.keys(now).filter((n) => n in locked && locked[n] !== now[n]);
  return { added, removed, changed };
}
function compare(servers, lock2, probed = /* @__PURE__ */ new Map()) {
  const drift = [];
  const seen = /* @__PURE__ */ new Set();
  for (const s of servers) {
    seen.add(s.id);
    const locked = lock2.servers[s.id];
    if (!locked) {
      drift.push({ kind: "added", id: s.id, file: s.file, name: s.name, message: "New server, not in mcp.lock." });
      continue;
    }
    if (locked.config !== configHash(s)) {
      drift.push({ kind: "config-changed", id: s.id, file: s.file, name: s.name, message: "Server config changed since mcp.lock was written." });
      continue;
    }
    const tools = probed.get(s.id);
    if (tools && locked.tools) {
      const d = diffTools(locked.tools, tools);
      if (d.added.length + d.removed.length + d.changed.length > 0) {
        drift.push({ kind: "tools-changed", id: s.id, file: s.file, name: s.name, message: "Server tools changed with no config change (possible rug pull).", tools: d });
      }
    }
  }
  for (const [id, l] of Object.entries(lock2.servers)) {
    if (!seen.has(id)) drift.push({ kind: "removed", id, file: l.file, name: l.name, message: "Server is in mcp.lock but no longer in any config." });
  }
  return drift;
}
function lockChanges(base2, head) {
  const out = [];
  for (const [id, h] of Object.entries(head.servers)) {
    const b = base2.servers[id];
    if (!b) out.push({ kind: "added", id, file: h.file, name: h.name, message: "Added to mcp.lock." });
    else if (b.config !== h.config) out.push({ kind: "config-changed", id, file: h.file, name: h.name, message: "Config changed in mcp.lock." });
    else if (b.tools && h.tools) {
      const d = diffTools(b.tools, h.tools);
      if (d.added.length + d.removed.length + d.changed.length > 0) out.push({ kind: "tools-changed", id, file: h.file, name: h.name, message: "Tool list changed in mcp.lock.", tools: d });
    }
  }
  for (const [id, b] of Object.entries(base2.servers)) {
    if (!head.servers[id]) out.push({ kind: "removed", id, file: b.file, name: b.name, message: "Removed from mcp.lock." });
  }
  return out;
}

// src/probe.ts
import { spawn } from "child_process";
var PROTOCOL_VERSION = "2025-06-18";
var CLIENT_INFO = { name: "mcplock", version: "0.1.0" };
function expand(value, env = process.env) {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => env[n] ?? "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_, n, _d, def) => env[n] ?? def ?? "").replace(/^\$([A-Za-z_][A-Za-z0-9_]*)$/, (_, n) => env[n] ?? "");
}
function expandAll(r) {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, expand(v)]));
}
async function probe(s, timeoutMs = 6e4) {
  const unresolved = JSON.stringify(s.config).match(/\$\{input:[^}]+\}/);
  if (unresolved) throw new Error(`needs a VS Code input (${unresolved[0]}), which MCPLock cannot fill in`);
  if (s.transport === "stdio") return probeStdio(s, timeoutMs);
  if (s.transport === "http") return probeHttp(s, timeoutMs);
  throw new Error("legacy SSE transport is not supported for probing yet");
}
async function listAll(call) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const res = await call("tools/list", cursor ? { cursor } : {});
    tools.push(...res.tools ?? []);
    cursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : void 0;
    if (!cursor) break;
  }
  return tools;
}
function initParams() {
  return { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO };
}
function probeStdio(s, timeoutMs) {
  const [cmd, ...args] = argv(s).map((a) => expand(a));
  if (!cmd) return Promise.reject(new Error("no command"));
  return new Promise((resolve2, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...expandAll(s.env) },
      stdio: ["pipe", "pipe", "pipe"],
      cwd: typeof s.config.cwd === "string" ? s.config.cwd : void 0
    });
    let buf = "";
    let stderr = "";
    let nextId = 1;
    const pending = /* @__PURE__ */ new Map();
    let done = false;
    const finish = (err, tools) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (err) reject(err);
      else resolve2(tools ?? []);
    };
    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs / 1e3}s`)), timeoutMs);
    child.on("error", (e) => finish(new Error(`could not start: ${e.message}`)));
    child.on("exit", (code) => finish(new Error(`exited early (code ${code})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`)));
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-2e3);
    });
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = typeof msg.id === "number" ? pending.get(msg.id) : void 0;
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) p.fail(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.ok(msg.result ?? {});
      }
    });
    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}
`);
    const call = (method, params) => new Promise((ok, fail) => {
      const id = nextId++;
      pending.set(id, { ok, fail });
      send({ jsonrpc: "2.0", id, method, params });
    });
    (async () => {
      const init = await call("initialize", initParams());
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const caps = init.capabilities ?? {};
      return caps.tools ? listAll(call) : [];
    })().then(
      (tools) => finish(void 0, tools),
      (e) => finish(e)
    );
  });
}
async function probeHttp(s, timeoutMs) {
  const url = expand(s.url);
  const headers = expandAll(s.headers);
  let session;
  let nextId = 1;
  const deadline = AbortSignal.timeout(timeoutMs);
  const post = async (body) => {
    const res = await fetch(url, {
      method: "POST",
      signal: deadline,
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...session ? { "mcp-session-id": session } : {},
        ...body.method !== "initialize" ? { "mcp-protocol-version": PROTOCOL_VERSION } : {}
      },
      body: JSON.stringify(body)
    });
    session = res.headers.get("mcp-session-id") ?? session;
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${String(body.method)}`);
    if (body.id === void 0) return void 0;
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (type.includes("text/event-stream")) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg.id === body.id) return msg;
        } catch {
        }
      }
      throw new Error(`no response to ${String(body.method)} in event stream`);
    }
    return JSON.parse(text);
  };
  const call = async (method, params) => {
    const msg = await post({ jsonrpc: "2.0", id: nextId++, method, params });
    if (msg?.error) throw new Error(`${msg.error.message} (${msg.error.code})`);
    return msg?.result ?? {};
  };
  const init = await call("initialize", initParams());
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const caps = init.capabilities ?? {};
  return caps.tools ? listAll(call) : [];
}

// src/run.ts
function scanAll(opts) {
  const cfg = loadConfig(opts.root);
  const failOn = opts.failOn ?? cfg.failOn;
  const d = discover(opts.root, cfg.include);
  const all = runRules(d);
  const allowed = all.filter((f) => isAllowed(f, cfg.allow));
  const findings = all.filter((f) => !isAllowed(f, cfg.allow));
  const failing = findings.filter((f) => failsAt(f, failOn));
  return { d, findings, allowed, failing };
}
async function probeServers(servers, trusted, opts) {
  const probed = /* @__PURE__ */ new Map();
  const notes = [];
  for (const s of servers) {
    if (trusted && trusted.servers[s.id]?.config !== configHash(s)) {
      notes.push({ id: s.id, status: "skipped", message: "not started: this config is not approved in the trusted mcp.lock yet" });
      continue;
    }
    opts.log?.(`probing ${s.id} \u2026`);
    try {
      const tools = await probe(s, opts.timeoutMs);
      probed.set(s.id, hashTools(tools));
      notes.push({ id: s.id, status: "ok", message: `${tools.length} tool${tools.length === 1 ? "" : "s"}` });
    } catch (e) {
      notes.push({ id: s.id, status: "error", message: e.message });
    }
  }
  return { probed, notes };
}
function scan(opts) {
  const { d, findings, allowed, failing } = scanAll(opts);
  return { files: d.files, serverCount: d.servers.length, findings, allowed, failing, probes: [], errors: d.errors, failed: failing.length > 0 || d.errors.length > 0 };
}
async function check(opts) {
  const { d, findings, allowed, failing } = scanAll(opts);
  const lockPath = join3(opts.root, LOCK_NAME);
  const lock2 = readLock(lockPath);
  const lockMissing = !lock2 && d.servers.length > 0;
  const baseLock = opts.base ? readLockAtRef(opts.base, LOCK_NAME, opts.root) : void 0;
  let probes = [];
  let probed = /* @__PURE__ */ new Map();
  if (opts.probe && lock2) {
    ({ probed, notes: probes } = await probeServers(d.servers, baseLock ?? lock2, opts));
  }
  const drift = lock2 ? compare(d.servers, lock2, probed) : [];
  for (const [id, tools] of probed) {
    if (!lock2?.servers[id]?.tools) {
      const n = probes.find((p) => p.id === id);
      if (n) n.message += ` (not in mcp.lock yet: run \`mcplock lock --probe\` to lock ${Object.keys(tools).length} tool hashes)`;
    }
  }
  const baseChanges = baseLock ? lockChanges(baseLock, lock2 ?? emptyLock()) : void 0;
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
    failed: failing.length > 0 || drift.length > 0 || lockMissing || d.errors.length > 0
  };
}
async function lock(opts) {
  const report = scan(opts);
  const d = discover(opts.root, loadConfig(opts.root).include);
  const lockPath = join3(opts.root, LOCK_NAME);
  const previous = readLock(lockPath);
  let probed = /* @__PURE__ */ new Map();
  if (opts.probe) {
    const r = await probeServers(d.servers, void 0, opts);
    probed = r.probed;
    report.probes = r.notes;
  }
  const next = buildLock(d.servers, previous, probed);
  writeLock(lockPath, next);
  return { report, lock: next, changes: lockChanges(previous ?? emptyLock(), next) };
}

// src/cli.ts
var HELP = `mcplock - lockfile and PR check for MCP server configs

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
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      probe: { type: "boolean" },
      base: { type: "string" },
      "fail-on": { type: "string" },
      comment: { type: "boolean" },
      timeout: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
  const cmd = positionals[0] ?? "check";
  if (values.help || !["scan", "lock", "check"].includes(cmd)) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }
  const opts = {
    root: resolve(values.root ?? "."),
    probe: values.probe,
    base: values.base || void 0,
    failOn: values["fail-on"] ? parseFailOn(values["fail-on"]) : void 0,
    timeoutMs: values.timeout ? Number(values.timeout) * 1e3 : 6e4,
    log: (m) => process.stderr.write(`${m}
`)
  };
  if (cmd === "lock") {
    const { report: report2, lock: next, changes } = await lock(opts);
    process.stdout.write(values.json ? `${JSON.stringify({ report: report2, lock: next, changes }, null, 2)}
` : toText(report2));
    const n = Object.keys(next.servers).length;
    process.stdout.write(`
Wrote mcp.lock: ${n} server${n === 1 ? "" : "s"}, ${changes.length} change${changes.length === 1 ? "" : "s"}.
`);
    for (const c of changes) process.stdout.write(`  ${c.kind.padEnd(14)} ${c.id}
`);
    if (report2.failing.length) process.stdout.write("\nNote: risky settings above will still fail `mcplock check`.\n");
    return 0;
  }
  const report = cmd === "scan" ? scan(opts) : await check(opts);
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}
` : toText(report));
  const md = toMarkdown(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (values.comment) {
    const pr = prContext();
    const token = process.env.GITHUB_TOKEN;
    if (!pr) process.stderr.write("--comment: not a pull_request event, skipping comment\n");
    else if (!token) process.stderr.write("--comment: GITHUB_TOKEN is not set, skipping comment\n");
    else if (report.files.length > 0 || report.failed) {
      try {
        const how = await upsertComment(token, pr, md);
        process.stderr.write(`PR comment ${how}
`);
      } catch (e) {
        process.stderr.write(`::warning::Could not post PR comment: ${e.message}
`);
      }
    }
  }
  return report.failed ? 1 : 0;
}
main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`mcplock: ${e.message}
`);
    process.exit(2);
  }
);
