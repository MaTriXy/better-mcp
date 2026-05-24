import type { SlimConfig } from "../types/index.js";

const DEFAULT_STRIP_FIELDS = ["$schema", "$id", "$comment", "title", "examples", "default"];

export interface ResolvedSlimConfig {
  stripSchemaFields: Set<string>;
  stripPropertyDescriptions: boolean;
  maxDescriptionLength: number;
}

/**
 * Resolve the user-facing config. `undefined` means "use defaults (slim ON)";
 * `false` means "skip slimming entirely" and returns null.
 */
export function resolveSlimConfig(raw: boolean | SlimConfig | undefined): ResolvedSlimConfig | null {
  if (raw === false) return null;
  const cfg: SlimConfig = raw === true || raw === undefined ? {} : raw;
  return {
    stripSchemaFields: new Set(cfg.stripSchemaFields ?? DEFAULT_STRIP_FIELDS),
    stripPropertyDescriptions: cfg.stripPropertyDescriptions ?? false,
    maxDescriptionLength: cfg.maxDescriptionLength ?? 0,
  };
}

/** Top-level entry: slim a single tool's description + inputSchema. */
export function slimTool<T extends { description?: string; inputSchema: unknown }>(
  tool: T,
  cfg: ResolvedSlimConfig,
): T {
  return {
    ...tool,
    description: capDescription(tool.description, cfg.maxDescriptionLength),
    inputSchema: slimSchema(tool.inputSchema, cfg) as T["inputSchema"],
  };
}

/**
 * Recursively walk a JSON Schema node and return a new value with noise stripped.
 * Pure: never mutates input.
 */
export function slimSchema(node: unknown, cfg: ResolvedSlimConfig): unknown {
  if (Array.isArray(node)) return node.map((n) => slimSchema(n, cfg));
  if (!node || typeof node !== "object") return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if (cfg.stripSchemaFields.has(key)) continue;
    if ((key === "required" || key === "enum") && Array.isArray(value) && value.length === 0) continue;

    if (key === "properties" && value && typeof value === "object") {
      out[key] = slimProperties(value as Record<string, unknown>, cfg);
      continue;
    }
    if (key === "patternProperties" && value && typeof value === "object") {
      const pp: Record<string, unknown> = {};
      for (const [pat, sub] of Object.entries(value as Record<string, unknown>)) {
        pp[pat] = slimSchema(sub, cfg);
      }
      out[key] = pp;
      continue;
    }

    out[key] = slimSchema(value, cfg);
  }
  return out;
}

function slimProperties(props: Record<string, unknown>, cfg: ResolvedSlimConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [propKey, propSchema] of Object.entries(props)) {
    const slimmed = slimSchema(propSchema, cfg);
    if (cfg.stripPropertyDescriptions && slimmed && typeof slimmed === "object" && !Array.isArray(slimmed)) {
      const s = slimmed as Record<string, unknown>;
      if (typeof s.description === "string" && isObviousDuplicate(propKey, s.description)) {
        const { description: _drop, ...rest } = s;
        out[propKey] = rest;
        continue;
      }
    }
    out[propKey] = slimmed;
  }
  return out;
}

/**
 * Heuristic: every word in the property name (split on camelCase / _ / -)
 * appears in the description, and the description is short enough to be a
 * paraphrase rather than real documentation.
 */
function isObviousDuplicate(propKey: string, description: string): boolean {
  if (description.length > 60) return false;
  const words = propKey
    .split(/(?=[A-Z])|[_-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  if (words.length === 0) return false;
  const norm = description.toLowerCase();
  return words.every((w) => norm.includes(w));
}

function capDescription(desc: string | undefined, max: number): string | undefined {
  if (!desc || max <= 0 || desc.length <= max) return desc;
  return desc.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}
