import { mkdir, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { resolveFromConfig } from "../config/index.js";
import { REDACTED } from "../lib/redact.js";
import type { ProxyRequest, ProxyResponse, TraceConfig } from "../types/index.js";

interface ResolvedTraceConfig {
  dir: string;
  maxBodyBytes: number;
  redact: string[];
  includeResources: boolean;
}

/**
 * Resolve trace config. `fallbackRedact` is the `middleware.redact` list, used
 * when the trace block doesn't specify its own patterns.
 */
export function resolveTraceConfig(
  raw: boolean | TraceConfig | undefined,
  baseDir: string,
  fallbackRedact: string[],
): ResolvedTraceConfig | null {
  if (!raw) return null;
  const cfg = raw === true ? {} : raw;
  return {
    dir: cfg.dir ? resolveFromConfig(baseDir, cfg.dir) : join(tmpdir(), "better-mcp", "trace"),
    maxBodyBytes: cfg.maxBodyBytes ?? 0,
    redact: cfg.redact ?? fallbackRedact,
    includeResources: cfg.includeResources ?? false,
  };
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

/**
 * Like the `redact` middleware's key-based walk, but ALSO descends into
 * strings that are themselves JSON. MCP tool responses almost always wrap
 * their payload as a stringified JSON blob inside `content[].text`, so a
 * plain key walk never sees the secret-bearing keys. We re-stringify a
 * nested blob only when redaction actually changed it, to keep untouched
 * bodies byte-identical in the trace.
 */
function makeDeepRedact(patterns: string[]): (value: unknown) => unknown {
  if (patterns.length === 0) return (v) => v;
  const lowered = patterns.map((p) => p.toLowerCase());
  const shouldRedact = (key: string) => {
    const k = key.toLowerCase();
    return lowered.some((p) => k.includes(p));
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const t = value.trim();
      if (t.length > 1 && (t[0] === "{" || t[0] === "[")) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object") {
            const red = walk(parsed);
            const out = JSON.stringify(red);
            return out === JSON.stringify(parsed) ? value : out;
          }
        } catch {
          /* not embedded JSON — leave the string as-is */
        }
      }
      return value;
    }
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
  return walk;
}

/**
 * Tracer owns the per-file write queues so that concurrent calls to the SAME
 * tool serialize their appends (no interleaved partial lines). Every event is
 * a self-contained JSON line tagged with `callId`+`seq`, so even if the OS
 * interleaves lines across different tools' files, a single flow is always
 * reconstructable by sorting on (callId, seq).
 */
export class Tracer {
  private opts: ResolvedTraceConfig;
  private redactWalk: (v: unknown) => unknown;
  /** filepath → tail of the append chain for that file. */
  private queues = new Map<string, Promise<void>>();
  private dirReady?: Promise<void>;

  constructor(opts: ResolvedTraceConfig) {
    this.opts = opts;
    this.redactWalk = makeDeepRedact(opts.redact);
  }

  /** Begin a trace for one pipeline invocation, or null if this kind is skipped. */
  start(req: ProxyRequest): TraceSession | null {
    if (req.kind !== "tool" && !this.opts.includeResources) return null;
    const file = resolve(this.opts.dir, `${safeName(req.server)}__${safeName(req.name)}.jsonl`);
    return new TraceSession(this, file, req);
  }

  /** Redact + size-cap a body for inclusion in a trace event. */
  prepareBody(value: unknown): unknown {
    const redacted = this.redactWalk(value);
    const cap = this.opts.maxBodyBytes;
    if (cap > 0) {
      const json = safeJson(redacted);
      if (json !== null && json.length > cap) {
        return {
          truncated: true,
          bytes: json.length,
          sha256: createHash("sha256").update(json).digest("hex"),
          head: json.slice(0, cap),
        };
      }
    }
    return redacted;
  }

  /** Append one JSONL line, serialized per file. Never throws. */
  write(file: string, event: Record<string, unknown>): void {
    if (!this.dirReady) {
      this.dirReady = mkdir(this.opts.dir, { recursive: true }).then(() => undefined);
    }
    const line = JSON.stringify(event) + "\n";
    const prev = this.queues.get(file) ?? this.dirReady;
    const next = prev
      .then(() => appendFile(file, line, "utf8"))
      // Swallow write errors: tracing must never break a tool call, and the
      // chain must keep flowing for subsequent events on this file.
      .catch(() => undefined);
    this.queues.set(file, next);
  }
}

/** One in-flight invocation's trace. Methods are fire-and-forget. */
export class TraceSession {
  private tracer: Tracer;
  private file: string;
  private callId = randomUUID();
  private seq = 0;
  private base: { server: string; tool: string; kind: ProxyRequest["kind"] };

  constructor(tracer: Tracer, file: string, req: ProxyRequest) {
    this.tracer = tracer;
    this.file = file;
    this.base = { server: req.server, tool: req.name, kind: req.kind };
  }

  private emit(phase: string, extra: Record<string, unknown>): void {
    this.tracer.write(this.file, {
      ts: new Date().toISOString(),
      callId: this.callId,
      seq: this.seq++,
      ...this.base,
      phase,
      ...extra,
    });
  }

  request(req: ProxyRequest): void {
    this.emit("request", { params: this.tracer.prepareBody(req.params) });
  }

  before(mw: string, changed: boolean, durationMs: number, params: unknown, error?: string): void {
    this.emit("before", {
      mw,
      changed,
      durationMs,
      ...(changed ? { params: this.tracer.prepareBody(params) } : {}),
      ...(error ? { error } : {}),
    });
  }

  upstream(res: ProxyResponse): void {
    this.emit("upstream", {
      durationMs: res.durationMs,
      ok: !res.error,
      ...(res.error
        ? { error: res.error.message }
        : { result: this.tracer.prepareBody(res.result) }),
    });
  }

  after(mw: string, changed: boolean, durationMs: number, result: unknown, error?: string): void {
    this.emit("after", {
      mw,
      changed,
      durationMs,
      ...(changed ? { result: this.tracer.prepareBody(result) } : {}),
      ...(error ? { error } : {}),
    });
  }

  response(res: ProxyResponse, totalMs: number): void {
    this.emit("response", {
      totalMs,
      ...(res.error
        ? { error: res.error.message }
        : { result: this.tracer.prepareBody(res.result) }),
    });
  }
}

function safeJson(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}
