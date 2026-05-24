/**
 * Shared types for @qelos/better-mcp.
 */

export interface McpServerConfig {
  /** Executable to spawn (e.g. "npx", "node", "python"). Required unless `url` is set. */
  command?: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
  /** If false, skip this server. Defaults to true. */
  enabled?: boolean;
  /**
   * Remote MCP server URL (Streamable HTTP). Required unless `command` is set.
   * Supports `${ENV_VAR}` interpolation.
   */
  url?: string;
  /** Extra HTTP headers for remote upstreams (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface ListenAuthConfig {
  /** Bearer token clients must send as `Authorization: Bearer …`. */
  bearer?: string;
}

export interface ListenConfig {
  /** Bind address. Default 127.0.0.1. Use 0.0.0.0 for containers/k8s. */
  host?: string;
  /** TCP port to listen on. */
  port: number;
  /** HTTP path for MCP Streamable HTTP. Default /mcp. */
  path?: string;
  /** Inbound auth. Required when host is not loopback unless disabled explicitly. */
  auth?: ListenAuthConfig;
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
  /**
   * Slim down the `tools/list` response by stripping JSON-Schema noise (and
   * optionally capping descriptions / dropping duplicate property descriptions).
   * Defaults to ON with safe strips; set `false` to disable. See SlimConfig.
   */
  slim?: boolean | SlimConfig;
  /**
   * Compact the JSON inside `content[].text` of each response: drop
   * null-valued fields (configurable) and re-stringify minified. Default ON
   * with `dropNull: true`; set `false` to disable. The file written by
   * `offload` is unaffected — compact only changes what the client receives.
   * See CompactConfig.
   */
  compact?: boolean | CompactConfig;
  /**
   * Strip terminal-style noise from `content[].text` blocks: ANSI escape
   * sequences (e.g. `\x1b[31m`) and trailing whitespace per line. Default
   * ON; set `false` to disable. See CleanTextConfig.
   */
  cleantext?: boolean | CleanTextConfig;
  /**
   * Hash-based response cache. When the same `(server, tool, response-bytes)`
   * is seen within `ttlSeconds`, the response is replaced with a short
   * pointer like `same response as 5s ago (sha:abc12345)`. Polling-style
   * tools dedup well; tools whose responses embed timestamps / request IDs
   * never will. Default OFF (opt-in). See DedupConfig.
   */
  dedup?: boolean | DedupConfig;
}

export interface DedupConfig {
  /** Time-to-live in seconds for a cached entry. Default: 300. */
  ttlSeconds?: number;
  /** Hard cap on entries (LRU eviction on insert). Default: 1000. */
  maxEntries?: number;
  /**
   * Skip dedup when the serialized response is smaller than this many bytes.
   * The pointer itself is ~40 bytes — no point replacing a 50-byte response
   * with one. Default: 200.
   */
  minBytes?: number;
  /**
   * Also dedup `resources/read` responses. Tools are always considered;
   * prompts never are. Default: false.
   */
  includeResources?: boolean;
  /**
   * Skip dedup for these servers or specific tools. Match by:
   *   - `"<server>"` to disable for every tool on that upstream
   *   - `"<server>__<tool>"` to disable for one tool only
   */
  exclude?: string[];
}

export interface CleanTextConfig {
  /** Strip ANSI/CSI escape sequences. Default: true. */
  stripAnsi?: boolean;
  /** Strip trailing whitespace at end of each line. Default: true. */
  trimTrailingWhitespace?: boolean;
  /** Collapse 3+ consecutive blank lines to 2. Default: false (risky for markdown). */
  collapseBlankLines?: boolean;
  /**
   * Skip cleaning for these servers or specific tools. Match by:
   *   - `"<server>"` to disable for every tool on that upstream
   *   - `"<server>__<tool>"` to disable for one tool only
   */
  exclude?: string[];
}

