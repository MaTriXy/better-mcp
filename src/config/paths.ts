import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

/**
 * Expand a leading `~` / `~/…` to the user's home directory.
 *
 * MCP clients (Claude Code, Cursor, …) spawn this proxy directly via execvp,
 * NOT through a shell — so a config path like `~/.better-mcp.json` arrives as
 * the literal string `~/.better-mcp.json` and would otherwise resolve to
 * `<cwd>/~/.better-mcp.json`, fatally crashing the proxy before any upstream
 * connects.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
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

/** Whether a bind host is loopback-only (no inbound auth required). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}
