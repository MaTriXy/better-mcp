import type { CleanTextConfig, MiddlewareHooks, ProxyRequest, ProxyResponse } from "../types/index.js";

export interface ResolvedCleanTextConfig {
  stripAnsi: boolean;
  trimTrailingWhitespace: boolean;
  collapseBlankLines: boolean;
  exclude: Set<string>;
}

/**
 * Matches ANSI/CSI escape sequences (colours, cursor moves, terminal modes).
 * Covers the common forms: `ESC [ params letter` (CSI), `ESC ( charset`,
 * `ESC ] OSC ... BEL/ST`, and standalone single-char ESCs.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][\x20-\x7e]|[@-_])/g;

/**
 * `false` opts out. `undefined`/`true` enables defaults (stripAnsi +
 * trimTrailingWhitespace ON, collapseBlankLines OFF). Otherwise merged.
 */
export function resolveCleanTextConfig(raw: boolean | CleanTextConfig | undefined): ResolvedCleanTextConfig | null {
  if (raw === false) return null;
  const cfg: CleanTextConfig = raw === true || raw === undefined ? {} : raw;
  return {
    stripAnsi: cfg.stripAnsi ?? true,
    trimTrailingWhitespace: cfg.trimTrailingWhitespace ?? true,
    collapseBlankLines: cfg.collapseBlankLines ?? false,
    exclude: new Set(cfg.exclude ?? []),
  };
}

/**
 * Middleware: walks `result.content[]`; for each `{type:"text", text:"..."}`
 * block, applies the configured text transforms. No JSON parsing — this is
 * pure string cleaning.
 */
export function makeCleanText(opts: ResolvedCleanTextConfig): MiddlewareHooks {
  return {
    async after(req: ProxyRequest, res: ProxyResponse): Promise<ProxyResponse | void> {
      if (res.error || res.result === undefined || res.result === null) return;
      if (isExcluded(req, opts.exclude)) return;
      const cleaned = cleanResponse(res.result, opts);
      if (cleaned === res.result) return;
      return { ...res, result: cleaned };
    },
  };
}

function isExcluded(req: ProxyRequest, exclude: Set<string>): boolean {
  if (exclude.size === 0) return false;
  if (exclude.has(req.server)) return true;
  return exclude.has(`${req.server}__${req.name}`);
}

export function cleanResponse(result: unknown, opts: ResolvedCleanTextConfig): unknown {
  if (!result || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;

  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== "text" || typeof b.text !== "string") return block;
    const cleaned = cleanString(b.text, opts);
    if (cleaned === b.text) return block;
    changed = true;
    return { ...block, text: cleaned };
  });
  if (!changed) return result;
  return { ...(result as object), content: next };
}

/**
 * Apply the enabled transforms to a single string. Returns the original
 * reference (not just an equal copy) when nothing changes, so callers can
 * cheap-equality short-circuit.
 */
export function cleanString(s: string, opts: ResolvedCleanTextConfig): string {
  let out = s;
  if (opts.stripAnsi) out = out.replace(ANSI_RE, "");
  if (opts.trimTrailingWhitespace) out = out.replace(/[ \t]+$/gm, "");
  if (opts.collapseBlankLines) out = out.replace(/\n{3,}/g, "\n\n");
  return out === s ? s : out;
}
