import { appendFile } from "node:fs/promises";
import type { MiddlewareHooks, ProxyRequest, ProxyResponse } from "../types/index.js";

export function makeLogger(level: "info" | "debug", file?: string): MiddlewareHooks {
  const write = async (line: string) => {
    if (file) {
      await appendFile(file, line + "\n", "utf8");
    } else {
      // Stderr is safe to write to in an stdio MCP server (stdout is for protocol).
      process.stderr.write(line + "\n");
    }
  };
  return {
    async before(req) {
      const entry = {
        ts: new Date().toISOString(),
        dir: "request",
        server: req.server,
        kind: req.kind,
        name: req.name,
        ...(level === "debug" ? { params: req.params } : {}),
      };
      await write(JSON.stringify(entry));
    },
    async after(req, res) {
      const entry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        dir: "response",
        server: req.server,
        kind: req.kind,
        name: req.name,
        durationMs: res.durationMs,
      };
      if (res.error) entry.error = res.error.message;
      if (level === "debug") entry.result = res.result;
      await write(JSON.stringify(entry));
    },
  };
}
