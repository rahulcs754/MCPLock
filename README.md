# MCPLock

**A lockfile and PR check for MCP server configs.** MCPLock scans `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json` in your repo, flags risky settings, and writes `mcp.lock` so any change to a server (or its tools) fails the PR until someone reviews it.

Status: planning. The MVP is being built in a pull request.

## Why
MCP configs in a repo run commands on every teammate's laptop. One changed line, an unpinned `npx` package, or a server that silently changes its tools can hijack a developer machine. See [docs/RESEARCH.md](docs/RESEARCH.md).

## Plan
See [docs/MVP-PLAN.md](docs/MVP-PLAN.md).

## License
MIT