export interface CompactConfig {
  /** Drop fields whose value is `null`. Default: true. */
  dropNull?: boolean;
  /** Drop fields whose value is `""`. Default: false. */
  dropEmptyString?: boolean;
  /** Drop fields whose value is `[]`. Default: false. */
  dropEmptyArray?: boolean;
  /** Drop fields whose value is `{}`. Default: false. */
  dropEmptyObject?: boolean;
  /**
   * Round JSON numbers to this many decimal places. Integers and non-finite
   * values (NaN/Infinity → serialized as `null` anyway) are untouched.
   * `0` or omitted disables. Default: 0.
   *
   * NOTE: rounding is semantically opinionated — `0.123456` → `0.1235` is
   * fine for ML scores, lossy for high-precision geocoordinates. Opt in once
   * you know your tools tolerate it.
   */
  roundFloats?: number;
  /**
   * Skip compaction for these servers or specific tools. Match by:
   *   - `"<server>"` to disable for every tool on that upstream
   *   - `"<server>__<tool>"` to disable for one tool only
   * (Uses the same `__` separator as the namespaced public tool name.)
   */
  exclude?: string[];
}

export interface SlimConfig {
  /**
   * JSON-Schema fields to strip from every tool's inputSchema (recursive).
   * Default: ["$schema", "$id", "$comment", "title", "examples", "default"].
   * `required: []` and `enum: []` are always dropped when empty.
   */
  stripSchemaFields?: string[];
  /**
   * Drop a property's `description` when it's a short paraphrase of the
   * property name (e.g. `userId` → "The user id"). Heuristic, not exhaustive.
   * Default: false.
   */
  stripPropertyDescriptions?: boolean;
  /**
   * Truncate each tool's top-level `description` to this many characters
   * (with a trailing `…`). 0 disables. Default: 0.
   */
  maxDescriptionLength?: number;
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
  /**
   * When the offloaded data is a JSON array, include a compact `preview:` line
   * showing the first N items. Homogeneous object arrays are rendered as
   * `{cols:[...],rows:[[...]]}`; primitive/mixed arrays as a JSON sample.
   * 0 disables. Default: 3.
   */
  previewRows?: number;
  /**
   * When the offloaded data is a long markdown text, also split it on H2
   * headings (`^## `) into per-chapter files alongside the full `.md` file,
   * and return a TOC pointer instead of the standard `response exported to`.
   * Code blocks are honoured (a `## ` inside ```` ``` ```` won't trigger a
   * split). Falls back to the standard JSON-wrapper behaviour when no H2
   * headings are present. Default: true.
   */
  chapterMarkdown?: boolean;
  /**
   * Override offload behaviour for specific servers or tools. Keys match
   * `"<server>"` (every tool on that upstream) or `"<server>__<tool>"` (one
   * tool); `<server>__<tool>` wins over `<server>` when both match.
   *
   * Value is either:
   *   - An object with any subset of `{ thresholdBytes, chapterMarkdown,
   *     inferArrayShape, previewRows }` — merged over the global config
   *     for matching calls.
   *   - `false` — skip offload entirely for that server/tool.
   *
   * Use `{ thresholdBytes: 0 }` to "always offload" a tool that consistently
   * returns large output (e.g. `fs__list_directory`).
   */
  perTool?: Record<string, PerToolOverride | false>;
}

export interface PerToolOverride {
  /** Override the global threshold for this server/tool. 0 = always offload. */
  thresholdBytes?: number;
  /** Override `chapterMarkdown` for this server/tool. */
  chapterMarkdown?: boolean;
  /** Override `inferArrayShape` for this server/tool. */
  inferArrayShape?: boolean;
  /** Override `previewRows` for this server/tool. */
  previewRows?: number;
}

export interface ProxyConfig {
  mcpServers: Record<string, McpServerConfig>;
  middleware?: MiddlewareConfig;
  /** Prefix each upstream tool/resource/prompt with `<serverName>__`. Default true. */
  namespace?: boolean;
  /** Expose the proxy over HTTP (Streamable HTTP / SSE) on the network. */
  listen?: ListenConfig;
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
