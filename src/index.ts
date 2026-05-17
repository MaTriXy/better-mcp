#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { MiddlewarePipeline } from "./middleware.js";
import { connectAll } from "./upstream.js";
import { buildProxyServer, startProxy } from "./proxy.js";

async function main(): Promise<void> {
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const { config, baseDir, source } = await loadConfig({ entryDir });
  process.stderr.write(`[better-mcp] using config: ${source}\n`);

  const upstreams = await connectAll(config.mcpServers);
  if (upstreams.length === 0) {
    process.stderr.write("[better-mcp] no upstream servers connected; exiting.\n");
    process.exit(1);
  }
  process.stderr.write(
    `[better-mcp] connected to ${upstreams.length} server(s): ` +
      upstreams.map((s) => s.name).join(", ") +
      "\n",
  );

  const pipeline = await MiddlewarePipeline.build(config.middleware, baseDir);
  const server = buildProxyServer({
    upstreams,
    pipeline,
    namespace: config.namespace ?? true,
  });

  // Clean shutdown on signals so child MCP servers don't get orphaned.
  const shutdown = async () => {
    await Promise.all(upstreams.map((u) => u.close()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await startProxy(server);
}

main().catch((err) => {
  process.stderr.write(`[better-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
