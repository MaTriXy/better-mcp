import { test } from "node:test";
import assert from "node:assert/strict";
import { interpolateEnvString, interpolateEnvVars } from "../env.js";

const SAVED_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) delete process.env[key];
  }
  Object.assign(process.env, SAVED_ENV);
}

test("interpolateEnvString replaces env var", (t) => {
  t.after(restoreEnv);
  process.env.TEST_BETTER_MCP_TOKEN = "secret-value";
  assert.equal(interpolateEnvString("Bearer ${TEST_BETTER_MCP_TOKEN}"), "Bearer secret-value");
});

test("interpolateEnvString supports default when unset", (t) => {
  t.after(restoreEnv);
  delete process.env.MISSING_BETTER_MCP_VAR;
  assert.equal(interpolateEnvString("${MISSING_BETTER_MCP_VAR:-fallback}"), "fallback");
});

test("interpolateEnvVars walks nested objects", (t) => {
  t.after(restoreEnv);
  process.env.REMOTE_MCP_URL = "https://mcp.example.com/mcp";
  const out = interpolateEnvVars({
    mcpServers: {
      remote: { url: "${REMOTE_MCP_URL}" },
    },
  });
  assert.equal(out.mcpServers.remote.url, "https://mcp.example.com/mcp");
});
