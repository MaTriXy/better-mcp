// Quick smoke-test harness for the offload middleware. Not part of the build.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeOffloader, resolveOffloadConfig, inferArrayInterface } from "./dist/middleware/offload.middleware.js";

async function run() {
  const dir = await mkdtemp(join(tmpdir(), "better-mcp-test-"));
  const opts = resolveOffloadConfig({ thresholdBytes: 1024, dir }, dir);

  const offloader = makeOffloader(opts);
  const req = { server: "github", kind: "tool", name: "list_issues", params: {} };

  // Case 1: oversize JSON array inside the standard MCP text-content wrapper.
  const issues = Array.from({ length: 50 }, (_, i) => ({
    id: i,
    number: i + 1,
    title: `Issue ${i}`,
    state: i % 2 ? "open" : "closed",
    labels: i % 3 ? [{ name: "bug", color: "red" }] : [],
    assignee: i % 5 ? { login: `user${i}` } : null,
  }));
  const arrayResp = {
    result: { content: [{ type: "text", text: JSON.stringify(issues) }], isError: false },
    durationMs: 12,
  };
  const out1 = await offloader.after(req, arrayResp);
  console.log("=== Case 1: oversize array ===");
  console.log(out1?.result?.content?.[0]?.text);

  // Re-open the saved file and confirm we persisted the *parsed* data, not the wrapper.
  const m = /response exported to: (.*\.json)/.exec(out1?.result?.content?.[0]?.text ?? "");
  if (m) {
    const persisted = JSON.parse(await readFile(m[1], "utf8"));
    console.log("persisted is array:", Array.isArray(persisted), "length:", persisted.length);
    console.log("first item:", JSON.stringify(persisted[0]));
  }

  // Case 2: oversize non-JSON text payload.
  const blob = "x".repeat(3000);
  const nonJsonResp = {
    result: { content: [{ type: "text", text: blob }], isError: false },
    durationMs: 5,
  };
  const out2 = await offloader.after(req, nonJsonResp);
  console.log("\n=== Case 2: oversize non-JSON text ===");
  console.log(out2?.result?.content?.[0]?.text);

  // Case 3: small response — should pass through unchanged.
  const small = {
    result: { content: [{ type: "text", text: "tiny ok" }], isError: false },
    durationMs: 1,
  };
  const out3 = await offloader.after(req, small);
  console.log("\n=== Case 3: small response (pass-through) ===");
  console.log("returned anything?", out3 !== undefined);

  // Case 4: interface inference unit tests.
  console.log("\n=== Case 4: interface inference ===");
  console.log(inferArrayInterface([{ id: 1, name: "x" }, { id: 2, name: "y", email: "a@b" }]));
  console.log(inferArrayInterface([1, "two", 3, null]));
  console.log(inferArrayInterface([]));
  console.log(inferArrayInterface([{ tags: ["a", "b"], meta: { v: 1 } }]));
}

run().catch((err) => { console.error(err); process.exit(1); });
