import assert from "node:assert/strict";
import { interpolateEnvString, interpolateEnvVars } from "./dist/lib/env.js";
import { isLoopbackHost } from "./dist/config/index.js";

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

try {
  test("interpolateEnvString replaces env var", () => {
    process.env.TEST_BETTER_MCP_TOKEN = "secret-value";
    assert.equal(interpolateEnvString("Bearer ${TEST_BETTER_MCP_TOKEN}"), "Bearer secret-value");
  });

  test("interpolateEnvString supports default when unset", () => {
    delete process.env.MISSING_BETTER_MCP_VAR;
    assert.equal(interpolateEnvString("${MISSING_BETTER_MCP_VAR:-fallback}"), "fallback");
  });

  test("interpolateEnvVars walks nested objects", () => {
    process.env.REMOTE_MCP_URL = "https://mcp.example.com/mcp";
    const out = interpolateEnvVars({
      mcpServers: {
        remote: { url: "${REMOTE_MCP_URL}" },
      },
    });
    assert.equal(out.mcpServers.remote.url, "https://mcp.example.com/mcp");
  });

  test("isLoopbackHost recognizes localhost variants", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
  });
} finally {
  restoreEnv();
}

console.log("test-config: all passed");
