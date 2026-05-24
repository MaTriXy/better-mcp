import { test } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackHost } from "../paths.js";

test("isLoopbackHost recognizes localhost variants", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});
