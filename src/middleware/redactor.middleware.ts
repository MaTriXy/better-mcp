import { makeRedactWalk } from "../lib/redact.js";
import type { MiddlewareHooks } from "../types/index.js";

export function makeRedactor(patterns: string[]): MiddlewareHooks {
  const walk = makeRedactWalk(patterns);
  return {
    after(_req, res) {
      if (res.error) return res;
      return { ...res, result: walk(res.result) };
    },
  };
}
