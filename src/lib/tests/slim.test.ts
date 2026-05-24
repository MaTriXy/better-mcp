import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSlimConfig, slimSchema, slimTool } from "../slim.js";

const defaults = resolveSlimConfig(undefined);
if (!defaults) throw new Error("expected non-null defaults");

test("resolveSlimConfig(false) returns null (disabled)", () => {
  assert.equal(resolveSlimConfig(false), null);
});

test("resolveSlimConfig(undefined) enables defaults", () => {
  assert.equal(defaults.stripPropertyDescriptions, false);
  assert.equal(defaults.maxDescriptionLength, 0);
  for (const f of ["$schema", "$id", "$comment", "title", "examples", "default"]) {
    assert.ok(defaults.stripSchemaFields.has(f), `expected default strip set to include ${f}`);
  }
});

test("slimSchema strips top-level $schema/title/examples/default", () => {
  const out = slimSchema(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Args",
      type: "object",
      examples: [{ a: 1 }],
      default: { a: 0 },
      properties: { a: { type: "number" } },
    },
    defaults,
  );
  assert.deepEqual(out, { type: "object", properties: { a: { type: "number" } } });
});

test("slimSchema drops empty required[] and enum[]", () => {
  const out = slimSchema(
    { type: "object", required: [], properties: { x: { type: "string", enum: [] } } },
    defaults,
  ) as { type: string; properties: { x: { type: string; enum?: unknown[] } } };
  assert.deepEqual(out, { type: "object", properties: { x: { type: "string" } } });
});

test("slimSchema keeps non-empty required and enum", () => {
  const out = slimSchema(
    { type: "object", required: ["x"], properties: { x: { type: "string", enum: ["a", "b"] } } },
    defaults,
  ) as { required: string[]; properties: { x: { enum: string[] } } };
  assert.deepEqual(out.required, ["x"]);
  assert.deepEqual(out.properties.x.enum, ["a", "b"]);
});

test("slimSchema keeps additionalProperties and format by default", () => {
  const out = slimSchema(
    { type: "object", additionalProperties: false, properties: { ts: { type: "string", format: "date-time" } } },
    defaults,
  ) as { additionalProperties: boolean; properties: { ts: { format: string } } };
  assert.equal(out.additionalProperties, false);
  assert.equal(out.properties.ts.format, "date-time");
});

test("slimSchema recurses into items and anyOf", () => {
  const out = slimSchema(
    {
      type: "array",
      items: { type: "object", title: "Item", properties: { x: { type: "number", default: 0 } } },
      anyOf: [{ title: "A" }, { title: "B", examples: [1] }],
    },
    defaults,
  ) as { items: { title?: string; properties: { x: { default?: unknown } } }; anyOf: object[] };
  assert.equal(out.items.title, undefined);
  assert.equal(out.items.properties.x.default, undefined);
  assert.deepEqual(out.anyOf, [{}, {}]);
});

test("slimSchema does not mutate input", () => {
  const input = { title: "keep me", type: "object" };
  const snap = JSON.stringify(input);
  slimSchema(input, defaults);
  assert.equal(JSON.stringify(input), snap);
});

test("maxDescriptionLength truncates with ellipsis", () => {
  const cfg = resolveSlimConfig({ maxDescriptionLength: 10 });
  if (!cfg) throw new Error("expected non-null cfg");
  const out = slimTool({ description: "this description is way too long", inputSchema: { type: "object" } }, cfg);
  assert.equal(out.description!.length, 10);
  assert.ok(out.description!.endsWith("…"));
});

test("maxDescriptionLength leaves short descriptions alone", () => {
  const cfg = resolveSlimConfig({ maxDescriptionLength: 50 });
  if (!cfg) throw new Error("expected non-null cfg");
  const out = slimTool({ description: "short", inputSchema: { type: "object" } }, cfg);
  assert.equal(out.description, "short");
});

test("stripPropertyDescriptions drops obvious duplicates", () => {
  const cfg = resolveSlimConfig({ stripPropertyDescriptions: true });
  if (!cfg) throw new Error("expected non-null cfg");
  const out = slimSchema(
    {
      type: "object",
      properties: {
        userId: { type: "string", description: "The user ID" },
        filePath: { type: "string", description: "Absolute file path to read" },
      },
    },
    cfg,
  ) as { properties: { userId: { description?: string }; filePath: { description?: string } } };
  assert.equal(out.properties.userId.description, undefined);
  assert.equal(out.properties.filePath.description, undefined);
});

test("stripPropertyDescriptions keeps real documentation", () => {
  const cfg = resolveSlimConfig({ stripPropertyDescriptions: true });
  if (!cfg) throw new Error("expected non-null cfg");
  const out = slimSchema(
    {
      type: "object",
      properties: {
        cursor: { type: "string", description: "Opaque pagination token returned by the previous call." },
        limit: { type: "number", description: "Max results per page; defaults to 20, capped at 100." },
      },
    },
    cfg,
  ) as { properties: { cursor: { description?: string }; limit: { description?: string } } };
  assert.ok(out.properties.cursor.description);
  assert.ok(out.properties.limit.description);
});

test("stripPropertyDescriptions off by default keeps everything", () => {
  const out = slimSchema(
    { type: "object", properties: { userId: { type: "string", description: "The user ID" } } },
    defaults,
  ) as { properties: { userId: { description?: string } } };
  assert.equal(out.properties.userId.description, "The user ID");
});

test("realistic catalog shrinks meaningfully", () => {
  const verbose = {
    type: "object",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "list_issues args",
    additionalProperties: false,
    required: [],
    properties: {
      state: { type: "string", title: "State", enum: ["open", "closed", "all"], default: "open", description: "Issue state filter" },
      labels: { type: "array", title: "Labels", items: { type: "string" }, examples: [["bug", "enhancement"]] },
      assignee: { type: "string", title: "Assignee", description: "The assignee login" },
    },
  };
  const before = JSON.stringify(verbose).length;
  const after = JSON.stringify(slimSchema(verbose, defaults)).length;
  assert.ok(after < before * 0.7, `expected >30% shrink, got ${before}→${after}`);
});
