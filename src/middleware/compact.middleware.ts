import type { CompactConfig, MiddlewareHooks, ProxyRequest, ProxyResponse } from "../types/index.js";

export interface ResolvedCompactConfig {
  dropNull: boolean;
  dropEmptyString: boolean;
  dropEmptyArray: boolean;
  dropEmptyObject: boolean;
  roundFloats: number;
  exclude: Set<string>;
}

/**
 * `false` opts out (returns null). `undefined`/`true` enables defaults.
 * Otherwise merges user config over defaults.
 */
export function resolveCompactConfig(raw: boolean | CompactConfig | undefined): ResolvedCompactConfig | null {
  if (raw === false) return null;
  const cfg: CompactConfig = raw === true || raw === undefined ? {} : raw;
  return {
    dropNull: cfg.dropNull ?? true,
    dropEmptyString: cfg.dropEmptyString ?? false,
    dropEmptyArray: cfg.dropEmptyArray ?? false,
    dropEmptyObject: cfg.dropEmptyObject ?? false,
    roundFloats: Math.max(0, Math.floor(cfg.roundFloats ?? 0)),
    exclude: new Set(cfg.exclude ?? []),
  };
}

/**
 * Middleware: walks each tool/resource/prompt response's `content[]` blocks
 * and, for any `{type: "text", text: "<JSON>"}` block whose text parses as a
 * JSON object/array, drops empty-valued fields and re-stringifies minified.
 * Substitution only happens when the result is strictly shorter, so this is
 * idempotent on already-clean responses.
 */
export function makeCompactor(opts: ResolvedCompactConfig): MiddlewareHooks {
  return {
    async after(req: ProxyRequest, res: ProxyResponse): Promise<ProxyResponse | void> {
      if (res.error || res.result === undefined || res.result === null) return;
      if (isExcluded(req, opts.exclude)) return;
      const compacted = compactResponse(res.result, opts);
      if (compacted === res.result) return;
      return { ...res, result: compacted };
    },
  };
}

function isExcluded(req: ProxyRequest, exclude: Set<string>): boolean {
  if (exclude.size === 0) return false;
  if (exclude.has(req.server)) return true;
  return exclude.has(`${req.server}__${req.name}`);
}

/**
 * Walk `result.content[]`; for text blocks holding parseable JSON, replace
 * the text with the compacted-and-minified form (only when shorter). Returns
 * the same reference if nothing changed (so callers can early-exit).
 */
export function compactResponse(result: unknown, opts: ResolvedCompactConfig): unknown {
  if (!result || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;

  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== "text" || typeof b.text !== "string") return block;
    const newText = compactJsonString(b.text, opts);
    if (newText === b.text) return block;
    changed = true;
    return { ...block, text: newText };
  });
  if (!changed) return result;
  return { ...(result as object), content: next };
}

/**
 * If `text` is a JSON object/array, drop empty fields and re-stringify
 * minified. Returns the original string when there's no win (parse fails,
 * not an object/array, or the result isn't strictly shorter).
 */
export function compactJsonString(text: string, opts: ResolvedCompactConfig): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (parsed === null || typeof parsed !== "object") return text;
  const compacted = compactValue(parsed, opts);
  const minified = JSON.stringify(compacted);
  return minified.length < text.length ? minified : text;
}

/**
 * Recursively walk a JSON value. Drops object fields whose value satisfies
 * the configured "empty" predicates; preserves array length (we never drop
 * elements, only mutate them).
 */
export function compactValue(v: unknown, opts: ResolvedCompactConfig): unknown {
  if (Array.isArray(v)) return v.map((el) => compactValue(el, opts));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const c = compactValue(val, opts);
      if (shouldDrop(c, opts)) continue;
      out[k] = c;
    }
    return out;
  }
  if (typeof v === "number" && opts.roundFloats > 0) return roundFloat(v, opts.roundFloats);
  return v;
}

/**
 * Round a JSON number to `precision` decimal places. Integers and non-finite
 * values pass through (JSON.stringify already maps NaN/Infinity to null, so
 * we don't need to handle those specially). Returning via `Number(...toFixed)`
 * strips trailing zeros (`1.20` → `1.2`) for tighter serialization.
 */
function roundFloat(n: number, precision: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return n;
  return Number(n.toFixed(precision));
}

function shouldDrop(v: unknown, opts: ResolvedCompactConfig): boolean {
  if (v === null && opts.dropNull) return true;
  if (v === "" && opts.dropEmptyString) return true;
  if (Array.isArray(v) && v.length === 0 && opts.dropEmptyArray) return true;
  if (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v as object).length === 0 &&
    opts.dropEmptyObject
  ) {
    return true;
  }
  return false;
}
