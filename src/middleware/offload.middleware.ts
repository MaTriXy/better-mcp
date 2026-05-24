import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFromConfig } from "../config/index.js";
import type {
  MiddlewareHooks,
  OffloadConfig,
  PerToolOverride,
  ProxyRequest,
  ProxyResponse,
} from "../types/index.js";

const DEFAULT_THRESHOLD = 16 * 1024; // 16 KB
const MAX_SAMPLE = 200; // cap how many elements we sniff for type inference
// Recursion limit. Each level of array nesting counts as a step, so 4 is enough
// to render the common `Array<{ field: Array<{ name: string }> }>` case fully
// while still stopping runaway expansion.
const MAX_DEPTH = 4;
const DEFAULT_PREVIEW_ROWS = 3;
// Per-cell stringification cap for the tabular preview. One huge field
// shouldn't blow up the pointer.
const PREVIEW_CELL_MAX = 80;
// Skip tabular preview when the union of object keys exceeds this — very
// wide rows cost more tokens than the preview saves.
const PREVIEW_MAX_COLS = 12;

export interface ResolvedOffloadConfig {
  thresholdBytes: number;
  dir: string;
  includeResources: boolean;
  inferArrayShape: boolean;
  previewRows: number;
  chapterMarkdown: boolean;
  /**
   * Per-server / per-tool overrides, keyed by `<server>` or `<server>__<tool>`.
   * `false` means "skip offload entirely for this match"; an object is merged
   * into the base config for matching calls.
   */
  perTool: Map<string, PerToolOverride | false>;
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
    previewRows: cfg.previewRows ?? DEFAULT_PREVIEW_ROWS,
    chapterMarkdown: cfg.chapterMarkdown ?? true,
    perTool: new Map(Object.entries(cfg.perTool ?? {})),
  };
}

/**
 * Look up `<server>__<tool>` (specific) then `<server>` (whole-server) in the
 * perTool map. Returns:
 *   - `null` when the match value is `false` → caller should skip offload.
 *   - A new ResolvedOffloadConfig with overrides merged on top of base when
 *     an object override matches.
 *   - The unchanged base when there's no match (cheap pass-through).
 */
export function effectiveOffloadConfig(
  base: ResolvedOffloadConfig,
  req: ProxyRequest,
): ResolvedOffloadConfig | null {
  if (base.perTool.size === 0) return base;
  const toolKey = `${req.server}__${req.name}`;
  const override = base.perTool.get(toolKey) ?? base.perTool.get(req.server);
  if (override === undefined) return base;
  if (override === false) return null;
  return {
    ...base,
    thresholdBytes: override.thresholdBytes ?? base.thresholdBytes,
    chapterMarkdown: override.chapterMarkdown ?? base.chapterMarkdown,
    inferArrayShape: override.inferArrayShape ?? base.inferArrayShape,
    previewRows: override.previewRows ?? base.previewRows,
  };
}

/**
 * Middleware: if a tool (or, when configured, resource) response is bigger than
 * the threshold, write the full response to disk and replace it with a short
 * pointer message. When the underlying data is a JSON array, also infer a
 * compact TypeScript-style interface for its element type.
 */
