export type Severity = 'high' | 'medium' | 'low';
export type Transport = 'stdio' | 'http' | 'sse';

/** One MCP server found in a repo config file. */
export interface ServerEntry {
  /** Stable key: "<file>#<name>". */
  id: string;
  file: string;
  name: string;
  transport: Transport;
  /** The raw server object from the config file. */
  config: Record<string, unknown>;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  server?: string;
  message: string;
  fix: string;
}

export interface ScanResult {
  files: string[];
  servers: ServerEntry[];
  findings: Finding[];
  /** Files we found but could not parse. */
  errors: Array<{ file: string; message: string }>;
}

export interface LockServer {
  file: string;
  name: string;
  transport: Transport;
  /** sha256 of the canonical server config. */
  config: string;
  /** Tool name -> sha256 of the tool definition. Only set after a probe. */
  tools?: Record<string, string>;
}

export interface LockFile {
  lockfileVersion: 1;
  servers: Record<string, LockServer>;
}

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export type DriftKind = 'added' | 'removed' | 'config-changed' | 'tools-changed';

export interface Drift {
  kind: DriftKind;
  id: string;
  file: string;
  name: string;
  message: string;
  /** For tools-changed. */
  tools?: { added: string[]; removed: string[]; changed: string[] };
}

export interface ProbeNote {
  id: string;
  status: 'ok' | 'skipped' | 'error';
  message: string;
}
