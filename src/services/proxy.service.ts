import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MiddlewarePipeline } from "../middleware/pipeline.js";
import type { UpstreamServer } from "./upstream.service.js";
import type { ProxyRequest } from "../types/index.js";
import { slimTool, type ResolvedSlimConfig } from "../lib/slim.js";

const NS_SEPARATOR = "__";

/**
 * Build the array returned by `tools/list`. Pulled out of the request handler
 * so the slim + namespace logic can be unit-tested without an MCP server.
 *
 * Accepts the minimal shape we actually read off each upstream — that keeps
 * tests free to pass plain literals instead of a full `UpstreamServer`.
 */
export interface ListedToolsSource {
  name: string;
  tools: { name: string; description?: string; inputSchema: unknown }[];
}

export function buildListedTools(
  upstreams: ListedToolsSource[],
  namespace: boolean,
  slim: ResolvedSlimConfig | null,
): { name: string; description?: string; inputSchema: { type: "object"; [k: string]: unknown } }[] {
  const out: { name: string; description?: string; inputSchema: { type: "object"; [k: string]: unknown } }[] = [];
  for (const s of upstreams) {
    for (const t of s.tools) {
      const base = {
        name: namespace ? `${s.name}${NS_SEPARATOR}${t.name}` : t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
      };
      out.push(slim ? (slimTool(base, slim) as typeof base) : base);
    }
  }
  return out;
}

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
 * Wire up the proxy MCP server. Returns the configured McpServer (not yet listening)
 * so the caller can attach the transport and start it.
 *
 * Uses the underlying `server` for request handlers so upstream JSON Schemas are
 * forwarded unchanged (McpServer.registerTool only accepts Zod shapes).
 */
export function buildProxyServer(opts: {
  upstreams: UpstreamServer[];
  pipeline: MiddlewarePipeline;
  namespace: boolean;
  slim: ResolvedSlimConfig | null;
}): McpServer {
  const { upstreams, pipeline, namespace, slim } = opts;
  const routes = buildRoutes(upstreams, namespace);

  const mcp = new McpServer(
    { name: "@qelos/better-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );
  const server = mcp.server;

  // ---- tools ---------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: buildListedTools(upstreams, namespace, slim) };
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

  return mcp;
}

/** Connect the proxy to the stdio transport and start serving. */
export async function startProxy(mcp: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

function warn(msg: string): void {
  process.stderr.write(`[better-mcp] ${msg}\n`);
}
