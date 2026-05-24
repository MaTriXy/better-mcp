import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { makeBearerAuth } from "../auth.middleware.js";

/**
 * Build a minimal Express-like req/res pair. We only stub the surface the
 * middleware actually touches: `req.headers.authorization`, `res.status()`,
 * `res.json()`. Keeps the test free of an express dependency.
 */
function harness(authorization?: string) {
  const req = { headers: { authorization } } as unknown as Request;

  let statusCode: number | undefined;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  } as unknown as Response;

  let nextCalled = 0;
  const next: NextFunction = () => {
    nextCalled++;
  };

  return {
    req,
    res,
    next,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get nextCalled() {
      return nextCalled;
    },
  };
}

test("correct Bearer token calls next() and writes no response", () => {
  const auth = makeBearerAuth("secret-token");
  const h = harness("Bearer secret-token");
  auth(h.req, h.res, h.next);
  assert.equal(h.nextCalled, 1);
  assert.equal(h.statusCode, undefined);
  assert.equal(h.body, undefined);
});

test("missing Authorization header → 401 with JSON-RPC error payload", () => {
  const auth = makeBearerAuth("secret-token");
  const h = harness(undefined);
  auth(h.req, h.res, h.next);
  assert.equal(h.nextCalled, 0);
  assert.equal(h.statusCode, 401);
  assert.deepEqual(h.body, {
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
});

test("wrong Bearer token → 401, next not called", () => {
  const auth = makeBearerAuth("secret-token");
  const h = harness("Bearer wrong-token");
  auth(h.req, h.res, h.next);
  assert.equal(h.nextCalled, 0);
  assert.equal(h.statusCode, 401);
});

test("scheme is case-sensitive — `bearer` (lowercase) is rejected", () => {
  // Strict string equality is intentional: we accept exactly `Bearer <token>`.
  // Worth noting because some HTTP clients lowercase headers/values.
  const auth = makeBearerAuth("secret-token");
  const h = harness("bearer secret-token");
  auth(h.req, h.res, h.next);
  assert.equal(h.nextCalled, 0);
  assert.equal(h.statusCode, 401);
});

test("token mismatch on prefix (`Bearer secret-token-extra`) → 401", () => {
  const auth = makeBearerAuth("secret-token");
  const h = harness("Bearer secret-token-extra");
  auth(h.req, h.res, h.next);
  assert.equal(h.nextCalled, 0);
  assert.equal(h.statusCode, 401);
});

test("empty token configured + matching empty Bearer still requires the literal `Bearer ` prefix", () => {
  const auth = makeBearerAuth("");
  const h = harness("Bearer ");
  auth(h.req, h.res, h.next);
  // `Bearer ${""}` is `Bearer `, so this matches.
  assert.equal(h.nextCalled, 1);
});

test("only the Authorization header is consulted (not other auth-like headers)", () => {
  const auth = makeBearerAuth("secret-token");
  const req = { headers: { "x-api-key": "secret-token" } } as unknown as Request;
  let statusCode: number | undefined;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json() {
      return res;
    },
  } as unknown as Response;
  let nextCalled = 0;
  auth(req, res, () => {
    nextCalled++;
  });
  assert.equal(nextCalled, 0);
  assert.equal(statusCode, 401);
});

test("each invocation is independent — middleware factory returns a fresh closure", () => {
  // Sanity: makeBearerAuth produces a stateless function. Two requests in a row
  // with the same token both succeed; the function holds no per-call state.
  const auth = makeBearerAuth("t");
  for (let i = 0; i < 3; i++) {
    const h = harness("Bearer t");
    auth(h.req, h.res, h.next);
    assert.equal(h.nextCalled, 1);
  }
});
