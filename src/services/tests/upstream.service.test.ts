import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { UpstreamServer, buildRequestInit } from "../upstream.service.js";

// ============================================================================
// buildRequestInit — pure helper for remote (HTTP) upstream auth/headers
// ============================================================================

test("buildRequestInit: undefined headers → empty init", () => {
  assert.deepEqual(buildRequestInit(undefined), {});
});

test("buildRequestInit: empty headers object → empty init (no `headers` key)", () => {
  assert.deepEqual(buildRequestInit({}), {});
});

test("buildRequestInit: copies headers into a new object (not the same reference)", () => {
  const headers = { Authorization: "Bearer xyz", "X-Custom": "1" };
  const init = buildRequestInit(headers);
  assert.deepEqual(init, { headers: { Authorization: "Bearer xyz", "X-Custom": "1" } });
  // Mutating the input afterwards must not affect the returned init — proves
  // we copied, not aliased.
  headers.Authorization = "Bearer changed";
  assert.equal((init.headers as Record<string, string>).Authorization, "Bearer xyz");
});

// ============================================================================
// UpstreamServer.refresh — capability-gated catalog fetch
// ============================================================================

/**
 * Build a fake MCP Client with only the surface UpstreamServer actually uses.
 * Cast through `unknown` because we deliberately don't implement the full
 * Client interface; only the four methods refresh() + close() touch.
 */
type Caps = { tools?: object; resources?: object; prompts?: object } | undefined;

interface FakeClientOpts {
  capabilities?: Caps;
  tools?: { name: string; description?: string; inputSchema: unknown }[];
  resources?: { uri: string; name?: string; description?: string; mimeType?: string }[];
  prompts?: { name: string; description?: string; arguments?: unknown }[];
  listToolsThrows?: boolean;
  listResourcesThrows?: boolean;
  listPromptsThrows?: boolean;
  closeThrows?: boolean;
}

function fakeClient(opts: FakeClientOpts = {}): Client {
  const c = {
    getServerCapabilities() {
      return opts.capabilities;
    },
    async listTools() {
      if (opts.listToolsThrows) throw new Error("listTools failed");
      return { tools: opts.tools ?? [] };
    },
    async listResources() {
      if (opts.listResourcesThrows) throw new Error("listResources failed");
      return { resources: opts.resources ?? [] };
    },
    async listPrompts() {
      if (opts.listPromptsThrows) throw new Error("listPrompts failed");
      return { prompts: opts.prompts ?? [] };
    },
    async close() {
      if (opts.closeThrows) throw new Error("close failed");
    },
  };
  return c as unknown as Client;
}

const fakeTransport = {} as Transport;

/** Silence stderr for one test — `warn()` writes there on list failures. */
function silenceStderr(t: { after: (fn: () => void) => void }) {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });
}

test("refresh: fetches all three when server reports all capabilities", async () => {
  const client = fakeClient({
    capabilities: { tools: {}, resources: {}, prompts: {} },
    tools: [{ name: "list_issues", description: "list", inputSchema: { type: "object" } }],
    resources: [{ uri: "file://x", name: "x", description: "d", mimeType: "text/plain" }],
    prompts: [{ name: "p", description: "pd", arguments: [] }],
  });
  const u = new UpstreamServer("gh", client, fakeTransport);
  await u.refresh();
  assert.equal(u.tools.length, 1);
  assert.equal(u.resources.length, 1);
  assert.equal(u.prompts.length, 1);
});

test("refresh: annotates each catalog entry with its owning server name", async () => {
  const client = fakeClient({
    capabilities: { tools: {}, resources: {}, prompts: {} },
    tools: [{ name: "t", inputSchema: {} }],
    resources: [{ uri: "u" }],
    prompts: [{ name: "p" }],
  });
  const u = new UpstreamServer("my-server", client, fakeTransport);
  await u.refresh();
  assert.equal(u.tools[0].server, "my-server");
  assert.equal(u.resources[0].server, "my-server");
  assert.equal(u.prompts[0].server, "my-server");
});

test("refresh: skips every fetch when server reports no capabilities", async () => {
  let calls = 0;
  const c = fakeClient({ capabilities: undefined });
  // Spy: any list call would throw, so the test fails loudly if refresh
  // ignores the capability gate.
  const wrap = (orig: () => Promise<unknown>) => async () => {
    calls++;
    return orig();
  };
  (c as unknown as { listTools: () => Promise<unknown> }).listTools = wrap(
    (c as unknown as { listTools: () => Promise<unknown> }).listTools,
  );
  (c as unknown as { listResources: () => Promise<unknown> }).listResources = wrap(
    (c as unknown as { listResources: () => Promise<unknown> }).listResources,
  );
  (c as unknown as { listPrompts: () => Promise<unknown> }).listPrompts = wrap(
    (c as unknown as { listPrompts: () => Promise<unknown> }).listPrompts,
  );

  const u = new UpstreamServer("x", c, fakeTransport);
  await u.refresh();
  assert.equal(calls, 0);
  assert.deepEqual(u.tools, []);
  assert.deepEqual(u.resources, []);
  assert.deepEqual(u.prompts, []);
});

