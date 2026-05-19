import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFromConfig } from "../config/index.js";
import type { MiddlewareHooks, OffloadConfig, ProxyRequest, ProxyResponse } from "../types/index.js";

const DEFAULT_THRESHOLD = 16 * 1024; // 16 KB
const MAX_SAMPLE = 200; // cap how many elements we sniff for type inference
// Recursion limit. Each level of array nesting counts as a step, so 4 is enough
// to render the common `Array<{ field: Array<{ name: string }> }>` case fully
// while still stopping runaway expansion.
const MAX_DEPTH = 4;

interface ResolvedOffloadConfig {
  thresholdBytes: number;
  dir: string;
  includeResources: boolean;
  inferArrayShape: boolean;
}

export function resolveOffloadConfig(
  raw: boolean | OffloadConfig | undefined,
  baseDir: string,
): ResolvedOffloadConfig | null {
  if (!raw) return null;
  const cfg = raw === true ? {} : raw;
  return {
    thresholdBytes: cfg.thresholdBytes ?? DEFAULT_THRESHOLD,
    dir: cfg.dir ? resolveFromConfig(baseDir, cfg.dir) : join(tmpdir(), "better-mcp"),
    includeResources: cfg.includeResources ?? false,
    inferArrayShape: cfg.inferArrayShape ?? true,
  };
}

/**
 * Middleware: if a tool (or, when configured, resource) response is bigger than
 * the threshold, write the full response to disk and replace it with a short
 * pointer message. When the underlying data is a JSON array, also infer a
 * compact TypeScript-style interface for its element type.
 */
export function makeOffloader(opts: ResolvedOffloadConfig): MiddlewareHooks {
  return {
    async after(req: ProxyRequest, res: ProxyResponse): Promise<ProxyResponse | void> {
      if (res.error) return;
      if (req.kind === "prompt") return;
      if (req.kind === "resource" && !opts.includeResources) return;

      const serialized = safeStringify(res.result);
      if (!serialized || serialized.length < opts.thresholdBytes) return;

      // Try to unwrap the typical MCP shape `{content: [{type: "text", text: "<JSON>"}]}`.
      // If we find a single JSON text block, we persist the parsed data instead
      // of the wrapper — much friendlier for whoever opens the file later.
      const unwrapped = tryUnwrapJsonContent(res.result);
      const dataToPersist: unknown = unwrapped ?? res.result;

      await mkdir(opts.dir, { recursive: true });
      const filename = buildFilename(req);
      const filepath = resolve(opts.dir, filename);
      await writeFile(filepath, JSON.stringify(dataToPersist, null, 2), "utf8");

      const lines: string[] = [
        `response exported to: ${filepath}`,
        `size: ${formatBytes(serialized.length)} (${serialized.length} bytes)`,
      ];

      if (Array.isArray(dataToPersist)) {
        lines.push(`length: ${dataToPersist.length}`);
        if (opts.inferArrayShape) {
          lines.push(`interface: ${inferArrayInterface(dataToPersist)}`);
        }
      }

      return {
        ...res,
        result: {
          content: [{ type: "text", text: lines.join("\n") }],
          isError: false,
        },
      };
    },
  };
}

// -- helpers ------------------------------------------------------------------

function safeStringify(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function buildFilename(req: ProxyRequest): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safe(req.server)}__${safe(req.name)}__${ts}.json`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * MCP tool responses commonly look like:
 *   { content: [{ type: "text", text: "<JSON>" }], isError: false }
 *
 * If the response matches that single-text-block shape AND the text parses as
 * JSON, return the parsed value. Otherwise return null and the caller will
 * persist the raw response object.
 */
function tryUnwrapJsonContent(result: unknown): unknown | null {
  if (!result || typeof result !== "object") return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (!block || typeof block !== "object") return null;
  const b = block as { type?: unknown; text?: unknown };
  if (b.type !== "text" || typeof b.text !== "string") return null;
  try {
    return JSON.parse(b.text);
  } catch {
    return null;
  }
}

// -- array interface inference -----------------------------------------------

/**
 * Build a TypeScript-style signature for the element type of `arr`, kept as
 * compact as possible (single line, no trailing whitespace, depth-capped).
 * Examples:
 *   [{id: 1, name: "x"}]               -> "Array<{ id: number; name: string }>"
 *   [{id: 1}, {id: 2, label: "y"}]     -> "Array<{ id: number; label?: string }>"
 *   [1, "two", 3]                       -> "Array<number | string>"
 *   []                                  -> "Array<unknown>"
 */
export function inferArrayInterface(arr: unknown[]): string {
  if (arr.length === 0) return "Array<unknown>";
  const sample = arr.length > MAX_SAMPLE ? sampleEvenly(arr, MAX_SAMPLE) : arr;
  return `Array<${inferType(sample, 0)}>`;
}

function sampleEvenly<T>(arr: T[], n: number): T[] {
  const step = arr.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

function inferType(values: unknown[], depth: number): string {
  if (depth >= MAX_DEPTH) return "unknown";

  let hasNull = false;
  const primitives = new Set<"string" | "number" | "boolean">();
  const objectKeys: Map<string, unknown[]> = new Map();
  let objectCount = 0;
  const arrayElements: unknown[] = [];
  let arrayCount = 0;

  for (const v of values) {
    if (v === null || v === undefined) {
      hasNull = true;
      continue;
    }
    if (Array.isArray(v)) {
      arrayCount++;
      arrayElements.push(...v);
      continue;
    }
    if (typeof v === "object") {
      objectCount++;
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        const bucket = objectKeys.get(k);
        if (bucket) bucket.push(vv);
        else objectKeys.set(k, [vv]);
      }
      continue;
    }
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") primitives.add(t);
  }

  const parts: string[] = [];
  if (primitives.has("string")) parts.push("string");
  if (primitives.has("number")) parts.push("number");
  if (primitives.has("boolean")) parts.push("boolean");
  if (arrayCount > 0) parts.push(`Array<${inferType(arrayElements, depth + 1)}>`);
  if (objectCount > 0) {
    const fields: string[] = [];
    for (const [k, vs] of objectKeys) {
      const optional = vs.length < objectCount;
      const fieldType = inferType(vs, depth + 1);
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      fields.push(`${safeKey}${optional ? "?" : ""}: ${fieldType}`);
    }
    parts.push(fields.length === 0 ? "Record<string, unknown>" : `{ ${fields.join("; ")} }`);
  }
  if (hasNull) parts.push("null");
  if (parts.length === 0) return "unknown";
  return parts.join(" | ");
}
