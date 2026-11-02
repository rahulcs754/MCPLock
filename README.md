# MCPLock

**A lockfile and PR check for MCP server configs.** MCPLock scans `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json` (and more) in your repo, flags risky settings, and writes `mcp.lock` so any change to a server, or to the tools it exposes, fails the PR until someone reviews it.

[![CI](https://github.com/rahulcs754/mcplock/actions/workflows/ci.yml/badge.svg)](https://github.com/rahulcs754/mcplock/actions/workflows/ci.yml)
· [Website](https://rahulcs754.github.io/mcplock/)

## Why
MCP configs in a repo start commands on every teammate's laptop when they open the project in Claude Code, Cursor or VS Code. One changed line, an unpinned `npx` package, or a server that quietly changes its tools can take over a developer machine. Nobody reviews these files like code. MCPLock makes them reviewable, the same way `package-lock.json` did for packages. More in [docs/RESEARCH.md](docs/RESEARCH.md).

## Benefits
- **Blocks risky configs in PRs.** Auto-approve, unpinned packages, `bash -c` scripts, secrets in `env`, plain `http://`.
- **Locks every server.** `mcp.lock` holds a hash of each server's config and of each tool's name, description and schema.
- **Catches rug pulls.** With `--probe`, a server whose tools change (a new tool, or prompt-injection text in a description) fails the check even when no file in the repo changed.
- **Safe in CI.** In a PR, MCPLock only starts servers that are already approved in `mcp.lock` on the base branch. A PR cannot make CI run a new command.
- **No lock-in.** No account, no server, no AI. One bundled JS file, zero runtime dependencies.

## What the PR comment looks like
From [examples/demo](examples/demo/.mcp.json):

> ### ❌ MCPLock: 6 problems in MCP configs
> Scanned 1 file and 5 servers: `.mcp.json`.
>
> | | Rule | Where | Problem |
> |---|---|---|---|
> | 🔴 | MCP002 Unpinned package | `.mcp.json` → `playwright` | `npx @playwright/mcp@latest` is not pinned, so it runs whatever version is newest today. |
> | 🔴 | MCP001 Auto-approve is on | `.mcp.json` → `db` | Tools run with no human approval for 2 tool(s): query, execute. |
> | 🔴 | MCP003 Raw shell command | `.mcp.json` → `db` | Runs a raw shell script: `bash -c cd tools && npx -y some-db-mcp ...` |
> | 🔴 | MCP004 Secret in config | `.mcp.json` → `docs` | Secret written in the config: headers.Authorization (Bearer credential). |
> | 🟠 | MCP005 Remote server over plain http | `.mcp.json` → `docs` | Remote server uses plain http: docs-mcp.internal.example.com. |
>
> **No mcp.lock yet.** Run `npx mcplock lock` and commit `mcp.lock`.

When a PR changes a server, the comment also lists **"This PR changes mcp.lock"** so the reviewer sees exactly which servers were added, changed or removed.

## How to use it

### 1. Create the lock (on your machine)
```bash
npx github:rahulcs754/mcplock scan            # see risky settings
npx github:rahulcs754/mcplock lock --probe    # write mcp.lock (starts each server once to hash its tools)
git add mcp.lock && git commit -m "Add mcp.lock"
```
Leave out `--probe` to lock configs only (no server is started).

### 2. Add the GitHub Action
Create `.github/workflows/mcplock.yml` (also in [examples/workflow](examples/workflow/mcplock.yml)):
```yaml
name: MCPLock
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  mcplock:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: rahulcs754/mcplock@main
        with:
          probe: false # true = also compare tool lists
```

### 3. Protect the lock
Add `mcp.lock` to `CODEOWNERS` so a security owner must approve any change:
```
/mcp.lock  @your-org/security
```

### 4. Change a server
Edit `.mcp.json`, run `mcplock lock --probe`, commit both files. The PR comment lists the change for review.

## Commands
| Command | What it does | Exit code |
|---|---|---|
| `mcplock scan` | Risky settings only | 1 if a finding is at or above `failOn` |
| `mcplock lock [--probe]` | Write `mcp.lock`. Keeps tool hashes for servers whose config did not change | 0 |
| `mcplock check [--probe] [--base ref] [--comment]` | Risky settings + configs (and tools) vs `mcp.lock` | 1 on a finding, drift, or missing lock |

Other flags: `--root <dir>`, `--fail-on high|medium|low|none`, `--timeout <sec>` (probe, default 60), `--json`.

## Action inputs
| Input | Default | What it does |
|---|---|---|
| `command` | `check` | `check` or `scan` |
| `probe` | `false` | Start servers approved on the base branch and compare their tools |
| `base` | `origin/<PR base>` | Ref whose `mcp.lock` is trusted |
| `fail-on` | `high` | Lowest severity that fails |
| `comment` | `true` | Post or update one PR comment |
| `working-directory` | `.` | Folder with the configs and `mcp.lock` |
| `github-token` | `github.token` | Token for the comment |

The report is also written to the job summary.

## Rules
| Rule | Severity | Flags |
|---|---|---|
| `MCP001` Auto-approve | high | `autoApprove`, `alwaysAllow`, `"trust": true`, `enableAllProjectMcpServers` (`.claude/settings.json`), `chat.tools.autoApprove` (`.vscode/settings.json`) |
| `MCP002` Unpinned package | high | `npx`, `bunx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `uvx`, `uv tool run`, `pipx run` without an exact version; `docker run` with no tag (high) or a tag but no digest (low) |
| `MCP003` Raw shell | high | `bash -c`, `sh -c`, `cmd /c` or `powershell` with shell operators, `curl ... \| sh` |
| `MCP004` Secret in config | high | Known token formats (GitHub, OpenAI, Anthropic, AWS, Slack, Stripe, ...) and literal values in secret-named keys, in `env`, `headers`, `args` or the URL. Values are masked in the report |
| `MCP005` Plain http | medium | `http://` remote servers (localhost is fine) |

Values like `${env:TOKEN}`, `${TOKEN}`, `$TOKEN` and `${input:token}` are treated as safe placeholders.

## Files it reads
`.mcp.json` (Claude Code), `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.roo/mcp.json`, `.kiro/settings/mcp.json`, `.amazonq/mcp.json`, plus `.claude/settings.json`, `.claude/settings.local.json` and `.vscode/settings.json` for auto-approve flags. Comments and trailing commas are fine.

## Config: `mcplock.json`
```jsonc
{
  "failOn": "high",
  "allow": [{ "rule": "MCP002", "server": "playwright", "reason": "Pinned by Renovate" }],
  "include": ["tools/mcp.json"]
}
```

## `mcp.lock` format
```json
{
  "lockfileVersion": 1,
  "servers": {
    ".mcp.json#memory": {
      "file": ".mcp.json",
      "name": "memory",
      "transport": "stdio",
      "config": "sha256:4b1f...",
      "tools": { "create_entities": "sha256:9a0c...", "read_graph": "sha256:77de..." }
    }
  }
}
```
Only hashes are stored, never secret values.

## Probing notes
- Probe speaks MCP `initialize` + `tools/list` over stdio and streamable HTTP. Legacy SSE servers are locked by config only.
- `${VAR}` in `env`, `args`, `url` and `headers` is filled from the environment. Servers that need VS Code `${input:...}` values are skipped.
- A probe error is a warning, not a failure, so a flaky server does not block PRs.

## Develop
```bash
npm install
npm test          # vitest, includes a fake stdio and HTTP MCP server
npm run typecheck
npm run build     # bundles dist/cli.js (committed, used by the action)
```

## License
MIT
