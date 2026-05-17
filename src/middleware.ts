import { appendFile } from "node:fs/promises";
import { resolveFromConfig, fileUrlFor } from "./config.js";
import { makeOffloader, resolveOffloadConfig } from "./offload.js";
import type {
  MiddlewareConfig,
  MiddlewareHooks,
  ProxyRequest,
  ProxyResponse,
} from "./types.js";

const REDACTED = "[REDACTED]";

/**
 * The middleware pipeline runs a stack of hooks around each upstream call:
 *
 *   before:  outer  →  inner  →  (upstream call)
 *   after:           (upstream)  →  inner  →  outer
 *
 * Registration order is [logger, offloader, redactor, user], so for `after`:
 *   - user runs first (sees raw upstream response, can transform it)
 *   - redactor runs next (cleans secrets)
 *   - offloader runs next (writes redacted data to disk, replaces response
 *     with a pointer message when oversize)
 *   - logger runs last (records the final, small response the client receives)
 */
export class MiddlewarePipeline {
  private hooks: MiddlewareHooks[] = [];

  /** Build a pipeline from declarative config and an optional baseDir. */
  static async build(cfg: MiddlewareConfig | undefined, baseDir: string): Promise<MiddlewarePipeline> {
    const p = new MiddlewarePipeline();

    if (cfg?.log) {
      const logCfg = typeof cfg.log === "object" ? cfg.log : {};
      p.hooks.push(makeLogger(logCfg.level ?? "info", logCfg.file));
    }
    if (cfg?.offload) {
      const opts = resolveOffloadConfig(cfg.offload, baseDir);
      if (opts) p.hooks.push(makeOffloader(opts));
    }
    if (cfg?.redact && cfg.redact.length > 0) {
      p.hooks.push(makeRedactor(cfg.redact));
    }
    if (cfg?.hooks) {
      const userHooks = await loadUserHooks(resolveFromConfig(baseDir, cfg.hooks));
      p.hooks.push(userHooks);
    }
    return p;
  }

  /** Wrap an upstream call in the middleware pipeline. */
  async invoke(
    req: ProxyRequest,
    upstream: (req: ProxyRequest) => Promise<unknown>,
  ): Promise<ProxyResponse> {
    let current: ProxyRequest = req;
    // before phase: outer → inner
    for (const m of this.hooks) {
      if (m.before) {
        const next = await m.before(current);
        if (next) current = next;
      }
    }

    let res: ProxyResponse;
    const start = Date.now();
    try {
      const result = await upstream(current);
      res = { result, durationMs: Date.now() - start };
    } catch (err) {
      res = {
        result: undefined,
        durationMs: Date.now() - start,
        error: {
          message: err instanceof Error ? err.message : String(err),
          data: err instanceof Error ? { name: err.name, stack: err.stack } : undefined,
        },
      };
    }

    // after phase: inner → outer
    for (let i = this.hooks.length - 1; i >= 0; i--) {
      const m = this.hooks[i];
      if (m.after) {
        const next = await m.after(current, res);
        if (next) res = next;
      }
    }
    return res;
  }
}

// -- built-in: logger ---------------------------------------------------------

function makeLogger(level: "info" | "debug", file?: string): MiddlewareHooks {
  const write = async (line: string) => {
    if (file) {
      await appendFile(file, line + "\n", "utf8");
    } else {
      // Stderr is safe to write to in an stdio MCP server (stdout is for protocol).
      process.stderr.write(line + "\n");
    }
  };
  return {
    async before(req) {
      const entry = {
        ts: new Date().toISOString(),
        dir: "request",
        server: req.server,
        kind: req.kind,
        name: req.name,
        ...(level === "debug" ? { params: req.params } : {}),
      };
      await write(JSON.stringify(entry));
    },
    async after(req, res) {
      const entry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        dir: "response",
        server: req.server,
        kind: req.kind,
        name: req.name,
        durationMs: res.durationMs,
      };
      if (res.error) entry.error = res.error.message;
      if (level === "debug") entry.result = res.result;
      await write(JSON.stringify(entry));
    },
  };
}

// -- built-in: redactor -------------------------------------------------------

function makeRedactor(patterns: string[]): MiddlewareHooks {
  const lowered = patterns.map((p) => p.toLowerCase());
  const shouldRedact = (key: string) => {
    const k = key.toLowerCase();
    return lowered.some((p) => k.includes(p));
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = shouldRedact(k) ? REDACTED : walk(v);
      }
      return out;
    }
    return value;
  };
  return {
    after(_req, res) {
      if (res.error) return res;
      return { ...res, result: walk(res.result) };
    },
  };
}

// -- user hooks ---------------------------------------------------------------

async function loadUserHooks(absPath: string): Promise<MiddlewareHooks> {
  const mod = (await import(fileUrlFor(absPath))) as {
    default?: MiddlewareHooks;
    before?: MiddlewareHooks["before"];
    after?: MiddlewareHooks["after"];
  };
  // Accept either `export default { before, after }` or named exports.
  if (mod.default && (mod.default.before || mod.default.after)) {
    return mod.default;
  }
  if (mod.before || mod.after) {
    return { before: mod.before, after: mod.after };
  }
  throw new Error(
    `Middleware module at ${absPath} did not export before/after hooks. ` +
      'Expected `export default { before, after }` or named exports.',
  );
}
