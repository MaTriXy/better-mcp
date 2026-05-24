import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPointer,
  formatAge,
  makeDedup,
  resolveDedupConfig,
  shortHash,
} from "../dedup.middleware.js";

// ---- resolveDedupConfig ----------------------------------------------------

test("resolveDedupConfig(undefined) returns null (disabled)", () => {
  assert.equal(resolveDedupConfig(undefined), null);
  assert.equal(resolveDedupConfig(false), null);
});

test("resolveDedupConfig(true) returns defaults", () => {
  const c = resolveDedupConfig(true);
  if (!c) throw new Error("expected non-null cfg");
  assert.equal(c.ttlSeconds, 300);
  assert.equal(c.maxEntries, 1000);
  assert.equal(c.minBytes, 200);
  assert.equal(c.includeResources, false);
  assert.equal(c.exclude.size, 0);
});

test("resolveDedupConfig clamps degenerate numeric inputs", () => {
  assert.equal(resolveDedupConfig({ ttlSeconds: 0 })!.ttlSeconds, 1);
  assert.equal(resolveDedupConfig({ ttlSeconds: -10 })!.ttlSeconds, 1);
  assert.equal(resolveDedupConfig({ maxEntries: 0 })!.maxEntries, 1);
  assert.equal(resolveDedupConfig({ minBytes: -5 })!.minBytes, 0);
  assert.equal(resolveDedupConfig({ ttlSeconds: 60.9 })!.ttlSeconds, 60);
});

// ---- pure helpers ----------------------------------------------------------

test("shortHash is deterministic and 8 hex chars", () => {
  const h = shortHash("hello world");
  assert.equal(h.length, 8);
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(shortHash("hello world"), h);
  assert.notEqual(shortHash("hello world!"), h);
});

test("formatAge formats common ranges", () => {
  assert.equal(formatAge(0), "0s");
  assert.equal(formatAge(59), "59s");
  assert.equal(formatAge(60), "1m");
  assert.equal(formatAge(150), "2m");
  assert.equal(formatAge(3600), "1h");
  assert.equal(formatAge(7200), "2h");
  assert.equal(formatAge(86400), "1d");
  assert.equal(formatAge(86400 * 7), "7d");
});

test("buildPointer wraps text in MCP shape", () => {
  const p = buildPointer("abc12345", 5);
  assert.deepEqual(p, {
    content: [{ type: "text", text: "same response as 5s ago (sha:abc12345)" }],
    isError: false,
  });
});

// ---- makeDedup middleware --------------------------------------------------

const makeReq = (
  server: string,
  name: string,
  kind: "tool" | "resource" | "prompt" = "tool",
  params: unknown = {},
) => ({ server, kind, name, params });

function makeRes(payload: Record<string, unknown>) {
  const padded = { ...payload, _padding: "x".repeat(300) };
  return { result: { content: [{ type: "text", text: JSON.stringify(padded) }] }, durationMs: 1 };
}

test("first call is a miss (passes through), second call with same body is a hit", async () => {
  let now = 1_000_000;
  const mw = makeDedup(resolveDedupConfig(true)!, () => now);
  const first = await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  assert.equal(first, undefined);
  now += 5_000;
  const second = await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  assert.ok(second);
  const text = (second.result as { content: { text: string }[] }).content[0].text;
  assert.match(text, /^same response as 5s ago \(sha:[0-9a-f]{8}\)$/);
});

test("different responses don't dedup against each other", async () => {
  const mw = makeDedup(resolveDedupConfig(true)!);
  await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  const second = await mw.after!(makeReq("gh", "list"), makeRes({ a: 2 }));
  assert.equal(second, undefined);
});

test("dedup is per-(server,tool); same hash on different tools doesn't collide", async () => {
  const mw = makeDedup(resolveDedupConfig(true)!);
  await mw.after!(makeReq("gh", "list_a"), makeRes({ a: 1 }));
  const second = await mw.after!(makeReq("gh", "list_b"), makeRes({ a: 1 }));
  assert.equal(second, undefined);
});

test("entries past TTL are pruned and stop hitting", async () => {
  let now = 1_000_000;
  const mw = makeDedup(resolveDedupConfig({ ttlSeconds: 10 })!, () => now);
  await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  now += 9_000;
  const hit = await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  assert.ok(hit);
  now += 5_000;
  const miss = await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  assert.equal(miss, undefined);
});

