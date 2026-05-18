/**
 * Shared types for @qelos/better-mcp.
 */

export interface McpServerConfig {
  /** Executable to spawn (e.g. "npx", "node", "python"). */
  command: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
  /** If false, skip this server. Defaults to true. */
  enabled?: boolean;
}

export interface MiddlewareConfig {
  /** Enable request/response logging. true = log to stderr, object = configured. */
  log?: boolean | { level?: "info" | "debug"; file?: string };
  /**
   * List of (case-insensitive) substrings of field names whose VALUES should be
   * replaced with "[REDACTED]" in both inbound args and outbound results.
   * e.g. ["password", "token", "api_key"].
   */
  redact?: string[];
  /**
   * Path (absolute or relative to config file) to a JS/MJS module that
   * default-exports a `{ before?, after? }` middleware object — see README.
   */
  hooks?: string;
  /**
   * Offload oversize responses to disk and return a short pointer instead.
   * `true` enables defaults. See OffloadConfig for the knobs.
   */
  offload?: boolean | OffloadConfig;
  /**
   * Write a per-tool JSONL trace of the full pipeline flow (request → each
   * middleware before → upstream → each middleware after → response).
   * `true` enables defaults. See TraceConfig for the knobs.
   */
  trace?: boolean | TraceConfig;
}

export interface TraceConfig {
  /**
   * Directory for per-tool trace files (`<server>__<name>.jsonl`). Path may be
   * absolute, `~`-prefixed, or relative to the config file.
   * Default: <os.tmpdir()>/better-mcp/trace.
   */
  dir?: string;
  /**
   * Cap each captured body (params/result) to this many bytes; larger bodies
   * are replaced with a `{ truncated, bytes, sha256, head }` placeholder.
   * 0 or omitted = no cap (full bodies).
   */
  maxBodyBytes?: number;
  /**
   * Field-name substrings whose values are redacted before a body is written.
   * Defaults to the `redact` list above (the tracer sees raw pre-redaction
   * data, so it must scrub independently). Set `[]` to disable.
   */
  redact?: string[];
  /**
   * Also trace resource reads and prompt gets. Tools are always traced.
   * Default: false.
   */
  includeResources?: boolean;
}

export interface OffloadConfig {
  /**
   * Responses whose JSON-stringified size exceeds this many bytes get written
   * to a file and replaced with a pointer. Default: 16384 (16 KB).
   */
  thresholdBytes?: number;
  /**
   * Directory for exported responses. Path may be absolute or relative to the
   * config file. Default: <os.tmpdir()>/better-mcp.
   */
  dir?: string;
  /**
   * If true, also offload resources/read responses. Tool responses are always
   * offloaded when oversize. Prompt responses are never offloaded.
   * Overridden by `--offload-resources` CLI flag or `MCP_PROXY_OFFLOAD_RESOURCES=1`.
   * Default: false.
   */
  includeResources?: boolean;
  /**
   * If true and the offloaded data is a JSON array, include a TypeScript-style
   * interface for its element in the pointer message. Default: true.
   */
  inferArrayShape?: boolean;
}

export interface ProxyConfig {
  mcpServers: Record<string, McpServerConfig>;
  middleware?: MiddlewareConfig;
  /** Prefix each upstream tool/resource/prompt with `<serverName>__`. Default true. */
  namespace?: boolean;
}

/** A single proxied invocation, passed through the middleware pipeline. */
export interface ProxyRequest {
  /** Which upstream server is being addressed. */
  server: string;
  /** Which primitive: tool call, resource read, prompt get. */
  kind: "tool" | "resource" | "prompt";
  /** Original (un-namespaced) name on the upstream server. */
  name: string;
  /** Arguments / URI / prompt args as appropriate. */
  params: unknown;
  /** Free-form metadata middleware may attach. */
  meta?: Record<string, unknown>;
}

export interface ProxyResponse {
  /** The raw response from the upstream server (already JSON-shaped). */
  result: unknown;
  /** Wall-clock duration of the upstream call in ms. */
  durationMs: number;
  /** If the upstream threw, this carries the error (result will be undefined). */
  error?: { message: string; data?: unknown };
}

/**
 * Hook contract for user-supplied middleware modules.
 * Either may return a modified request/response, or void to leave unchanged.
 * Throwing inside a hook short-circuits and surfaces as an MCP error.
 */
export interface MiddlewareHooks {
  before?: (req: ProxyRequest) => Promise<ProxyRequest | void> | ProxyRequest | void;
  after?: (
    req: ProxyRequest,
    res: ProxyResponse,
  ) => Promise<ProxyResponse | void> | ProxyResponse | void;
}
