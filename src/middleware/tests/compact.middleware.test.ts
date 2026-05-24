import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactJsonString,
  compactResponse,
  compactValue,
  makeCompactor,
  resolveCompactConfig,
} from "../compact.middleware.js";

const dflt = resolveCompactConfig(undefined);
if (!dflt) throw new Error("expected non-null defaults");

// ---- resolveCompactConfig --------------------------------------------------

test("resolveCompactConfig(false) returns null (disabled)", () => {
  assert.equal(resolveCompactConfig(false), null);
});

test("resolveCompactConfig(undefined) enables defaults", () => {
  assert.equal(dflt.dropNull, true);
  assert.equal(dflt.dropEmptyString, false);
  assert.equal(dflt.dropEmptyArray, false);
  assert.equal(dflt.dropEmptyObject, false);
  assert.equal(dflt.exclude.size, 0);
});

test("resolveCompactConfig honors per-knob overrides", () => {
  const c = resolveCompactConfig({ dropNull: false, dropEmptyArray: true, exclude: ["gh"] });
  if (!c) throw new Error("expected non-null cfg");
  assert.equal(c.dropNull, false);
  assert.equal(c.dropEmptyArray, true);
  assert.ok(c.exclude.has("gh"));
});

test("resolveCompactConfig clamps roundFloats to a non-negative integer", () => {
  assert.equal(resolveCompactConfig({ roundFloats: 4 })!.roundFloats, 4);
  assert.equal(resolveCompactConfig({ roundFloats: 0 })!.roundFloats, 0);
  assert.equal(resolveCompactConfig({ roundFloats: -3 })!.roundFloats, 0);
  assert.equal(resolveCompactConfig({ roundFloats: 3.9 })!.roundFloats, 3);
  assert.equal(resolveCompactConfig(undefined)!.roundFloats, 0);
});

// ---- compactValue ----------------------------------------------------------

test("compactValue drops null fields (default)", () => {
  assert.deepEqual(compactValue({ a: 1, b: null, c: "x" }, dflt), { a: 1, c: "x" });
});

test("compactValue keeps empty string/array/object by default", () => {
  const v = { s: "", arr: [], obj: {}, n: 0, b: false };
  assert.deepEqual(compactValue(v, dflt), v);
});

test("dropEmptyString drops only empty strings", () => {
  const cfg = resolveCompactConfig({ dropEmptyString: true })!;
  assert.deepEqual(compactValue({ a: "", b: "x", c: " " }, cfg), { b: "x", c: " " });
});

test("dropEmptyArray drops only empty arrays (incl. arrays that emptied after recursion of element children)", () => {
  const cfg = resolveCompactConfig({ dropEmptyArray: true })!;
  const out = compactValue({ tags: [], items: [null], list: [1] }, cfg);
  assert.deepEqual(out, { items: [null], list: [1] });
});

test("dropEmptyObject drops {} after recursion if all keys removed", () => {
  const keep = compactValue({ meta: { x: null } }, dflt);
  assert.deepEqual(keep, { meta: {} });
  const drop = compactValue({ meta: { x: null } }, resolveCompactConfig({ dropEmptyObject: true })!);
  assert.deepEqual(drop, {});
});

test("array length is preserved (we never drop elements)", () => {
  assert.deepEqual(compactValue([null, 1, null], dflt), [null, 1, null]);
});

test("recurses into nested objects inside arrays", () => {
  const out = compactValue([{ a: 1, b: null }, { a: 2, b: null }], dflt);
  assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
});

test("primitive inputs pass through untouched", () => {
  assert.equal(compactValue(42, dflt), 42);
  assert.equal(compactValue("hello", dflt), "hello");
  assert.equal(compactValue(null, dflt), null);
});

// ---- roundFloats -----------------------------------------------------------

test("roundFloats off by default leaves numbers alone", () => {
  assert.equal(compactValue(0.123456789, dflt), 0.123456789);
});

test("roundFloats=4 rounds fractional numbers to 4 decimals", () => {
  const cfg = resolveCompactConfig({ roundFloats: 4 })!;
  assert.equal(compactValue(0.123456789, cfg), 0.1235);
  assert.equal(compactValue(-12.99999, cfg), -13);
  assert.equal(compactValue(40.7128123, cfg), 40.7128);
});

