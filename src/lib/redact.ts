/**
 * Shared redaction logic. Used by the `redact` middleware (to scrub the
 * response the client receives) and by the tracer (to scrub bodies before
 * they are written to per-tool log files — the tracer sees the *raw*,
 * pre-redaction upstream data, so it must redact independently).
 */

export const REDACTED = "[REDACTED]";

/**
 * Build a deep walker that replaces the VALUE of any object key whose name
 * contains (case-insensitively) one of `patterns` with "[REDACTED]".
 * Returns an identity function when there are no patterns.
 */
export function makeRedactWalk(patterns: string[]): (value: unknown) => unknown {
  if (patterns.length === 0) return (v) => v;

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
  return walk;
}