test("LRU eviction kicks in at maxEntries", async () => {
  let now = 1_000_000;
  const cache = new Map();
  const mw = makeDedup(resolveDedupConfig({ maxEntries: 2, ttlSeconds: 3600 })!, () => now, cache);
  await mw.after!(makeReq("gh", "t1"), makeRes({ x: 1 }));
  now += 1;
  await mw.after!(makeReq("gh", "t2"), makeRes({ x: 2 }));
  now += 1;
  await mw.after!(makeReq("gh", "t3"), makeRes({ x: 3 })); // evicts t1
  const keys = [...cache.keys()];
  assert.equal(cache.size, 2);
  assert.ok(keys.some((k) => k.startsWith("gh__t2__")), `t2 evicted: ${keys.join(", ")}`);
  assert.ok(keys.some((k) => k.startsWith("gh__t3__")), `t3 evicted: ${keys.join(", ")}`);
  assert.ok(!keys.some((k) => k.startsWith("gh__t1__")), `t1 should be gone: ${keys.join(", ")}`);
});

test("a HIT bumps LRU order so the entry isn't the next eviction victim", async () => {
  let now = 1_000_000;
  const cache = new Map();
  const mw = makeDedup(resolveDedupConfig({ maxEntries: 2, ttlSeconds: 3600 })!, () => now, cache);
  await mw.after!(makeReq("gh", "t1"), makeRes({ x: 1 }));
  now += 1;
  await mw.after!(makeReq("gh", "t2"), makeRes({ x: 2 }));
  now += 1;
  await mw.after!(makeReq("gh", "t1"), makeRes({ x: 1 }));
  now += 1;
  await mw.after!(makeReq("gh", "t3"), makeRes({ x: 3 }));
  const keys = [...cache.keys()];
  assert.ok(keys.some((k) => k.startsWith("gh__t1__")), `t1 should survive: ${keys.join(", ")}`);
  assert.ok(keys.some((k) => k.startsWith("gh__t3__")), `t3 should survive: ${keys.join(", ")}`);
  assert.ok(!keys.some((k) => k.startsWith("gh__t2__")), `t2 should be evicted: ${keys.join(", ")}`);
});

test("minBytes skips small responses (no caching, always pass-through)", async () => {
  const mw = makeDedup(resolveDedupConfig({ minBytes: 1000 })!);
  const small = { result: { content: [{ type: "text", text: "small" }] }, durationMs: 1 };
  await mw.after!(makeReq("gh", "list"), small);
  const second = await mw.after!(makeReq("gh", "list"), small);
  assert.equal(second, undefined);
});

test("exclude by whole server", async () => {
  const mw = makeDedup(resolveDedupConfig({ exclude: ["gh"] })!);
  await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  const second = await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  assert.equal(second, undefined);
});

test("exclude by specific server__tool", async () => {
  const mw = makeDedup(resolveDedupConfig({ exclude: ["gh__poll_status"] })!);
  await mw.after!(makeReq("gh", "poll_status"), makeRes({ a: 1 }));
  const skipped = await mw.after!(makeReq("gh", "poll_status"), makeRes({ a: 1 }));
  assert.equal(skipped, undefined);
  await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  const hit = await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  assert.ok(hit);
});

test("errored responses are ignored (not cached, not deduped)", async () => {
  const mw = makeDedup(resolveDedupConfig(true)!);
  const errored = { result: undefined, durationMs: 1, error: { message: "boom" } };
  const a = await mw.after!(makeReq("gh", "list"), errored);
  const b = await mw.after!(makeReq("gh", "list"), errored);
  assert.equal(a, undefined);
  assert.equal(b, undefined);
  const real = await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  assert.equal(real, undefined);
});

test("prompt kind is never deduped", async () => {
  const mw = makeDedup(resolveDedupConfig(true)!);
  await mw.after!(makeReq("gh", "p", "prompt"), makeRes({ a: 1 }));
  const second = await mw.after!(makeReq("gh", "p", "prompt"), makeRes({ a: 1 }));
  assert.equal(second, undefined);
});

test("resource kind is opt-in via includeResources", async () => {
  const off = makeDedup(resolveDedupConfig({ includeResources: false })!);
  await off.after!(makeReq("fs", "file://x", "resource"), makeRes({ a: 1 }));
  const skipped = await off.after!(makeReq("fs", "file://x", "resource"), makeRes({ a: 1 }));
  assert.equal(skipped, undefined);

  const on = makeDedup(resolveDedupConfig({ includeResources: true })!);
  await on.after!(makeReq("fs", "file://x", "resource"), makeRes({ a: 1 }));
  const hit = await on.after!(makeReq("fs", "file://x", "resource"), makeRes({ a: 1 }));
  assert.ok(hit);
});

test("pointer reports correct age across minute boundary", async () => {
  let now = 1_000_000;
  const mw = makeDedup(resolveDedupConfig({ ttlSeconds: 600 })!, () => now);
  await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  now += 75_000;
  const hit = await mw.after!(makeReq("gh", "list"), makeRes({ a: 1 }));
  assert.match((hit!.result as { content: { text: string }[] }).content[0].text, /1m ago/);
});
