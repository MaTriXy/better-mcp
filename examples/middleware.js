// Example user middleware module.
//
// Either default-export `{ before, after }` (as below) or use named exports.
// Both hooks may be async; either may return a modified request/response,
// or return nothing to leave it unchanged. Throwing surfaces as an MCP error.

export default {
  /**
   * Called before the upstream server is invoked. You can:
   *   - inspect/log req.server, req.kind, req.name, req.params
   *   - mutate or replace req.params before it's forwarded
   *   - throw to block the call
   */
  async before(req) {
    // Example: deny writes to a specific filesystem path.
    if (req.kind === "tool" && req.name === "write_file") {
      const path = req.params?.path;
      if (typeof path === "string" && path.includes("/etc/")) {
        throw new Error(`better-mcp: writes under /etc are blocked`);
      }
    }
    // Example: stamp every request with a correlation id (read it back in `after`).
    req.meta = { ...req.meta, correlationId: cryptoRandom() };
    return req;
  },

  /**
   * Called after the upstream server responds (or errored). You can:
   *   - inspect res.result / res.error / res.durationMs
   *   - return a modified response (e.g. truncate, add a footer)
   */
  async after(req, res) {
    if (res.error) return; // leave errors alone

    // Example: warn (to stderr) on slow calls.
    if (res.durationMs > 2000) {
      process.stderr.write(
        `[middleware] slow ${req.server}/${req.name}: ${res.durationMs}ms\n`,
      );
    }
    return res;
  },
};

function cryptoRandom() {
  return Math.random().toString(36).slice(2, 10);
}