export function makeOffloader(baseOpts: ResolvedOffloadConfig): MiddlewareHooks {
  return {
    async after(req: ProxyRequest, res: ProxyResponse): Promise<ProxyResponse | void> {
      if (res.error) return;
      if (req.kind === "prompt") return;
      if (req.kind === "resource" && !baseOpts.includeResources) return;

      // Apply per-tool / per-server overrides (or short-circuit when set to false).
      const opts = effectiveOffloadConfig(baseOpts, req);
      if (opts === null) return;

      const serialized = safeStringify(res.result);
      if (!serialized || serialized.length < opts.thresholdBytes) return;

      // Branch 1: long single-text payload that looks like chaptered markdown.
      // We persist it as `.md` with per-chapter sidecar files for easy lookup
      // on follow-up turns.
      if (opts.chapterMarkdown) {
        const text = tryUnwrapTextContent(res.result);
        if (text !== null) {
          const chapters = splitMarkdownChapters(text);
          if (chapters.length > 1) {
            const pointer = await writeMarkdownChapters(opts, req, text, chapters, serialized.length);
            return {
              ...res,
              result: {
                content: [{ type: "text", text: pointer }],
                isError: false,
              },
            };
          }
        }
      }

      // Branch 2: standard JSON-or-wrapper offload. Try to unwrap the typical
      // MCP shape `{content: [{type: "text", text: "<JSON>"}]}`. If we find a
      // single JSON text block, persist the parsed data instead of the wrapper.
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
        const preview = buildPreview(dataToPersist, opts.previewRows);
        if (preview) lines.push(`preview: ${preview}`);
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

/**
 * Persist a markdown payload as `<base>.md` plus one `.md` sidecar per
 * chapter, and build the TOC pointer. If any chapter write fails we fall
 * back gracefully: the full file is still on disk, and the pointer just
 * omits the failed chapter rather than tearing the whole call down.
 */
async function writeMarkdownChapters(
  opts: ResolvedOffloadConfig,
  req: ProxyRequest,
  fullText: string,
  chapters: MarkdownChapter[],
  serializedBytes: number,
): Promise<string> {
  await mkdir(opts.dir, { recursive: true });
  const base = buildBasename(req);
  const fullPath = resolve(opts.dir, `${base}.md`);
  await writeFile(fullPath, fullText, "utf8");

  const pad = chapters.length > 100 ? 3 : 2;
  const writes = chapters.map(async (ch, i) => {
    const slug = i === 0 && ch.heading === null ? introSlug(ch.lines.join("\n")) : slugifyHeading(ch.heading ?? "");
    const idx = String(i).padStart(pad, "0");
    const filename = `${base}__${idx}_${slug}.md`;
    const path = resolve(opts.dir, filename);
    try {
      await writeFile(path, ch.lines.join("\n"), "utf8");
      return { idx, slug, path } as const;
    } catch (err) {
      process.stderr.write(`[better-mcp] chapter write failed for ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  });
  const entries = (await Promise.all(writes)).filter((e): e is { idx: string; slug: string; path: string } => e !== null);

  const lines: string[] = [
    `markdown exported to: ${fullPath}`,
    `size: ${formatBytes(serializedBytes)} (${serializedBytes} bytes)`,
  ];
  if (entries.length > 0) {
    lines.push("chapters:");
    for (const e of entries) lines.push(` - ${e.idx} - ${e.slug}: ${e.path}`);
  }
  return lines.join("\n");
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
  return `${buildBasename(req)}.json`;
}

/** Filename stem without extension: `<server>__<tool>__<ts>`. */
function buildBasename(req: ProxyRequest): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safe(req.server)}__${safe(req.name)}__${ts}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * If the response is a standard single-text-block wrapper, return the inner
 * `text` string. Used to feed the markdown-chapter branch (which then checks
 * whether the text actually looks markdown-y).
 */
export function tryUnwrapTextContent(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (!block || typeof block !== "object") return null;
  const b = block as { type?: unknown; text?: unknown };
  if (b.type !== "text" || typeof b.text !== "string") return null;
  return b.text;
}

export interface MarkdownChapter {
  /** The H2 heading text (after `## `), trimmed. null for the intro chunk. */
  heading: string | null;
  /** Lines (without their trailing `\n`) that belong to this chapter. */
  lines: string[];
}

/**
 * Split a markdown string on `^## ` headings. Tracks fenced code blocks
 * (```` ``` ```` and `~~~`) so a `## ` inside one doesn't trigger a split.
 * `\r\n` is normalized to `\n` on the way in. Returns an array of chapters;
 * chapter 0 is the content before the first H2 (heading = null) and is
 * dropped if empty/whitespace-only.
 */
export function splitMarkdownChapters(text: string): MarkdownChapter[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const chapters: MarkdownChapter[] = [];
  let current: MarkdownChapter = { heading: null, lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^##\s+/.test(line)) {
      // Flush current, start new chapter whose body includes the heading line.
      if (current.heading !== null || current.lines.some((l) => l.trim().length > 0)) {
        chapters.push(current);
      }
      current = { heading: line.replace(/^##\s+/, "").trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  // Always flush the final chapter (it has content because we hit at least
  // one H2 to enter the non-intro state, or it carries the only intro text).
  if (current.heading !== null || current.lines.some((l) => l.trim().length > 0)) {
    chapters.push(current);
  }
  return chapters;
}

/**
 * Filesystem-safe slug from an H2 heading. Lowercases, strips diacritics +
 * quotes, replaces other non-alphanumeric runs with `_`, trims, caps at 40
 * chars. Falls back to `chapter` when nothing usable remains.
 */
export function slugifyHeading(s: string): string {
  const cleaned = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/['"`‘’“”]/g, "") // strip quotes/apostrophes (no separator)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned || "chapter";
}

/**
 * Slug for the intro chapter (content before the first H2). If there's a
 * leading H1 (`# TITLE`), use its slug; otherwise plain "intro".
 */
function introSlug(introText: string): string {
  const m = /^#\s+(.+)$/m.exec(introText);
  return m ? slugifyHeading(m[1]) : "intro";
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

// -- preview rendering --------------------------------------------------------

/**
 * Build a compact one-line preview of an array suitable for an offload pointer.
 *
 * - Homogeneous object arrays render as `{"cols":[...],"rows":[[...],[...]]}`.
 *   Missing fields are filled with `null`; cell values are stringified and
 *   capped at PREVIEW_CELL_MAX chars.
 * - Primitive/mixed arrays render as a JSON sample: `[1,"two",null]`.
 * - Returns null when there's nothing useful to show (empty array, disabled,
 *   too-many-cols for the tabular form).
 */
export function buildPreview(arr: unknown[], maxRows: number): string | null {
  if (maxRows <= 0 || arr.length === 0) return null;
  const sample = arr.slice(0, maxRows);

  if (sample.every(isPlainObject)) {
    return renderTabular(sample as Record<string, unknown>[]);
  }
  return renderJsonSample(sample);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function renderTabular(rows: Record<string, unknown>[]): string | null {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  if (cols.length === 0 || cols.length > PREVIEW_MAX_COLS) return null;

  const rendered = rows.map((row) => cols.map((c) => tabularCell(row[c])));
  return JSON.stringify({ cols, rows: rendered });
}

function renderJsonSample(sample: unknown[]): string {
  return JSON.stringify(sample.map(capStrings));
}

/**
 * Render one tabular cell. Each cell must be a single scalar so the table
 * stays grid-shaped, so nested objects/arrays are JSON-stringified and
 * length-capped.
 */
function tabularCell(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return capString(v);
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
  return capString(s);
}

/**
 * For the JSON-sample path we preserve native shape (so objects stay objects)
 * but recurse to cap any oversize strings hiding inside.
 */
function capStrings(v: unknown): unknown {
  if (typeof v === "string") return capString(v);
  if (Array.isArray(v)) return v.map(capStrings);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) out[k] = capStrings(vv);
    return out;
  }
  return v;
}

function capString(s: string): string {
  return s.length > PREVIEW_CELL_MAX ? s.slice(0, PREVIEW_CELL_MAX - 1) + "…" : s;
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
