import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { NextFunction, Request, Response } from "express";
import { isLoopbackHost } from "../config/index.js";
import { makeBearerAuth } from "../http/auth.middleware.js";
import type { MiddlewarePipeline } from "../middleware/pipeline.js";
import { buildProxyServer } from "../services/proxy.service.js";
import type { UpstreamServer } from "../services/upstream.service.js";
import type { ListenConfig } from "../types/index.js";

export interface ListenServer {
  httpServer: HttpServer;
  close(): Promise<void>;
}

interface ListenContext {
  upstreams: UpstreamServer[];
  pipeline: MiddlewarePipeline;
  namespace: boolean;
  transports: Record<string, StreamableHTTPServerTransport>;
}

/**
 * Expose better-mcp as a Streamable HTTP MCP server (SSE for response streams).
 * Each client session gets its own transport wired to a proxy Server instance.
 */
export async function startListenServer(opts: {
  listen: ListenConfig;
  upstreams: UpstreamServer[];
  pipeline: MiddlewarePipeline;
  namespace: boolean;
}): Promise<ListenServer> {
  const host = opts.listen.host ?? "127.0.0.1";
  const path = opts.listen.path ?? "/mcp";
  const bearer = opts.listen.auth?.bearer;

  if (!isLoopbackHost(host) && !bearer) {
    throw new Error(
      `listen.auth.bearer is required when binding to non-loopback host "${host}". ` +
        "Set listen.auth.bearer in config or BETTER_MCP_LISTEN_BEARER / BETTER_MCP_TOKEN.",
    );
  }

  const ctx: ListenContext = {
    upstreams: opts.upstreams,
    pipeline: opts.pipeline,
    namespace: opts.namespace,
    transports: {},
  };

  const app = createMcpExpressApp({ host });
  const auth = bearer ? makeBearerAuth(bearer) : undefined;

  registerMcpRoute(app, "post", path, auth, (req, res) => handlePost(ctx, req, res));
  registerMcpRoute(app, "get", path, auth, (req, res) => handleGet(ctx, req, res));
  registerMcpRoute(app, "delete", path, auth, (req, res) => handleDelete(ctx, req, res));

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(opts.listen.port, host, () => resolve(server));
    server.on("error", reject);
  });

  process.stderr.write(
    `[better-mcp] listening on http://${host}:${opts.listen.port}${path}\n`,
  );

  return {
    httpServer,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await Promise.all(Object.values(ctx.transports).map((t) => t.close()));
      ctx.transports = {};
    },
  };
}

function registerMcpRoute(
  app: ReturnType<typeof createMcpExpressApp>,
  method: "get" | "post" | "delete",
  path: string,
  auth: ((req: Request, res: Response, next: NextFunction) => void) | undefined,
  handler: (req: Request, res: Response) => Promise<void>,
): void {
  const wrapped = (req: Request, res: Response) => {
    void handler(req, res);
  };
  if (auth) {
    app[method](path, auth, wrapped);
  } else {
    app[method](path, wrapped);
  }
}

async function handlePost(ctx: ListenContext, req: Request, res: Response): Promise<void> {
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  try {
    let transport: StreamableHTTPServerTransport | undefined;
    if (sessionId && ctx.transports[sessionId]) {
      transport = ctx.transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          ctx.transports[sid] = transport!;
        },
      });
      transport.onclose = () => {
        const sid = transport!.sessionId;
        if (sid && ctx.transports[sid]) delete ctx.transports[sid];
      };
      const server = buildProxyServer({
        upstreams: ctx.upstreams,
        pipeline: ctx.pipeline,
        namespace: ctx.namespace,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    writeHandlerError(res, err);
  }
}

async function handleGet(ctx: ListenContext, req: Request, res: Response): Promise<void> {
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  const transport = sessionId ? ctx.transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  try {
    await transport.handleRequest(req, res);
  } catch (err) {
    writeHandlerError(res, err);
  }
}

async function handleDelete(ctx: ListenContext, req: Request, res: Response): Promise<void> {
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  const transport = sessionId ? ctx.transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  try {
    await transport.handleRequest(req, res);
  } catch (err) {
    writeHandlerError(res, err);
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function writeHandlerError(res: Response, err: unknown): void {
  process.stderr.write(
    `[better-mcp] listen handler error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  if (!res.headersSent) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
  }
}
