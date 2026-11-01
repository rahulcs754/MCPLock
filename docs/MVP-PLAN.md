# MCPLock MVP plan (v0.1)

Goal: one PR check that makes MCP server configs as safe to review as `package-lock.json`.

## Scope
- [ ] Find configs: `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.roo/mcp.json`, plus `.claude/settings.json` (auto-approve flags only).
- [ ] Parse both shapes: `mcpServers: {}` (Claude, Cursor, Gemini, Roo) and `servers: {}` (VS Code). Allow JSONC (comments, trailing commas).
- [ ] Rules
  - `MCP001` auto-approve on (`autoApprove`, `alwaysAllow`, `trust: true`, `enableAllProjectMcpServers`) - high
  - `MCP002` unpinned package (`npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `uvx`, `pipx run`, `docker run` without exact version or digest) - high
  - `MCP003` raw shell command (`bash -c`, `sh -c`, `powershell -Command`, `curl | sh`) - high
  - `MCP004` secret written in the config (`env`, `headers`, `args`, `url`) - high
  - `MCP005` remote server over plain `http://` (not localhost) - medium
- [ ] `mcp.lock`: per server, a sha256 of its canonical config, plus a sha256 per tool (name + description + input schema).
- [ ] `--probe`: start each server (stdio or HTTP), call `initialize` + `tools/list`, hash the tools.
  - Safety: in CI, only probe servers whose config hash matches the lock on the **base branch**, so a PR can never make CI run a new command.
- [ ] Commands: `mcplock scan`, `mcplock lock [--probe]`, `mcplock check [--probe] [--base ref] [--comment]`.
- [ ] `mcplock.json`: `failOn` level and `allow` list (rule + server).
- [ ] Report: terminal text, GitHub job summary, one PR comment that updates on each push.
- [ ] GitHub Action (composite, runs bundled `dist/cli.js`, no install step).
- [ ] Tests with fake configs, a fake stdio MCP server and a fake HTTP MCP server.
- [ ] README how-to + GitHub Pages site (`docs/index.html`).

## Not in v0.1
- User-level configs (`~/.cursor/mcp.json`, Claude Desktop) - repo only.
- Allowlist of known-good servers / registry lookup.
- Scanning tool descriptions for prompt-injection text (v0.2: easy add on top of probe).
