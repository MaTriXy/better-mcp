import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MiddlewarePipeline } from "../../middleware/pipeline.js";
import { headerValue, startListenServer } from "../listen.controller.js";

// ============================================================================
// headerValue — handle Node's `string | string[] | undefined` header values
// ============================================================================

test("headerValue: single string returns as-is", () => {
  assert.equal(headerValue("session-abc"), "session-abc");
});

test("headerValue: array returns the first element", () => {
  // Node sometimes presents a header as a string[] when it appears multiple
  // times. We pick the first, mirroring most HTTP servers' default policy.
  assert.equal(headerValue(["first", "second"]), "first");
});

test("headerValue: undefined returns undefined", () => {
  assert.equal(headerValue(undefined), undefined);
});

test("headerValue: empty array returns undefined (array[0] is undefined)", () => {
  assert.equal(headerValue([]), undefined);
});

// ============================================================================
// startListenServer — non-loopback bind guard (pre-boot validation)
// ============================================================================

test("startListenServer: throws when binding non-loopback host without a bearer", async () => {
  const pipeline = await MiddlewarePipeline.build(undefined, "/tmp");
  await assert.rejects(
    () =>
      startListenServer({
        listen: { host: "0.0.0.0", port: 0 }, // no auth
        upstreams: [],
        pipeline,
        namespace: true,
        slim: null,
      }),
    /listen\.auth\.bearer is required/,
    "binding 0.0.0.0 with no bearer should refuse to start",
  );
});

test("startListenServer: loopback bind without bearer is allowed", async () => {
  const pipeline = await MiddlewarePipeline.build(undefined, "/tmp");
  const server = await startListenServer({
    listen: { host: "127.0.0.1", port: 0 }, // no auth, but loopback
    upstreams: [],
    pipeline,
    namespace: true,
    slim: null,
  });
  await server.close();
});

// ============================================================================
// Integration: real HTTP server on an ephemeral port. Validates the auth gate
// and the session-id check on the MCP route handlers without going through the
// full MCP initialize handshake.
// ============================================================================

async function bootServer(opts: { bearer?: string } = {}) {
  const pipeline = await MiddlewarePipeline.build(undefined, "/tmp");
  const server = await startListenServer({
    listen: {
      host: "127.0.0.1",
      port: 0,
      auth: opts.bearer ? { bearer: opts.bearer } : undefined,
    },
    upstreams: [],
    pipeline,
    namespace: true,
    slim: null,
  });
  const { port } = server.httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => server.close(),
  };
}

test("auth: missing Authorization header → 401 when bearer is configured", async (t) => {
  const s = await bootServer({ bearer: "test-token" });
  t.after(() => s.close());
  const res = await fetch(s.url, { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error?: { code?: number; message?: string } };
  assert.equal(body.error?.code, -32001);
  assert.equal(body.error?.message, "Unauthorized");
});

test("auth: wrong Bearer token → 401", async (t) => {
  const s = await bootServer({ bearer: "test-token" });
  t.after(() => s.close());
  const res = await fetch(s.url, {
    method: "POST",
    headers: { Authorization: "Bearer wrong" },
    body: "{}",
  });
  assert.equal(res.status, 401);
});

test("auth: correct Bearer + missing session ID + non-initialize → 400 from session check", async (t) => {
  // We pass auth, but the body is NOT an initialize request and we haven't
  // sent an `mcp-session-id` header. The session-id branch in handlePost
  // should return 400 with a JSON-RPC error.
  const s = await bootServer({ bearer: "test-token" });
  t.after(() => s.close());
  const res = await fetch(s.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { message?: string } };
  assert.match(body.error?.message ?? "", /Bad Request: No valid session ID provided/);
});

test("auth: GET with no session ID → 400 from handleGet", async (t) => {
  const s = await bootServer({ bearer: "test-token" });
  t.after(() => s.close());
  const res = await fetch(s.url, {
    method: "GET",
    headers: { Authorization: "Bearer test-token" },
  });
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Invalid or missing session ID");
});

test("auth: DELETE with no session ID → 400 from handleDelete", async (t) => {
  const s = await bootServer({ bearer: "test-token" });
  t.after(() => s.close());
  const res = await fetch(s.url, {
    method: "DELETE",
    headers: { Authorization: "Bearer test-token" },
  });
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Invalid or missing session ID");
});

test("listen: with no auth configured (loopback), no Authorization header is required", async (t) => {
  const s = await bootServer({}); // no bearer
  t.after(() => s.close());
  // Without auth, we should reach the session-id check directly (400, not 401).
  const res = await fetch(s.url, {
    method: "GET",
  });
  assert.equal(res.status, 400);
});

test("close: shuts the HTTP server down so subsequent connects refuse", async () => {
  const s = await bootServer({ bearer: "test-token" });
  // Sanity: server is reachable.
  const before = await fetch(s.url, {
    method: "GET",
    headers: { Authorization: "Bearer test-token" },
  });
  assert.equal(before.status, 400);

  await s.close();

  // After close, the port should reject connections.
  await assert.rejects(
    () =>
      fetch(s.url, {
        method: "GET",
        headers: { Authorization: "Bearer test-token" },
      }),
    "expected fetch to fail after server.close()",
  );
});
