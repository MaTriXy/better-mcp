import { resolveFromConfig } from "../config/index.js";
import { makeCleanText, resolveCleanTextConfig } from "./cleantext.middleware.js";
import { makeCompactor, resolveCompactConfig } from "./compact.middleware.js";
import { makeDedup, resolveDedupConfig } from "./dedup.middleware.js";
import { makeLogger } from "./logger.middleware.js";
import { makeOffloader, resolveOffloadConfig } from "./offload.middleware.js";
import { makeRedactor } from "./redactor.middleware.js";
import { Tracer, resolveTraceConfig } from "./trace.middleware.js";
import { loadUserHooks } from "./user-hooks.middleware.js";
import type {
  MiddlewareConfig,
  MiddlewareHooks,
  ProxyRequest,
  ProxyResponse,
} from "../types/index.js";

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
 * Registration order is [logger, dedup, cleantext, compact, offloader, redactor, user],
 * so for `after`:
 *   - user runs first (sees raw upstream response, can transform it)
 *   - redactor runs next (cleans secrets)
 *   - offloader runs next (writes redacted data to disk, replaces response
 *     with a pointer message when oversize)
 *   - compact runs next (shrinks the inline response by dropping null/empty
 *     fields and minifying JSON-in-text; no-op on offloaded pointers)
 *   - cleantext runs next (strips ANSI/trailing whitespace from remaining
 *     non-JSON text; idempotent on minified JSON and on offload pointers)
 *   - dedup runs next (hashes the final wire bytes; on cache hit replaces the
 *     response with a short `same response as Xs ago` pointer)
 *   - logger runs last (records the final response the client receives)
 *
 * Compact and cleantext are registered before offloader so the persisted file
 * holds the original full-fidelity payload; only the wire response is shrunk.
 * Dedup is registered after them so its hash covers the bytes the client
 * actually receives.
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
    const dedupOpts = resolveDedupConfig(cfg?.dedup);
    if (dedupOpts) p.hooks.push({ name: "dedup", impl: makeDedup(dedupOpts) });
    const cleanOpts = resolveCleanTextConfig(cfg?.cleantext);
    if (cleanOpts) p.hooks.push({ name: "cleantext", impl: makeCleanText(cleanOpts) });
    const compactOpts = resolveCompactConfig(cfg?.compact);
    if (compactOpts) p.hooks.push({ name: "compact", impl: makeCompactor(compactOpts) });
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
