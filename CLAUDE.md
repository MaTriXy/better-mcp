# CLAUDE.md

Project-specific guidance for Claude Code working in this repo.

## Testing

**Always add unit tests for new behavior.** Any time you add a new function,
exported helper, or non-trivial code path, ship a test for it in the same PR.
Pure wiring (one-line pass-throughs that TypeScript already validates) is the
only exception — and even then prefer extracting a small testable helper.

If something is hard to test, that's a signal to refactor — extract the pure
core (like `buildListedTools` in `src/services/proxy.service.ts`) so the test
can call it directly without spinning up an MCP server, Express app, or child
process.

### Test convention

Tests live **next to the source they cover**, in a `tests/` subfolder:

```
src/lib/slim.ts                  →  src/lib/tests/slim.test.ts
src/middleware/compact.middleware.ts → src/middleware/tests/compact.middleware.test.ts
src/services/proxy.service.ts    →  src/services/tests/proxy.service.test.ts
```

One `.test.ts` file per source file. When you add a new source file, create
its `tests/` sibling and write the test there. Tests are TypeScript, run
directly from `src/` via Node's built-in test runner + tsx loader — no
compile step needed for tests.

Pattern to follow (see `src/lib/tests/slim.test.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { thing } from "../thing.js";   // .js extension is the project import convention

test("describes the behavior", () => {
  assert.equal(thing(1), 2);
});

test("async case", async () => {
  assert.equal(await thing.async(1), 2);
});
```

### Running tests

```
npm test            # node --import tsx --test 'src/**/*.test.ts'
npm run test:build  # build first, then test (catches type errors too)
```

The `test` script globs every `*.test.ts` under `src/`; you don't need to
register individual test files anywhere. Tests are excluded from `tsc` build
(see `tsconfig.json` `exclude`), so they never land in `dist/` and never ship
in the npm package.

Run a single file directly during development: `node --import tsx --test
src/lib/tests/slim.test.ts`.

## Build

- `npm run build` — `tsc` compiles `src/` to `dist/`.
- Tests import from `dist/`, so a build is required before running them
  (`npm test` does this automatically; standalone `node test-*.mjs` does not).

## Code style

- Pure helpers go in `src/lib/`. Middleware goes in `src/middleware/`.
  Services (proxy, upstream) in `src/services/`. Controllers (HTTP) in
  `src/controllers/`.
- Prefer extracting a named pure function over inlining logic in a handler —
  it makes the behavior unit-testable and keeps handlers small.
- Default to no comments. Only explain *why* when it's non-obvious.
