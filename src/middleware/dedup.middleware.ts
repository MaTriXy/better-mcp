import { createHash } from "node:crypto";
import type { DedupConfig, MiddlewareHooks, ProxyRequest, ProxyResponse } from "../types/index.js";

export interface ResolvedDedupConfig {
  ttlSeconds: number;
  maxEntries: number;
  minBytes: number;
  includeResources: boolean;
  exclude: Set<string>;
}

interface CacheEntry {
  firstSeen: number;
}

/**
 * `false`/undefined → disabled. `true` → defaults. Object → merged. We clamp
 * the numeric knobs to sane minimums so a misconfigured `ttlSeconds: 0` (which
 * would dedup nothing) is treated as `1`, etc.
 */
export function resolveDedupConfig(raw: boolean | DedupConfig | undefined): ResolvedDedupConfig | null {
  if (!raw) return null;
  const cfg: DedupConfig = raw === true ? {} : raw;
  return {
    ttlSeconds: Math.max(1, Math.floor(cfg.ttlSeconds ?? 300)),
    maxEntries: Math.max(1, Math.floor(cfg.maxEntries ?? 1000)),
    minBytes: Math.max(0, Math.floor(cfg.minBytes ?? 200)),
    includeResources: cfg.includeResources ?? false,
    exclude: new Set(cfg.exclude ?? []),
  };
}

/**
 * Middleware: on each response, hash the serialized result. If the same hash
 * was seen for the same `(server, tool)` within TTL, return a short pointer
 * referencing the original; otherwise cache it and pass through.
 *
 * The cache is per-pipeline (= per-process for stdio, shared across HTTP
 * sessions for listen mode). We accept the in-memory bound; restarts clear it.
 *
 * @internal `_now` and `_cache` are escape hatches for tests.
 */
export function makeDedup(opts: ResolvedDedupConfig, _now: () => number = Date.now, _cache?: Map<string, CacheEntry>): MiddlewareHooks {
  const cache: Map<string, CacheEntry> = _cache ?? new Map();

  return {
    async after(req: ProxyRequest, res: ProxyResponse): Promise<ProxyResponse | void> {
      if (res.error || res.result === undefined || res.result === null) return;
      if (req.kind === "prompt") return;
      if (req.kind === "resource" && !opts.includeResources) return;
      if (isExcluded(req, opts.exclude)) return;

      const serialized = safeStringify(res.result);
      if (!serialized || serialized.length < opts.minBytes) return;

      const now = _now();
      pruneExpired(cache, now, opts.ttlSeconds);

      const hash = shortHash(serialized);
      const key = `${req.server}__${req.name}__${hash}`;
      const existing = cache.get(key);

      if (existing) {
        // HIT — refresh LRU position, return terse pointer.
        cache.delete(key);
        cache.set(key, existing);
        return {
          ...res,
          result: buildPointer(hash, Math.floor((now - existing.firstSeen) / 1000)),
        };
      }

      enforceMaxEntries(cache, opts.maxEntries);
      cache.set(key, { firstSeen: now });
      return;
    },
  };
}

// -- helpers ------------------------------------------------------------------

function pruneExpired(cache: Map<string, CacheEntry>, now: number, ttlSec: number): void {
  const cutoff = now - ttlSec * 1000;
  for (const [k, v] of cache) {
    if (v.firstSeen < cutoff) cache.delete(k);
  }
}

function enforceMaxEntries(cache: Map<string, CacheEntry>, max: number): void {
  // Map iteration is in insertion order, so the oldest insert is `keys().next()`.
  // On HIT we re-insert (LRU bump), so this evicts least-recently-used.
  while (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

export function buildPointer(hash: string, secondsAgo: number): unknown {
  return {
    content: [{ type: "text", text: `same response as ${formatAge(secondsAgo)} ago (sha:${hash})` }],
    isError: false,
  };
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function safeStringify(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function isExcluded(req: ProxyRequest, exclude: Set<string>): boolean {
  if (exclude.size === 0) return false;
  if (exclude.has(req.server)) return true;
  return exclude.has(`${req.server}__${req.name}`);
}
