/**
 * Expand `${VAR}` and `${VAR:-default}` placeholders in config strings using
 * `process.env`. Applied recursively to the loaded config object.
 */

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function interpolateEnvString(value: string): string {
  return value.replace(ENV_PATTERN, (_match, name: string, defaultValue?: string) => {
    const envValue = process.env[name];
    if (envValue !== undefined && envValue !== "") return envValue;
    if (defaultValue !== undefined) return defaultValue;
    return "";
  });
}

export function interpolateEnvVars<T>(value: T): T {
  if (typeof value === "string") return interpolateEnvString(value) as T;
  if (Array.isArray(value)) return value.map((item) => interpolateEnvVars(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateEnvVars(v);
    }
    return out as T;
  }
  return value;
}
