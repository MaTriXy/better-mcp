import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, makeRedactWalk } from "../redact.js";

test("empty patterns returns identity function", () => {
  const walk = makeRedactWalk([]);
  const input = { password: "secret", nested: { token: "x" } };
  // No copy, no mutation — same reference back.
  assert.equal(walk(input), input);
});

test("REDACTED constant is the literal `[REDACTED]` string", () => {
  assert.equal(REDACTED, "[REDACTED]");
});

test("redacts a top-level key whose name contains the pattern (case-insensitive)", () => {
  const walk = makeRedactWalk(["password"]);
  assert.deepEqual(walk({ Password: "hunter2", user: "alice" }), {
    Password: REDACTED,
    user: "alice",
  });
});

test("matches partial key — pattern `token` redacts `api_token`, `accessToken`, etc.", () => {
  const walk = makeRedactWalk(["token"]);
  assert.deepEqual(
    walk({ api_token: "x", accessToken: "y", refresh_token: "z", unrelated: "ok" }),
    { api_token: REDACTED, accessToken: REDACTED, refresh_token: REDACTED, unrelated: "ok" },
  );
});

test("walks nested objects and redacts at every depth", () => {
  const walk = makeRedactWalk(["secret"]);
  assert.deepEqual(
    walk({
      level1: {
        level2: {
          secret: "deep",
          public: 42,
        },
      },
    }),
    { level1: { level2: { secret: REDACTED, public: 42 } } },
  );
});

test("walks arrays — elements get processed but array stays an array", () => {
  const walk = makeRedactWalk(["password"]);
  const out = walk([{ user: "a", password: "x" }, { user: "b", password: "y" }]);
  assert.deepEqual(out, [
    { user: "a", password: REDACTED },
    { user: "b", password: REDACTED },
  ]);
});

test("multiple patterns: any match triggers redaction", () => {
  const walk = makeRedactWalk(["password", "token", "api_key"]);
  assert.deepEqual(walk({ Password: 1, MY_TOKEN: 2, api_key: 3, name: "ok" }), {
    Password: REDACTED,
    MY_TOKEN: REDACTED,
    api_key: REDACTED,
    name: "ok",
  });
});

test("primitives pass through untouched at the root", () => {
  const walk = makeRedactWalk(["password"]);
  assert.equal(walk("a string"), "a string");
  assert.equal(walk(42), 42);
  assert.equal(walk(true), true);
  assert.equal(walk(null), null);
  assert.equal(walk(undefined), undefined);
});

test("redaction REPLACES the whole value — even if the value is itself a nested object", () => {
  // The whole `credentials` subtree is replaced, regardless of what's inside.
  // This is intentional: a matching key means the value is sensitive in full.
  const walk = makeRedactWalk(["credentials"]);
  assert.deepEqual(walk({ credentials: { user: "a", pass: "b" } }), { credentials: REDACTED });
});

test("does not mutate input", () => {
  const walk = makeRedactWalk(["password"]);
  const input = { password: "x", nested: { keep: "me" } };
  const snap = JSON.stringify(input);
  walk(input);
  assert.equal(JSON.stringify(input), snap);
});

test("non-matching keys are preserved as-is", () => {
  const walk = makeRedactWalk(["password"]);
  const input = { user: "alice", email: "a@b" };
  assert.deepEqual(walk(input), input);
});

test("empty object passes through cleanly", () => {
  const walk = makeRedactWalk(["password"]);
  assert.deepEqual(walk({}), {});
});

test("pattern matching is substring, not whole-word", () => {
  // `pass` will redact any key containing `pass` — `password`, `passcode`,
  // `passenger_count`, etc. Worth knowing for pattern choice.
  const walk = makeRedactWalk(["pass"]);
  assert.deepEqual(walk({ passenger_count: 5, password: "x" }), {
    passenger_count: REDACTED,
    password: REDACTED,
  });
});
