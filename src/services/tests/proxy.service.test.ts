import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListedTools } from "../proxy.service.js";
import { resolveSlimConfig } from "../../lib/slim.js";

const noisyInputSchema = {
  type: "object",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "list_issues args",
  additionalProperties: false,
  required: [],
  properties: {
    state: { type: "string", title: "State", enum: ["open", "closed"], default: "open" },
    cursor: { type: "string", description: "Opaque pagination token." },
  },
};

function upstream(name: string, tools: { name: string; description?: string; inputSchema: unknown }[]) {
  return { name, tools };
}

test("namespace=true prefixes every public name with <server>__", () => {
  const out = buildListedTools(
    [upstream("github", [{ name: "list_issues", inputSchema: { type: "object" } }])],
    true,
    null,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "github__list_issues");
});

test("namespace=false keeps the original tool name", () => {
  const out = buildListedTools(
    [upstream("github", [{ name: "list_issues", inputSchema: { type: "object" } }])],
    false,
    null,
  );
  assert.equal(out[0].name, "list_issues");
});

test("slim=null is a pass-through (inputSchema unchanged)", () => {
  const out = buildListedTools(
    [upstream("gh", [{ name: "x", inputSchema: noisyInputSchema, description: "hi" }])],
    true,
    null,
  );
  assert.deepEqual(out[0].inputSchema, noisyInputSchema);
  assert.equal(out[0].description, "hi");
});

test("slim with defaults strips schema noise from inputSchema", () => {
  const out = buildListedTools(
    [upstream("gh", [{ name: "x", inputSchema: noisyInputSchema }])],
    true,
    resolveSlimConfig(true),
  );
  const s = out[0].inputSchema as Record<string, unknown>;
  assert.equal(s.$schema, undefined);
  assert.equal(s.title, undefined);
  assert.equal(s.required, undefined); // dropped because empty
  const props = s.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.state.title, undefined);
  assert.equal(props.state.default, undefined);
  // additionalProperties and non-empty enum stay
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(props.state.enum, ["open", "closed"]);
});

test("maxDescriptionLength flows through to tool descriptions", () => {
  const out = buildListedTools(
    [
      upstream("gh", [
        { name: "x", inputSchema: { type: "object" }, description: "a description that is definitely too long" },
        { name: "y", inputSchema: { type: "object" }, description: "short" },
      ]),
    ],
    true,
    resolveSlimConfig({ maxDescriptionLength: 12 }),
  );
  assert.equal(out[0].description!.length, 12);
  assert.ok(out[0].description!.endsWith("…"));
  assert.equal(out[1].description, "short"); // under cap
});

test("multiple upstreams are listed in order, each prefixed by its server", () => {
  const out = buildListedTools(
    [
      upstream("a", [{ name: "t1", inputSchema: { type: "object" } }]),
      upstream("b", [
        { name: "t2", inputSchema: { type: "object" } },
        { name: "t3", inputSchema: { type: "object" } },
      ]),
    ],
    true,
    null,
  );
  assert.deepEqual(out.map((t) => t.name), ["a__t1", "b__t2", "b__t3"]);
});

test("empty upstream list returns []", () => {
  assert.deepEqual(buildListedTools([], true, null), []);
  assert.deepEqual(buildListedTools([], true, resolveSlimConfig(true)), []);
});

test("upstream with no tools is skipped silently", () => {
  const out = buildListedTools(
    [
      upstream("empty", []),
      upstream("real", [{ name: "t", inputSchema: { type: "object" } }]),
    ],
    true,
    null,
  );
  assert.deepEqual(out.map((t) => t.name), ["real__t"]);
});

test("buildListedTools does not mutate upstream tool definitions", () => {
  const original = JSON.parse(JSON.stringify(noisyInputSchema));
  const tools = [{ name: "x", inputSchema: noisyInputSchema, description: "d" }];
  buildListedTools([upstream("gh", tools)], true, resolveSlimConfig(true));
  assert.deepEqual(noisyInputSchema, original);
});