test("refresh: only fetches surfaces the server actually advertises", async () => {
  // Tools-only: resources and prompts should NOT be fetched.
  const client = fakeClient({
    capabilities: { tools: {} },
    tools: [{ name: "t", inputSchema: {} }],
    resources: [{ uri: "u" }], // present in fake but should be ignored
    prompts: [{ name: "p" }],
  });
  const u = new UpstreamServer("x", client, fakeTransport);
  await u.refresh();
  assert.equal(u.tools.length, 1);
  assert.equal(u.resources.length, 0);
  assert.equal(u.prompts.length, 0);
});

test("refresh: a listTools failure leaves tools=[] without aborting resources/prompts", async (t) => {
  silenceStderr(t);
  const client = fakeClient({
    capabilities: { tools: {}, resources: {}, prompts: {} },
    listToolsThrows: true,
    resources: [{ uri: "u" }],
    prompts: [{ name: "p" }],
  });
  const u = new UpstreamServer("x", client, fakeTransport);
  await u.refresh();
  assert.deepEqual(u.tools, []);
  assert.equal(u.resources.length, 1);
  assert.equal(u.prompts.length, 1);
});

test("refresh: a listResources failure leaves resources=[] without aborting tools/prompts", async (t) => {
  silenceStderr(t);
  const client = fakeClient({
    capabilities: { tools: {}, resources: {}, prompts: {} },
    tools: [{ name: "t", inputSchema: {} }],
    listResourcesThrows: true,
    prompts: [{ name: "p" }],
  });
  const u = new UpstreamServer("x", client, fakeTransport);
  await u.refresh();
  assert.equal(u.tools.length, 1);
  assert.deepEqual(u.resources, []);
  assert.equal(u.prompts.length, 1);
});

test("refresh: a listPrompts failure leaves prompts=[] without aborting tools/resources", async (t) => {
  silenceStderr(t);
  const client = fakeClient({
    capabilities: { tools: {}, resources: {}, prompts: {} },
    tools: [{ name: "t", inputSchema: {} }],
    resources: [{ uri: "u" }],
    listPromptsThrows: true,
  });
  const u = new UpstreamServer("x", client, fakeTransport);
  await u.refresh();
  assert.equal(u.tools.length, 1);
  assert.equal(u.resources.length, 1);
  assert.deepEqual(u.prompts, []);
});

test("refresh: handles undefined `tools`/`resources`/`prompts` in the SDK response", async () => {
  // The SDK could legitimately return an object without the list key — verify
  // we don't choke on `(res.tools ?? [])`.
  const client = {
    getServerCapabilities: () => ({ tools: {}, resources: {}, prompts: {} }),
    async listTools() {
      return {};
    },
    async listResources() {
      return {};
    },
    async listPrompts() {
      return {};
    },
  } as unknown as Client;
  const u = new UpstreamServer("x", client, fakeTransport);
  await u.refresh();
  assert.deepEqual(u.tools, []);
  assert.deepEqual(u.resources, []);
  assert.deepEqual(u.prompts, []);
});

test("refresh: a second call replaces (does not append to) the catalog", async () => {
  // refresh() should be idempotent — calling it twice produces the same shape,
  // not duplicated entries.
  const client = fakeClient({
    capabilities: { tools: {} },
    tools: [{ name: "a", inputSchema: {} }, { name: "b", inputSchema: {} }],
  });
  const u = new UpstreamServer("x", client, fakeTransport);
  await u.refresh();
  await u.refresh();
  assert.equal(u.tools.length, 2);
});

// ============================================================================
// UpstreamServer.close — must swallow errors silently
// ============================================================================

test("close: forwards to client.close() in the happy path", async () => {
  let called = 0;
  const client = {
    async close() {
      called++;
    },
  } as unknown as Client;
  const u = new UpstreamServer("x", client, fakeTransport);
  await u.close();
  assert.equal(called, 1);
});

test("close: swallows errors from client.close() so shutdown can continue", async () => {
  const client = {
    async close() {
      throw new Error("transport already dead");
    },
  } as unknown as Client;
  const u = new UpstreamServer("x", client, fakeTransport);
  // Must NOT throw — the bootstrap shutdown loop relies on this.
  await u.close();
});
