import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../types/index.js";

export interface UpstreamTool {
  server: string;
  /** Original (un-namespaced) name on the upstream server. */
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface UpstreamResource {
  server: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface UpstreamPrompt {
  server: string;
  name: string;
  description?: string;
  arguments?: unknown;
}

const PROXY_CLIENT_INFO = { name: "@qelos/better-mcp", version: "0.1.0" };

/**
 * One connected upstream MCP server, holding the SDK Client and the catalog
 * we discovered at connect time.
 */
export class UpstreamServer {
  client: Client;
  transport: Transport;
  name: string;
  tools: UpstreamTool[] = [];
  resources: UpstreamResource[] = [];
  prompts: UpstreamPrompt[] = [];

  constructor(name: string, client: Client, transport: Transport) {
    this.name = name;
    this.client = client;
    this.transport = transport;
  }

  /** Re-fetch the catalog. Called on connect; safe to call later. */
  async refresh(): Promise<void> {
    const caps = this.client.getServerCapabilities();

    if (caps?.tools) {
      try {
        const res = await this.client.listTools();
        this.tools = (res.tools ?? []).map((t) => ({
          server: this.name,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      } catch (err) {
        warn(this.name, "listTools failed", err);
        this.tools = [];
      }
    }

    if (caps?.resources) {
      try {
        const res = await this.client.listResources();
        this.resources = (res.resources ?? []).map((r) => ({
          server: this.name,
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
      } catch (err) {
        warn(this.name, "listResources failed", err);
        this.resources = [];
      }
    }

    if (caps?.prompts) {
      try {
        const res = await this.client.listPrompts();
        this.prompts = (res.prompts ?? []).map((p) => ({
          server: this.name,
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        }));
      } catch (err) {
        warn(this.name, "listPrompts failed", err);
        this.prompts = [];
      }
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Spawn and connect to every server in the config. Servers that fail to
 * start are logged to stderr but do not crash the proxy — the rest still
 * come up. Returns the list of successfully-connected servers.
 */
export async function connectAll(
  servers: Record<string, McpServerConfig>,
): Promise<UpstreamServer[]> {
  const entries = Object.entries(servers).filter(([, s]) => s.enabled !== false);

  const results = await Promise.all(
    entries.map(async ([name, cfg]) => {
      try {
        return await connectOne(name, cfg);
      } catch (err) {
        warn(name, "failed to start upstream server", err);
        return null;
      }
    }),
  );
  return results.filter((r): r is UpstreamServer => r !== null);
}

async function connectOne(name: string, cfg: McpServerConfig): Promise<UpstreamServer> {
  if (cfg.url) {
    return connectRemote(name, cfg);
  }
  return connectStdio(name, cfg);
}

async function connectStdio(name: string, cfg: McpServerConfig): Promise<UpstreamServer> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (cfg.env) Object.assign(env, cfg.env);

  const transport = new StdioClientTransport({
    command: cfg.command!,
    args: cfg.args ?? [],
    env,
    cwd: cfg.cwd,
  });

  const client = new Client(PROXY_CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
  const server = new UpstreamServer(name, client, transport);
  await server.refresh();
  return server;
}

async function connectRemote(name: string, cfg: McpServerConfig): Promise<UpstreamServer> {
  const url = new URL(cfg.url!);
  const requestInit = buildRequestInit(cfg.headers);
  return connectWithTransport(
    name,
    new StreamableHTTPClientTransport(url, { requestInit }),
  );
}

async function connectWithTransport(name: string, transport: Transport): Promise<UpstreamServer> {
  const client = new Client(PROXY_CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
  const server = new UpstreamServer(name, client, transport);
  await server.refresh();
  return server;
}

function buildRequestInit(headers?: Record<string, string>): RequestInit {
  if (!headers || Object.keys(headers).length === 0) return {};
  return { headers: { ...headers } };
}

function warn(server: string, msg: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[better-mcp] ${server}: ${msg}: ${detail}\n`);
}
