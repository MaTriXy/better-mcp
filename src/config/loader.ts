import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { interpolateEnvVars } from "../lib/env.js";
import { expandTilde } from "./paths.js";
import type { ListenConfig, McpServerConfig, ProxyConfig } from "../types/index.js";

export interface LoadResult {
  config: ProxyConfig;
  /** Directory used to resolve relative paths inside the config (e.g. hooks). */
  baseDir: string;
  /** Where the config was loaded from, for logging. */
  source: string;
}

interface LoadOptions {
  argv?: string[];
  /** Directory of the entry script — used for default `mcp.json` discovery. */
  entryDir?: string;
}

const DEFAULT_FILENAME = "mcp.json";

interface CliFlags {
  configPath?: string;
  noNamespace?: boolean;
  offloadResources?: boolean;
  listenPort?: number;
  listenHost?: string;
  listenPath?: string;
}

/**
 * Parse CLI args of the form `--config <path>` / `--config=<path>` / `-c <path>`,
 * `--no-namespace`, `--offload-resources`, and listen flags. Anything else is ignored.
 */
function parseCli(argv: string[]): CliFlags {
  const out: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-c") {
      out.configPath = argv[++i];
    } else if (a.startsWith("--config=")) {
      out.configPath = a.slice("--config=".length);
    } else if (a.startsWith("-c=")) {
      out.configPath = a.slice("-c=".length);
    } else if (a === "--no-namespace") {
      out.noNamespace = true;
    } else if (a === "--offload-resources") {
      out.offloadResources = true;
    } else if (a === "--listen") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.listenPort = parsePort(next, "--listen");
        i++;
      } else {
        out.listenPort = 3100;
      }
    } else if (a.startsWith("--listen=")) {
      out.listenPort = parsePort(a.slice("--listen=".length), "--listen");
    } else if (a === "--listen-host") {
      out.listenHost = argv[++i];
    } else if (a.startsWith("--listen-host=")) {
      out.listenHost = a.slice("--listen-host=".length);
    } else if (a === "--listen-path") {
      out.listenPath = argv[++i];
    } else if (a.startsWith("--listen-path=")) {
      out.listenPath = a.slice("--listen-path=".length);
    }
  }
  return out;
}

