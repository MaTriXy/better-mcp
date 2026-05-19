#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { bootstrap } from "./app/bootstrap.js";

const entryDir = dirname(fileURLToPath(import.meta.url));

bootstrap({ entryDir }).catch((err) => {
  process.stderr.write(
    `[better-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
