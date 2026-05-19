import { fileUrlFor } from "../config/index.js";
import type { MiddlewareHooks } from "../types/index.js";

export async function loadUserHooks(absPath: string): Promise<MiddlewareHooks> {
  const mod = (await import(fileUrlFor(absPath))) as {
    default?: MiddlewareHooks;
    before?: MiddlewareHooks["before"];
    after?: MiddlewareHooks["after"];
  };
  // Accept either `export default { before, after }` or named exports.
  if (mod.default && (mod.default.before || mod.default.after)) {
    return mod.default;
  }
  if (mod.before || mod.after) {
    return { before: mod.before, after: mod.after };
  }
  throw new Error(
    `Middleware module at ${absPath} did not export before/after hooks. ` +
      'Expected `export default { before, after }` or named exports.',
  );
}
