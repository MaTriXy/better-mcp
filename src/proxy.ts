import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MiddlewarePipeline } from "./middleware.js";
import type { UpstreamServer } from "./upstream.js";
import type { ProxyRequest } from "./types.js";

const NS_SEPARATOR = "__";

/**
 * Build maps from public (possibly-namespaced) name → owning upstream + original name.
 * For resources the public identifier is the URI; we don't rewrite URIs because they
 * are opaque to clients, but we do detect collisions across servers.
 */
function buildRoutes(servers: UpstreamServer[], namespace: boolean) {
  const tools = new Map<string, { server: UpstreamServer; originalName: string }>();
  const prompts = new Map<string, { server: UpstreamServer; originalName: string }>();
  const resources = new Map<string, UpstreamServer>();

  for (const s of servers) {
    for (const t of s.tools) {
      const publicName = namespace ? `${s.name}${NS_SEPARATOR}${t.name}` : t.name;
      if (tools.has(publicName)) {
        warn(`tool name collision on "${publicName}" — ${s.name} overrides previous owner`);
      }
      tools.set(publicName, { server: s, originalName: t.name });
    }
    for (const p of s.prompts) {
      const publicName = namespace ? `${s.name}${NS_SEPARATOR}${p.name}` : p.name;
      if (prompts.has(publicName)) {
        warn(`prompt name collision on "${publicName}" — ${s.name} overrides previous owner`);
      }
      prompts.set(publicName, { server: s, originalName: p.name });
    }
    for (const r of s.resources) {
      if (resources.has(r.uri)) {
        warn(`resource URI collision on "${r.uri}" — ${s.name} overrides previous owner`);
      }
      resources.set(r.uri, s);
    }
  }
  return { tools, prompts, resources };
}

/**
 * Wire up the proxy MCP server. Returns the configured Server (not yet listening)
 * so the caller can attach the transport and start it.
 */
export function buildProxyServer(opts: {
  upstreams: UpstreamServer[];
  pipeline: MiddlewarePipeline;
  namespace: boolean;
}): Server {
  const { upstreams, pipeline, namespace } = opts;
  const routes = buildRoutes(upstreams, namespace);

  const server = new Server(
    { name: "@qelos/better-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  // ---- tools ---------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];
    for (const s of upstreams) {
      for (const t of s.tools) {
        tools.push({
          name: namespace ? `${s.name}${NS_SEPARATOR}${t.name}` : t.name,
          description: t.description,
          inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
        });
      }
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const publicName = req.params.name;
    const route = routes.tools.get(publicName);
    if (!route) throw new Error(`Unknown tool: ${publicName}`);

    const proxyReq: ProxyRequest = {
      server: route.server.name,
      kind: "tool",
      name: route.originalName,
      params: req.params.arguments,
    };
    const res = await pipeline.invoke(proxyReq, async (r) =>
      route.server.client.callTool({
        name: r.name,
        arguments: (r.params ?? {}) as Record<string, unknown>,
      }),
    );
    if (res.error) throw new Error(res.error.message);
    return res.result as Record<string, unknown>;
  });

  // ---- resources -----------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [];
    for (const s of upstreams) {
      for (const r of s.resources) {
        resources.push({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        });
      }
    }
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const owner = routes.resources.get(uri);
    if (!owner) throw new Error(`Unknown resource: ${uri}`);

    const proxyReq: ProxyRequest = {
      server: owner.name,
      kind: "resource",
      name: uri,
      params: { uri },
    };
    const res = await pipeline.invoke(proxyReq, async () => owner.client.readResource({ uri }));
    if (res.error) throw new Error(res.error.message);
    return res.result as Record<string, unknown>;
  });

  // ---- prompts -------------------------------------------------------------

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = [];
    for (const s of upstreams) {
      for (const p of s.prompts) {
        prompts.push({
          name: namespace ? `${s.name}${NS_SEPARATOR}${p.name}` : p.name,
          description: p.description,
          arguments: p.arguments as { name: string; description?: string; required?: boolean }[] | undefined,
        });
      }
    }
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const publicName = req.params.name;
    const route = routes.prompts.get(publicName);
    if (!route) throw new Error(`Unknown prompt: ${publicName}`);

    const proxyReq: ProxyRequest = {
      server: route.server.name,
      kind: "prompt",
      name: route.originalName,
      params: req.params.arguments,
    };
    const res = await pipeline.invoke(proxyReq, async (r) =>
      route.server.client.getPrompt({
        name: r.name,
        arguments: (r.params ?? {}) as Record<string, string>,
      }),
    );
    if (res.error) throw new Error(res.error.message);
    return res.result as Record<string, unknown>;
  });

  return server;
}

/** Connect the proxy to the stdio transport and start serving. */
export async function startProxy(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function warn(msg: string): void {
  process.stderr.write(`[better-mcp] ${msg}\n`);
}