test("roundFloats leaves integers untouched", () => {
  const cfg = resolveCompactConfig({ roundFloats: 2 })!;
  assert.equal(compactValue(42, cfg), 42);
  assert.equal(compactValue(0, cfg), 0);
  assert.equal(compactValue(-1, cfg), -1);
  assert.equal(compactValue(1e10, cfg), 1e10);
});

test("roundFloats leaves non-finite numbers untouched", () => {
  const cfg = resolveCompactConfig({ roundFloats: 2 })!;
  assert.ok(Number.isNaN(compactValue(NaN, cfg)));
  assert.equal(compactValue(Infinity, cfg), Infinity);
  assert.equal(compactValue(-Infinity, cfg), -Infinity);
});

test("roundFloats walks into nested arrays + objects", () => {
  const cfg = resolveCompactConfig({ roundFloats: 2 })!;
  const out = compactValue(
    { score: 0.98765, coords: [40.7128123, -74.006012], meta: { ratio: 1.99999 } },
    cfg,
  );
  assert.deepEqual(out, { score: 0.99, coords: [40.71, -74.01], meta: { ratio: 2 } });
});

test("roundFloats + JSON minification shrinks long-float payloads", () => {
  const cfg = resolveCompactConfig({ roundFloats: 3 })!;
  const text = JSON.stringify({ vals: [0.123456789, 0.987654321, 0.555555555] }, null, 2);
  const out = compactJsonString(text, cfg);
  assert.ok(out.length < text.length / 2, `expected huge shrink, got ${text.length}→${out.length}`);
  const parsed = JSON.parse(out) as { vals: number[] };
  assert.deepEqual(parsed.vals, [0.123, 0.988, 0.556]);
});

// ---- compactJsonString -----------------------------------------------------

test("compactJsonString minifies pretty JSON", () => {
  const pretty = '{\n  "a": 1,\n  "b": 2\n}';
  assert.equal(compactJsonString(pretty, dflt), '{"a":1,"b":2}');
});

test("compactJsonString drops nulls AND minifies in one pass", () => {
  const pretty = '{\n  "a": 1,\n  "b": null\n}';
  assert.equal(compactJsonString(pretty, dflt), '{"a":1}');
});

test("compactJsonString returns original when no win", () => {
  const minified = '{"a":1,"b":2}';
  assert.equal(compactJsonString(minified, dflt), minified);
});

test("compactJsonString leaves non-JSON text alone", () => {
  const txt = "Hello, world!";
  assert.equal(compactJsonString(txt, dflt), txt);
});

test("compactJsonString leaves malformed JSON alone", () => {
  const broken = "{a: 1}";
  assert.equal(compactJsonString(broken, dflt), broken);
});

test("compactJsonString skips JSON primitives at root", () => {
  assert.equal(compactJsonString("42", dflt), "42");
  assert.equal(compactJsonString('"hi"', dflt), '"hi"');
});

test("compactJsonString handles arrays at the root", () => {
  const pretty = '[\n  1,\n  2,\n  3\n]';
  assert.equal(compactJsonString(pretty, dflt), "[1,2,3]");
});

test("compactJsonString handles leading whitespace", () => {
  const out = compactJsonString('   {"a":1, "b": null}', dflt);
  assert.equal(out, '{"a":1}');
});

// ---- compactResponse -------------------------------------------------------

test("compactResponse compacts text-block JSON in standard MCP shape", () => {
  const input = {
    content: [{ type: "text", text: '{"a":1,"b":null,"c":2}' }],
    isError: false,
  };
  const out = compactResponse(input, dflt) as typeof input;
  assert.notEqual(out, input);
  assert.equal(out.content[0].text, '{"a":1,"c":2}');
  assert.equal(out.isError, false);
});

test("compactResponse returns same ref when nothing changes", () => {
  const input = { content: [{ type: "text", text: "raw notes" }] };
  assert.equal(compactResponse(input, dflt), input);
});

