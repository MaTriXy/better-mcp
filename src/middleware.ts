import { appendFile } from "node:fs/promises";
import { resolveFromConfig, fileUrlFor } from "./config.js";
import { makeOffloader, resolveOffloadConfig } from "./offload.js";
import { makeRedactWalk } from "./redact.js";
import { Tracer, resolveTraceConfig } from "./trace.js";
import type {
  MiddlewareConfig,
  MiddlewareHooks,
  ProxyRequest,
  ProxyResponse,
} from "./types.js";

/** A registered middleware plus the name the tracer labels its steps with. */
interface NamedHook {
  name: string;
  impl: MiddlewareHooks;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  private hooks: NamedHook[] = [];
  private tracer: Tracer | null = null;

  /** Build a pipeline from declarative config and an optional baseDir. */
  static async build(cfg: MiddlewareConfig | undefined, baseDir: string): Promise<MiddlewarePipeline> {
    const p = new MiddlewarePipeline();

    if (cfg?.log) {
      const logCfg = typeof cfg.log === "object" ? cfg.log : {};
      p.hooks.push({ name: "log", impl: makeLogger(logCfg.level ?? "info", logCfg.file) });
    }
    if (cfg?.offload) {
      const opts = resolveOffloadConfig(cfg.offload, baseDir);
      if (opts) p.hooks.push({ name: "offload", impl: makeOffloader(opts) });
    }
    if (cfg?.redact && cfg.redact.length > 0) {
      p.hooks.push({ name: "redact", impl: makeRedactor(cfg.redact) });
    }
    if (cfg?.hooks) {
      const userHooks = await loadUserHooks(resolveFromConfig(baseDir, cfg.hooks));
      p.hooks.push({ name: "user", impl: userHooks });
    }

    const traceCfg = resolveTraceConfig(cfg?.trace, baseDir, cfg?.redact ?? []);
    if (traceCfg) p.tracer = new Tracer(traceCfg);
    return p;
  }

  /** Wrap an upstream call in the middleware pipeline. */
  async invoke(
    req: ProxyRequest,
    upstream: (req: ProxyRequest) => Promise<unknown>,
  ): Promise<ProxyResponse> {
    const invokeStart = Date.now();
    const session = this.tracer?.start(req) ?? null;
    session?.request(req);

    let current: ProxyRequest = req;
    // before phase: outer → inner
    for (const h of this.hooks) {
      if (!h.impl.before) continue;
      const t0 = Date.now();
      let next: ProxyRequest | void;
      try {
        next = await h.impl.before(current);
      } catch (err) {
        // Record the failing step, then preserve existing semantics: a throwing
        // before-hook aborts the call and surfaces as an MCP error.
        session?.before(h.name, false, Date.now() - t0, undefined, errMsg(err));
        throw err;
      }
      const changed = next !== undefined && next !== null;
      if (changed) current = next as ProxyRequest;
      session?.before(h.name, changed, Date.now() - t0, current.params);
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
          message: errMsg(err),
          data: err instanceof Error ? { name: err.name, stack: err.stack } : undefined,
        },
      };
    }
    session?.upstream(res);

    // after phase: inner → outer
    for (let i = this.hooks.length - 1; i >= 0; i--) {
      const h = this.hooks[i];
      if (!h.impl.after) continue;
      const t0 = Date.now();
      let next: ProxyResponse | void;
      try {
        next = await h.impl.after(current, res);
      } catch (err) {
        session?.after(h.name, false, Date.now() - t0, undefined, errMsg(err));
        throw err;
      }
      const changed = next !== undefined && next !== null;
      if (changed) res = next as ProxyResponse;
      session?.after(h.name, changed, Date.now() - t0, res.result);
    }

    session?.response(res, Date.now() - invokeStart);
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
  const walk = makeRedactWalk(patterns);
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
