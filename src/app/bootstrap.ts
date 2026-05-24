import { loadConfig } from "../config/index.js";
import { startListenServer } from "../controllers/listen.controller.js";
import { resolveSlimConfig } from "../lib/slim.js";
import { MiddlewarePipeline } from "../middleware/pipeline.js";
import { buildProxyServer, startProxy } from "../services/proxy.service.js";
import { connectAll } from "../services/upstream.service.js";

export async function bootstrap(opts: { entryDir: string }): Promise<void> {
  const { config, baseDir, source } = await loadConfig({ entryDir: opts.entryDir });
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
  const slim = resolveSlimConfig(config.middleware?.slim);
  const stdioServer = buildProxyServer({
    upstreams,
    pipeline,
    namespace: config.namespace ?? true,
    slim,
  });

  const listenServer = config.listen
    ? await startListenServer({
        listen: config.listen,
        upstreams,
        pipeline,
        namespace: config.namespace ?? true,
        slim,
      })
    : null;

  const shutdown = async () => {
    if (listenServer) await listenServer.close();
    await Promise.all(upstreams.map((u) => u.close()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await startProxy(stdioServer);
}
