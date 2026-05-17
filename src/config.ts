import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import type { ProxyConfig } from "./types.js";

/**
 * Expand a leading `~` / `~/…` to the user's home directory.
 *
 * MCP clients (Claude Code, Cursor, …) spawn this proxy directly via execvp,
 * NOT through a shell — so a config path like `~/.better-mcp.json` arrives as
 * the literal string `~/.better-mcp.json` and would otherwise resolve to
 * `<cwd>/~/.better-mcp.json`, fatally crashing the proxy before any upstream
 * connects.
 */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

interface LoadResult {
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
}

/**
 * Parse CLI args of the form `--config <path>` / `--config=<path>` / `-c <path>`,
 * `--no-namespace`, `--offload-resources`. Anything else is ignored.
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
    }
  }
  return out;
}

/** Truthy strings recognized by boolean-style env vars. */
function envTrue(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function validate(raw: unknown): ProxyConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be a JSON object.");
  }
  const cfg = raw as Partial<ProxyConfig>;
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") {
    throw new Error('Config must include an "mcpServers" object.');
  }
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    if (!server || typeof server !== "object" || typeof (server as { command?: unknown }).command !== "string") {
      throw new Error(`mcpServers.${name} must have a string "command".`);
    }
  }
  return {
    mcpServers: cfg.mcpServers,
    middleware: cfg.middleware,
    namespace: cfg.namespace ?? true,
  };
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
    return { config: apply(validate(parsed)), baseDir: dirname(abs), source: abs };
  }

  // 2. Env var (inline JSON or a path)
  const env = process.env.MCP_PROXY_CONFIG;
  if (env) {
    const trimmed = env.trim();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      return { config: apply(validate(parsed)), baseDir: process.cwd(), source: "MCP_PROXY_CONFIG (inline)" };
    }
    const expanded = expandTilde(trimmed);
    const abs = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    const parsed = await readJson(abs);
    return { config: apply(validate(parsed)), baseDir: dirname(abs), source: abs };
  }

  // 3 + 4. Default discovery
  const searchDirs = defaultSearchDirs(opts.entryDir);
  for (const dir of searchDirs) {
    const candidate = resolve(dir, DEFAULT_FILENAME);
    const parsed = await tryRead(candidate);
    if (parsed !== null) {
      return { config: apply(validate(parsed)), baseDir: dirname(candidate), source: candidate };
    }
  }

  throw new Error(
    `No config found. Looked for "${DEFAULT_FILENAME}" in:\n` +
      searchDirs.map((d) => `  - ${d}`).join("\n") +
      `\nPass --config <path> (or -c <path>), or set MCP_PROXY_CONFIG.`,
  );
}

/** Resolve a path that may be `~`-prefixed or relative to the config file's directory. */
export function resolveFromConfig(baseDir: string, p: string): string {
  const expanded = expandTilde(p);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/** Helper to dynamically import a user module by absolute path. */
export function fileUrlFor(absPath: string): string {
  return pathToFileURL(absPath).href;
}