function parsePort(raw: string, flag: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag} requires a port between 1 and 65535, got "${raw}".`);
  }
  return port;
}

/** Truthy strings recognized by boolean-style env vars. */
function envTrue(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function validateServer(name: string, server: unknown): McpServerConfig {
  if (!server || typeof server !== "object") {
    throw new Error(`mcpServers.${name} must be an object.`);
  }
  const s = server as McpServerConfig;
  const hasCommand = typeof s.command === "string" && s.command.length > 0;
  const hasUrl = typeof s.url === "string" && s.url.length > 0;
  if (hasCommand === hasUrl) {
    throw new Error(`mcpServers.${name} must have exactly one of "command" or "url".`);
  }
  return s;
}

function validateListen(listen: unknown): ListenConfig {
  if (!listen || typeof listen !== "object") {
    throw new Error('"listen" must be an object.');
  }
  const l = listen as ListenConfig;
  if (typeof l.port !== "number" || !Number.isInteger(l.port) || l.port < 1 || l.port > 65535) {
    throw new Error('"listen.port" must be an integer between 1 and 65535.');
  }
  if (l.path !== undefined && (typeof l.path !== "string" || !l.path.startsWith("/"))) {
    throw new Error('"listen.path" must be a string starting with "/".');
  }
  if (l.host !== undefined && typeof l.host !== "string") {
    throw new Error('"listen.host" must be a string.');
  }
  if (l.auth !== undefined) {
    if (typeof l.auth !== "object" || l.auth === null) {
      throw new Error('"listen.auth" must be an object.');
    }
    if (l.auth.bearer !== undefined && typeof l.auth.bearer !== "string") {
      throw new Error('"listen.auth.bearer" must be a string.');
    }
  }
  return l;
}

function validate(raw: unknown): ProxyConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be a JSON object.");
  }
  const cfg = raw as Partial<ProxyConfig>;
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") {
    throw new Error('Config must include an "mcpServers" object.');
  }
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    mcpServers[name] = validateServer(name, server);
  }
  let listen: ListenConfig | undefined;
  if (cfg.listen !== undefined) {
    listen = validateListen(cfg.listen);
  }
  return {
    mcpServers,
    middleware: cfg.middleware,
    namespace: cfg.namespace ?? true,
    listen,
  };
}

function envPort(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  return parsePort(raw, name);
}

/** Merge listen settings from env vars and CLI flags onto the loaded config. */
function applyListenOverrides(cfg: ProxyConfig, cli: CliFlags): void {
  const envHost = process.env.BETTER_MCP_LISTEN_HOST;
  const envPortValue =
    envPort("BETTER_MCP_LISTEN_PORT") ?? envPort("BETTER_MCP_PORT");
  const envPath = process.env.BETTER_MCP_LISTEN_PATH;
  const envBearer =
    process.env.BETTER_MCP_LISTEN_BEARER ?? process.env.BETTER_MCP_TOKEN;

  const hasEnvListen = envHost !== undefined || envPortValue !== undefined || envPath !== undefined;
  const hasCliListen =
    cli.listenPort !== undefined || cli.listenHost !== undefined || cli.listenPath !== undefined;

  if (!cfg.listen && !hasEnvListen && !hasCliListen && !envTrue("BETTER_MCP_LISTEN")) {
    return;
  }

  cfg.listen = cfg.listen ?? { port: 3100 };
  if (envHost !== undefined) cfg.listen.host = envHost;
  if (envPath !== undefined) cfg.listen.path = envPath;
  if (envPortValue !== undefined) cfg.listen.port = envPortValue;
  if (envBearer !== undefined) {
    cfg.listen.auth = { ...cfg.listen.auth, bearer: envBearer };
  }

  if (cli.listenHost !== undefined) cfg.listen.host = cli.listenHost;
  if (cli.listenPath !== undefined) cfg.listen.path = cli.listenPath;
  if (cli.listenPort !== undefined) cfg.listen.port = cli.listenPort;

  if (envTrue("BETTER_MCP_LISTEN") && cli.listenPort === undefined && envPortValue === undefined) {
    cfg.listen.port = cfg.listen.port ?? 3100;
  }

  validateListen(cfg.listen);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function tryRead(path: string): Promise<unknown | null> {
  try {
    return await readJson(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Build the list of default search locations for `mcp.json`. The proxy looks
 * next to its own entry script first (matches the user's "its own folder"
 * mental model), then one level up (the common `dist/index.js` → project root
 * case), then the cwd as a final convenience.
 */
function defaultSearchDirs(entryDir: string | undefined): string[] {
  const dirs: string[] = [];
  if (entryDir) {
    dirs.push(entryDir);
    dirs.push(resolve(entryDir, ".."));
  }
  const cwd = process.cwd();
  if (!dirs.includes(cwd)) dirs.push(cwd);
  return dirs;
}

function finalizeConfig(raw: unknown, cli: CliFlags): ProxyConfig {
  const interpolated = interpolateEnvVars(raw);
  const cfg = validate(interpolated);
  applyListenOverrides(cfg, cli);
  return cfg;
}

/**
 * Load config in priority order:
 *   1. `-c <path>` / `--config <path>` CLI flag
 *   2. `MCP_PROXY_CONFIG` env var (raw JSON or a file path)
 *   3. `mcp.json` next to the proxy's entry script (or one level up)
 *   4. `mcp.json` in the current working directory
 */
export async function loadConfig(opts: LoadOptions = {}): Promise<LoadResult> {
  const argv = opts.argv ?? process.argv.slice(2);
  const cli = parseCli(argv);

  const apply = (cfg: ProxyConfig): ProxyConfig => {
    if (cli.noNamespace) cfg.namespace = false;

    // `--offload-resources` and `MCP_PROXY_OFFLOAD_RESOURCES=1` force-enable
    // includeResources on the offload middleware. They also implicitly turn on
    // offload if it wasn't configured at all (so the flag does something useful
    // even with a minimal mcp.json).
    if (cli.offloadResources || envTrue("MCP_PROXY_OFFLOAD_RESOURCES")) {
      cfg.middleware = cfg.middleware ?? {};
      const current = cfg.middleware.offload;
      const base = current === true ? {} : current === false || current === undefined ? {} : current;
      cfg.middleware.offload = { ...base, includeResources: true };
      if (current === undefined) cfg.middleware.offload = { ...cfg.middleware.offload };
    }
    return cfg;
  };

  // 1. CLI flag
  if (cli.configPath) {
    const expanded = expandTilde(cli.configPath);
    const abs = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    const parsed = await readJson(abs);
    return { config: apply(finalizeConfig(parsed, cli)), baseDir: dirname(abs), source: abs };
  }

  // 2. Env var (inline JSON or a path)
  const env = process.env.MCP_PROXY_CONFIG;
  if (env) {
    const trimmed = env.trim();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      return {
        config: apply(finalizeConfig(parsed, cli)),
        baseDir: process.cwd(),
        source: "MCP_PROXY_CONFIG (inline)",
      };
    }
    const expanded = expandTilde(trimmed);
    const abs = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    const parsed = await readJson(abs);
    return { config: apply(finalizeConfig(parsed, cli)), baseDir: dirname(abs), source: abs };
  }

  // 3 + 4. Default discovery
  const searchDirs = defaultSearchDirs(opts.entryDir);
  for (const dir of searchDirs) {
    const candidate = resolve(dir, DEFAULT_FILENAME);
    const parsed = await tryRead(candidate);
    if (parsed !== null) {
      return {
        config: apply(finalizeConfig(parsed, cli)),
        baseDir: dirname(candidate),
        source: candidate,
      };
    }
  }

  throw new Error(
    `No config found. Looked for "${DEFAULT_FILENAME}" in:\n` +
      searchDirs.map((d) => `  - ${d}`).join("\n") +
      `\nPass --config <path> (or -c <path>), or set MCP_PROXY_CONFIG.`,
  );
}