test("compactResponse walks multiple text blocks", () => {
  const input = {
    content: [
      { type: "text", text: '{"a":1,"b":null}' },
      { type: "text", text: "plain text untouched" },
      { type: "text", text: '{"x":null,"y":2}' },
    ],
  };
  const out = compactResponse(input, dflt) as typeof input;
  assert.equal(out.content[0].text, '{"a":1}');
  assert.equal(out.content[1].text, "plain text untouched");
  assert.equal(out.content[2].text, '{"y":2}');
});

test("compactResponse leaves non-text blocks alone", () => {
  const input = {
    content: [
      { type: "image", data: "base64..." },
      { type: "text", text: '{"a":null,"b":1}' },
    ],
  };
  const out = compactResponse(input, dflt) as { content: { type: string; data?: string; text?: string }[] };
  assert.equal(out.content[0].type, "image");
  assert.equal(out.content[0].data, "base64...");
  assert.equal(out.content[1].text, '{"b":1}');
});

test("compactResponse leaves offload pointers alone (not parseable JSON)", () => {
  const pointer = {
    content: [{ type: "text", text: "response exported to: /tmp/x.json\nsize: 1KB" }],
    isError: false,
  };
  assert.equal(compactResponse(pointer, dflt), pointer);
});

test("compactResponse passes through non-object results", () => {
  assert.equal(compactResponse("plain string", dflt), "plain string");
  assert.equal(compactResponse(null, dflt), null);
  assert.equal(compactResponse(42, dflt), 42);
});

test("compactResponse passes through result with no content array", () => {
  const input = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(compactResponse(input, dflt), input);
});

// ---- makeCompactor (middleware shell) --------------------------------------

const makeReq = (server: string, name: string, kind: "tool" | "resource" | "prompt" = "tool") => ({
  server,
  kind,
  name,
  params: {},
});
const makeRes = (text: string) => ({ result: { content: [{ type: "text", text }] }, durationMs: 1 });

test("middleware compacts when not excluded", async () => {
  const mw = makeCompactor(resolveCompactConfig(undefined)!);
  const out = await mw.after!(makeReq("gh", "list_issues"), makeRes('{"a":1,"b":null}'));
  assert.ok(out);
  assert.equal((out.result as { content: { text: string }[] }).content[0].text, '{"a":1}');
});

test("middleware skips when entire server is excluded", async () => {
  const mw = makeCompactor(resolveCompactConfig({ exclude: ["gh"] })!);
  const out = await mw.after!(makeReq("gh", "list_issues"), makeRes('{"a":1,"b":null}'));
  assert.equal(out, undefined);
});

test("middleware skips when specific server__tool is excluded", async () => {
  const mw = makeCompactor(resolveCompactConfig({ exclude: ["gh__raw_html"] })!);
  const skipRes = await mw.after!(makeReq("gh", "raw_html"), makeRes('{"a":1,"b":null}'));
  assert.equal(skipRes, undefined);
  const goRes = await mw.after!(makeReq("gh", "list_issues"), makeRes('{"a":1,"b":null}'));
  assert.ok(goRes);
  assert.equal((goRes.result as { content: { text: string }[] }).content[0].text, '{"a":1}');
});

test("middleware ignores responses with upstream errors", async () => {
  const mw = makeCompactor(resolveCompactConfig(undefined)!);
  const errored = { result: undefined, durationMs: 1, error: { message: "boom" } };
  const out = await mw.after!(makeReq("gh", "x"), errored);
  assert.equal(out, undefined);
});

test("middleware is idempotent on already-minified responses", async () => {
  const mw = makeCompactor(resolveCompactConfig(undefined)!);
  const out = await mw.after!(makeReq("gh", "x"), makeRes('{"a":1,"b":2}'));
  assert.equal(out, undefined);
});

test("middleware works with different request kinds (resource, prompt)", async () => {
  const mw = makeCompactor(resolveCompactConfig(undefined)!);
  const res = await mw.after!(makeReq("fs", "file://x", "resource"), makeRes('{"a":1,"b":null}'));
  assert.ok(res);
  assert.equal((res.result as { content: { text: string }[] }).content[0].text, '{"a":1}');
});
