# Why MCPLock

AI coding tools (Claude Code, Cursor, VS Code Copilot, Gemini CLI) now read MCP server configs that live **inside the repo**: `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`. When a developer opens the repo, these servers start on their laptop with their credentials.

That makes an MCP config file a piece of code that runs on every teammate's machine, but today nobody reviews it like code.

## The problems
- **Config hijack.** A PR changes one line in `.mcp.json` (a new `command`, a new package) and every teammate runs it on next open.
- **Unpinned packages.** `npx -y some-mcp-server` pulls whatever version is newest today. A hijacked npm release runs with no PR at all.
- **Auto-approve.** Settings like `autoApprove`, `alwaysAllow`, `trust: true` or `enableAllProjectMcpServers` let tools run with no human click.
- **Secrets in git.** API keys pasted into the `env` block get committed.
- **Rug pulls / tool poisoning.** A server that was safe last week changes its tool names or descriptions (where prompt-injection text hides). Nothing in the repo changes, so no review happens.
- Many MCP CVEs in 2025-2026 came from exactly these paths: command injection in configs, poisoned tool descriptions, and silent package updates.

## Existing tools
- `mcp-scan` style scanners check a machine once. They are not a PR gate and do not lock anything.
- Dependabot / npm audit do not understand MCP config files.
- Nothing gives MCP servers what `package-lock.json` gives packages: a reviewed, hashed snapshot that fails CI when it drifts.

## The idea
MCPLock is a CLI + GitHub Action:
1. **Scan** MCP config files in the repo and flag risky settings.
2. **Lock**: write `mcp.lock` with a hash of each server's config and (optionally) its tool list.
3. **Check** on every PR: fail if a config or a server's tools changed without an updated, reviewed `mcp.lock`.
