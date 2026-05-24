# @qelos/better-mcp

A stdio MCP proxy that connects to one or more upstream MCP servers and exposes
their **tools, resources, and prompts** through a single endpoint — with a
configurable middleware pipeline (logging, per-tool flow tracing, redaction,
oversize-response offloading, and your own `before` / `after` hooks) wrapping
every call.

```
┌──────────┐  stdio   ┌────────────┐  stdio   ┌──────────────────┐
│  Client  │ ───────▶ │ better-mcp │ ───────▶ │ fs MCP server    │
│ (Claude, │          │ middleware │          ├──────────────────┤
│  Cursor, │          │  pipeline  │ ───────▶ │ github MCP server│
│  etc.)   │          └────────────┘          ├──────────────────┤
└──────────┘                                  │ …more upstreams  │
                                              └──────────────────┘
```

## Install

You can run `better-mcp` two ways. Pick whichever fits your host config.

### Option A — npm

```bash
# One-shot, no install
npx -y @qelos/better-mcp

# Or install globally
npm install -g @qelos/better-mcp
better-mcp
```

Wire it into Claude Desktop / Cursor:

```json
{
  "mcpServers": {
    "proxy": {
      "command": "npx",
      "args": ["-y", "@qelos/better-mcp", "-c", "/abs/path/to/mcp.json"]
    }
  }
}
```

### Option B — Docker (GHCR)

The image is published to GitHub Container Registry as a public package:

```bash
docker pull ghcr.io/qelos/better-mcp:latest
```

Run it, mounting your `mcp.json` so the proxy can find it at `/app/mcp.json`
(the default discovery path inside the container). If you use offload, also
mount a writable directory and point `middleware.offload.dir` at it.

```bash
docker run --rm -i \
  -v "$PWD/mcp.json:/app/mcp.json:ro" \
  -v "$PWD/exports:/exports" \
  ghcr.io/qelos/better-mcp:latest
```

Wire it into a host:

```json
{
  "mcpServers": {
    "proxy": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "/abs/path/to/mcp.json:/app/mcp.json:ro",
        "-v", "/abs/path/to/exports:/exports",
        "ghcr.io/qelos/better-mcp:latest"
      ]
    }
  }
}
```

Notes for Docker:

- Use `-i` (no `-t`) — the proxy speaks MCP over stdio.
- Any upstream MCP servers listed in `mcp.json` need to be runnable **inside
the container**. The image has `node` and `npx`, so `npx -y @modelcontextprotocol/server-`*
works out of the box. If an upstream needs Python, Docker-in-Docker, or other
toolchains, build a derived image.
- For per-server secrets, pass them through with `-e GITHUB_PERSONAL_ACCESS_TOKEN=…`.

### Option C — Build from source

```bash
git clone https://github.com/qelos/better-mcp.git
cd better-mcp
npm install
npm run build
node dist/index.js
```

## Run

The proxy uses the same `mcp.json` shape as Cursor and Claude Desktop. By
default it looks for one automatically; you only need `-c` to override.

```bash
# Auto-discover mcp.json (see "Config location" below)
better-mcp

# Or point at a specific file
better-mcp -c ./examples/mcp.json
better-mcp --config /abs/path/to/mcp.json

# Or pass via env (inline JSON or a path)
MCP_PROXY_CONFIG=./examples/mcp.json better-mcp
MCP_PROXY_CONFIG='{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}}' better-mcp
```

### Config location

Resolved in this order — the first hit wins:

1. `-c <path>` / `--config <path>` CLI flag
2. `MCP_PROXY_CONFIG` env var (inline JSON, or a path)
3. `mcp.json` next to the entry script (e.g. `dist/mcp.json`, or `/app/dist/mcp.json` inside Docker)
4. `mcp.json` one level up from the entry script (e.g. project root, or `/app/mcp.json` inside Docker)
5. `mcp.json` in the current working directory

In practice: drop your `mcp.json` next to `package.json` (or mount it at
`/app/mcp.json` in Docker) and it just works.

## Popular MCP servers

Copy-paste configs for filesystem, GitHub, Postgres, Brave Search, Playwright,
Context7, memory, and more — plus a ready-made `[examples/mcp.popular.json](examples/mcp.popular.json)`.
See **[docs/popular-mcps.md](docs/popular-mcps.md)**.

## Config

```jsonc
{
  "mcpServers": {
    "<name>": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": { "FOO": "bar" },   // optional
      "cwd": "./somewhere",       // optional
      "enabled": true              // optional, default true
    }
  },

  // Prefix every tool/prompt with "<serverName>__". Default true.
  // Resources keep their original URIs (they're already namespaced by scheme).
  "namespace": true,

  "middleware": {
    // true = log to stderr, or pass { level, file } for control.
    // level "info" logs name + duration; "debug" also logs params + result.
    "log": { "level": "info" },

    // Field-name substrings (case-insensitive) whose values get replaced with
    // "[REDACTED]" in responses — useful for masking secrets in tool output.
    "redact": ["token", "password", "api_key", "authorization"],

    // Slim down `tools/list` by stripping JSON-Schema noise (`$schema`,
    // `title`, `examples`, `default`, empty `required`/`enum`, …) from
    // every tool's inputSchema. ON by default; set `false` to disable.
    // See "Slimming tools/list" below for the full set of knobs.
    "slim": true,

    // Compact responses: drop null-valued fields and minify JSON-in-text.
    // Affects the WIRE response only — the file written by `offload` keeps
    // full fidelity. ON by default; see "Compacting responses" below.
    "compact": {
      "dropNull": true,                       // default true
      "dropEmptyString": false,                // default false
      "dropEmptyArray": false,                 // default false
      "dropEmptyObject": false,                // default false
      "roundFloats": 0,                        // 0 = off; e.g. 4 → 0.1235
      "exclude": ["server-name", "server__tool"]  // skip per-server or per-tool
    },

    // Clean terminal noise from text blocks: ANSI escape sequences and
    // trailing whitespace per line. ON by default; see "Cleaning text" below.
    "cleantext": {
      "stripAnsi": true,                       // default true
      "trimTrailingWhitespace": true,          // default true
      "collapseBlankLines": false,             // default false (risky for markdown)
      "exclude": []
    },

    // Response dedup cache. When the same `(server, tool)` returns identical
    // bytes within TTL, replace the response with a short pointer. Useful for
    // polling tools that re-emit unchanged data. OPT-IN — see "Dedup" below.
    "dedup": {
      "ttlSeconds": 300,                       // default 300 (5 min)
      "maxEntries": 1000,                       // LRU cap
      "minBytes": 200,                          // skip dedup below this
      "includeResources": false,                // resources opt-in
      "exclude": []
    },

    // Offload oversize responses to a file and return a short pointer.
    // `true` enables defaults; pass an object to tune.
    "offload": {
      "thresholdBytes": 16384,         // default 16 KB
      "dir": "./exports",              // default <os.tmpdir()>/better-mcp
      "includeResources": false,        // default false (tools only)
      "inferArrayShape": true,          // default true
      "previewRows": 3,                 // first-N preview line; 0 disables
      "chapterMarkdown": true,           // split long markdown on H2 into chapters
      "perTool": {                       // per-server / per-tool overrides
        "fs__list_directory": { "thresholdBytes": 0 },   // always offload
        "github":             { "thresholdBytes": 32768 }, // higher cutoff for the whole server
        "weird-server":       false                       // never offload this server
      }
    },

    // Per-tool JSONL trace of the ENTIRE pipeline flow (request → each
    // middleware before → upstream → each middleware after → response).
    // `true` enables defaults; pass an object to tune.
    "trace": {
      "dir": "/abs/path/to/logs",       // default <os.tmpdir()>/better-mcp/trace
      "maxBodyBytes": 0,                 // 0 = full bodies (no cap)
      "redact": ["token", "password"],  // default: the `redact` list above
      "includeResources": false          // default false (tools only)
    },

    // Path to a JS/MJS module exporting `{ before, after }` hooks.
    // Relative paths resolve against the config file's directory.
    "hooks": "./middleware.js"
  }
}
```

CLI flags:

- `-c <path>` / `--config <path>` — path to `mcp.json` (overrides discovery + env).
- `--no-namespace` — disable the `<server>__<tool>` prefix at runtime.
- `--offload-resources` — also offload `resources/read` responses (same as
setting `middleware.offload.includeResources: true`, or
`MCP_PROXY_OFFLOAD_RESOURCES=1`).

## Middleware

Every upstream call passes through a small stack. Registration order is
`logger → offloader → redactor → user`, so the after-chain runs from inside
out:

```
client ─▶ logger.before ─▶ user.before ─▶ upstream
                                              │
                                              ▼
client ◀─ logger.after ◀─ offloader.after ◀─ redactor.after ◀─ user.after
```

User hooks see the raw request and the raw upstream response. Redaction cleans
that data, the offloader decides whether to write it to disk and replace the
response with a pointer, and the logger records what the client will ultimately
see.

The `**log**` middleware is itself a hook at the outermost position, so it only
sees the request before anyone touched it and the response after everyone did.
The `**trace**` feature is different: it's wired into the pipeline itself, not
into the hook chain, so it can record what *each* middleware changed. Use `log`
for a light one-line-per-call record; use `trace` when you need the full  
per-tool flow.

### Slimming `tools/list`

`tools/list` is resent to the model every conversation turn, so trimming the
catalog pays out per turn. By default the proxy strips a small set of
JSON-Schema annotations that the model doesn't need at call time:

- `$schema`, `$id`, `$comment`
- `title`, `examples`, `default`
- `required: []` and `enum: []` when empty (always, regardless of strip list)

Set `middleware.slim: false` to disable, or pass an object to tune:

```jsonc
"middleware": {
  "slim": {
    // Override the default strip list. Walk is recursive (descends into
    // `properties`, `items`, `anyOf`/`oneOf`/`allOf`, `patternProperties`, …).
    "stripSchemaFields": ["$schema", "title", "examples", "default"],

    // Drop a property's `description` when it's a short paraphrase of its name
    // (e.g. property `userId` with description "the user ID"). Off by default.
    "stripPropertyDescriptions": false,

    // Truncate each tool's top-level description to this many chars
    // (trailing `…`). 0 disables. Off by default — descriptions stay full.
    "maxDescriptionLength": 0
  }
}
```

What's *not* stripped by default: `additionalProperties`, `format`, per-property
`description`, `pattern`, `minimum`/`maximum`. Those carry real semantics that
the model can use.

### Compacting responses

For every tool/resource/prompt response, the proxy walks `content[].text`
blocks; when a text block holds parseable JSON (object or array), it drops
empty-valued fields and re-stringifies minified. Substitution only happens
when the result is strictly shorter, so this is idempotent on already-clean
payloads. Free-form text (prose, code, offload pointers) is never touched —
the parse-as-JSON precondition is the safety rail.

Compact runs **after** the offloader in the response chain, so the file written
to disk keeps the full original payload. Compact only changes what the client
receives.

```jsonc
"middleware": {
  "compact": {
    "dropNull": true,         // default true — drop fields whose value is `null`
    "dropEmptyString": false, // `""` vs missing is often meaningful
    "dropEmptyArray": false,  // `[]` usually means "no results", not missing
    "dropEmptyObject": false, // `{}` can be a deliberate empty container

    // Round JSON numbers to N decimal places. `0` (default) disables.
    // Integers and NaN/Infinity are untouched. Useful for floats from ML
    // scores, timestamps, lat/lng — but lossy, so opt in deliberately.
    //   0.123456789 → 0.1235 at precision 4 (≈45% byte saving per number)
    "roundFloats": 0,

    // Skip compaction for noisy servers/tools whose text payloads must
    // round-trip byte-identical (e.g. an html_dump or code_snippet tool).
    // Match by `"<server>"` (whole server) or `"<server>__<tool>"`.
    "exclude": ["weird-server", "weird-server__raw_html"]
  }
}
```

Set `compact: false` to disable entirely. The minification step (whitespace
stripping) is always on when compact is enabled — even with every `drop*`
knob off, a pretty-printed JSON response will round-trip to its minified form.

Note on array elements: compact **never drops elements from arrays** —
array length is treated as load-bearing. The drop-* knobs apply only to
object FIELDS.

### Cleaning text

For every tool/resource/prompt response, the proxy walks `content[].text`
blocks (whether or not they hold JSON) and strips terminal-style noise:

- **ANSI / CSI / OSC escape sequences** (`\x1b[31m…\x1b[0m`, terminal-title
  setters, cursor moves, …). Useless to a model, pure tokens.
- **Trailing whitespace per line** — `[ \t]+$` per line. No semantic value
  unless you're writing a markdown trailing-double-space line break.

```jsonc
"middleware": {
  "cleantext": {
    "stripAnsi": true,              // default true
    "trimTrailingWhitespace": true, // default true
    "collapseBlankLines": false,    // default false — risky for markdown that
                                    //   uses blank lines structurally
    "exclude": ["weird-server", "weird-server__raw_terminal"]
  }
}
```

Cleantext runs **after compact** in the response chain (so minified JSON
text — which is already trim — passes through unchanged), and **after
offload** (so the on-disk file keeps the original ANSI codes for forensic
value). Set `cleantext: false` to disable entirely.

### Dedup

Hash-based response cache for polling-style tools. When the proxy sees the
same `(server, tool, response-bytes)` within `ttlSeconds`, it replaces the
response with a short pointer instead of re-sending the full payload:

```
same response as 5s ago (sha:abc12345)
```

OFF by default — enable explicitly when you know you're polling. The pointer
changes what the client receives; most LLMs handle it fine, but it's a
behavioral change worth opting into.

```jsonc
"middleware": {
  "dedup": {
    "ttlSeconds": 300,        // default 300 (5 min)
    "maxEntries": 1000,        // LRU cap; oldest evicted on insert
    "minBytes": 200,           // skip dedup when response is smaller than this
    "includeResources": false, // resources opt-in (prompts never deduped)
    "exclude": ["weird-server", "weird-server__sometimes_caches_wrong"]
  }
}
```

How it works:

- Runs **after** compact + cleantext, so the hash covers the bytes the client
  actually receives (deterministic transforms don't invalidate cache hits).
- Cache key is `<server>__<tool>__<sha256-of-result-prefix>` — same content
  on different tools doesn't collide.
- Hash is `sha256(JSON.stringify(result))`, displayed as the first 8 hex
  chars. 32 bits of entropy is plenty for in-session dedup.
- TTL is enforced lazily on each access (no background sweep). Entries past
  TTL are dropped before the lookup; LRU eviction kicks in at `maxEntries`.
- A HIT bumps the entry to most-recent in LRU order but does NOT reset its
  `firstSeen` timestamp — the pointer's age reflects when the content was
  first observed.
- Per-process cache (per-pipeline). Shared across HTTP sessions naturally.
  Cleared on restart.

**Caveat:** tools whose responses embed timestamps, request IDs, or any
non-deterministic field will never dedup — bytes differ → not the same
response. That's correct behavior, but worth knowing before turning dedup on
for a tool that "feels like" it should hit and never does.

### Offloading oversize responses

When a tool response's JSON-serialized size exceeds `thresholdBytes`
(default 16 KB), the offloader:

1. Writes the full response to `<dir>/<server>__<tool>__<timestamp>.json`.
  If the response is the typical `{ content: [{ type: "text", text: "<JSON>" }] }`
   shape, the *parsed* inner JSON is saved instead of the wrapper.
2. Replaces the response with a short text message like:
  ```
   response exported to: /tmp/better-mcp/github__list_issues__2026-05-17T12-34-56-789Z.json
   size: 142.3 KB (145708 bytes)
   length: 1024
   interface: Array<{ id: number; number: number; title: string; state: string; labels: Array<{ name: string; color: string }>; assignee: { login: string } | null }>
   preview: {"cols":["id","number","title","state"],"rows":[[1,1,"First issue","open"],[2,2,"Second","closed"],[3,3,"Third","open"]]}
  ```
   `length`, `interface`, and `preview` only appear when the saved data is an
   array. The interface is inferred from a sample of up to 200 elements and
   depth-capped at 4 to keep it lean. The `preview` line shows the first
   `previewRows` items (default 3): homogeneous object arrays render as
   `{cols, rows}`; primitive or mixed arrays render as a JSON sample. Cell
   values are capped at 80 chars; tables wider than 12 columns are skipped.
   Set `previewRows: 0` to disable.

Tool responses are always considered. Resource reads are skipped by default;
flip `includeResources: true` (or pass `--offload-resources`) to include them.
Prompts are never offloaded.

#### Per-tool / per-server overrides

Some tools always cross the threshold and never benefit from inline text
(`fs__list_directory`, log dumps); others should never offload (small,
format-sensitive tools). Use `perTool` to override the global behaviour for
specific servers or tools without touching anyone else:

```jsonc
"offload": {
  "thresholdBytes": 16384,
  "perTool": {
    "fs__list_directory":  { "thresholdBytes": 0 },         // always offload
    "github__get_repo":    { "chapterMarkdown": false },     // disable chaptering here
    "github":              { "thresholdBytes": 32768 },      // higher cutoff for whole server
    "weird-server":        false,                            // never offload
    "weird-server__keepme": { "thresholdBytes": 0 }          // …except this one tool
  }
}
```

Rules:

- **Keys** use the `<server>__<tool>` / `<server>` convention (same as
  `exclude` elsewhere).
- **Object value** = `Partial<{ thresholdBytes, chapterMarkdown,
  inferArrayShape, previewRows }>` merged on top of the global config for
  matching calls. Unspecified knobs inherit from the global.
- **`false` sentinel** = skip offload entirely for that server/tool. Use
  this instead of `{ thresholdBytes: Infinity }`.
- **Specificity:** `<server>__<tool>` wins over `<server>` when both match.
  This lets you disable a whole server then re-enable one tool inside it.
- **Storage knobs (`dir`, `includeResources`) stay global** — they're not
  per-tool concerns.

`{ thresholdBytes: 0 }` means "every response length is `> 0`, so every
response offloads." Use it for tools whose output is always too large to be
useful inline.

#### Markdown chaptering

When an oversize response is a single text block (didn't parse as JSON) and
contains at least one H2 heading (`^## `), the offloader switches to markdown
mode: it writes the full text to `<base>.md` AND one `<base>__NN_<slug>.md`
sidecar per chapter, and returns a TOC pointer instead of the standard line:

```
markdown exported to: /tmp/better-mcp/jira__get_page__2026-05-17T….md
size: 142.3 KB (145708 bytes)
chapters:
 - 00 - page_title: /tmp/…__00_page_title.md
 - 01 - overview:   /tmp/…__01_overview.md
 - 02 - api_reference: /tmp/…__02_api_reference.md
```

This costs slightly more pointer bytes than the single-file version, but the
model can `read_file` just the chapter it needs on follow-up turns instead of
the whole document.

- The splitter is **code-block aware**: a `## ` line inside ```` ``` ```` or
  `~~~` won't trigger a split.
- Chapter 00 is the content before the first H2. Its slug comes from the
  first `# H1` line if one exists, else `intro`. Empty intros are skipped.
- Each chapter file includes its own heading line for context.
- Slugs are lowercase, diacritics stripped, non-alphanumeric → `_`, capped
  at 40 chars; falls back to `chapter` when nothing usable remains.
- Set `chapterMarkdown: false` to keep today's behavior (full file saved as
  a `.json` wrapper for everything that isn't a JSON array).
- If a chapter write fails mid-flight, the full `.md` file is still on disk
  and the pointer simply omits the failed entries — graceful degradation.

### Tracing the full pipeline (per-tool logs)

Set `middleware.trace` and every tool call is recorded to its own append-only
JSONL file:

```jsonc
"middleware": {
  "redact": ["token", "password", "api_token"],
  "trace": true                       // or { dir, maxBodyBytes, redact, includeResources }
}
```

- **One file per tool**: `<dir>/<server>__<tool>.jsonl`
(e.g. `jira__search_issues.jsonl`). Default `dir` is
`<os.tmpdir()>/better-mcp/trace`.
- **No per-tool setup** — it's automatic for every tool that gets called.
Resources/prompts are excluded unless `includeResources: true`.

#### What a trace looks like

One JSON object per line. Every line carries `ts`, `callId`, `seq`, `server`,
`tool`, `kind`, and `phase`. One call's lifecycle (here: a user hook that
mutated the request, then the `redact` middleware that cleaned the response):

```jsonc
{"ts":"…","callId":"a1f…","seq":0,"server":"jira","tool":"search_issues","kind":"tool","phase":"request","params":{"jql":"project = DEMO"}}
{… "seq":1,"phase":"before","mw":"user","changed":true,"durationMs":0,"params":{"jql":"project = DEMO","injectedByUser":true}}
{… "seq":2,"phase":"upstream","durationMs":214,"ok":true,"result":{"content":[{"type":"text","text":"{…}"}]}}
{… "seq":3,"phase":"after","mw":"user","changed":false,"durationMs":0}
{… "seq":4,"phase":"after","mw":"redact","changed":true,"durationMs":1,"result":{"content":[{"type":"text","text":"{…redacted…}"}]}}
{… "seq":5,"phase":"response","totalMs":216,"result":{…}}
```

Phases, in order: `request` → one `before` per middleware that has a `before`
hook → `upstream` → one `after` per middleware that has an `after` hook →
`response`. Each middleware step reports `mw` (`log`/`offload`/`redact`/`user`),
`changed` (did it return a modified request/response), and `durationMs`. A body
is included on a step **only when that step changed it**; `request`, `upstream`,
and `response` always carry the body. If a hook throws, its step is recorded
with an `error` field and the call still aborts as before.

#### Concurrency

Concurrent calls to the same tool write to the same file. Every event is a
self-contained line tagged with `callId` + a per-call `seq`, and writes are
serialized per file, so lines never tear. Reconstruct one flow with:

```bash
grep '"callId":"a1f…"' jira__search_issues.jsonl | jq -s 'sort_by(.seq)'
```

#### What to expect — important behaviors

- **Bodies are full by default** (`maxBodyBytes: 0`). Set a byte cap and larger
bodies become a `{ "truncated": true, "bytes", "sha256", "head" }`
placeholder instead.
- **Trace vs. offload**: the trace captures the **pre-offload** payload at the
inner `after` steps. With full bodies, a response that offload would shrink
still lands in the trace file at full size — that's the point (full fidelity
for debugging), but it means trace files can grow large. Cap with
`maxBodyBytes` if that matters.
- **Redaction**: the tracer sees raw, pre-redaction upstream data, so it scrubs
independently using `trace.redact` (falling back to `middleware.redact`).
Unlike the `redact` middleware, it also descends into **JSON embedded in
strings** — the common `content[].text` wrapper — so secrets there are caught.
It's still key-based: a secret that isn't the value of a key matching a
pattern won't be masked. Set your patterns deliberately, and treat the trace
directory as sensitive.
- **No rotation**: per-tool files append indefinitely. Rotate/prune them
yourself if volume is a concern.
- **Cost**: bodies are redacted and serialized on the call path before the
async write. It's a debugging/observability feature — leave it off in
latency-sensitive setups, or use `maxBodyBytes`.
- A config change (including enabling `trace`) only takes effect when the proxy
restarts — restart your MCP host after editing it.

### User hooks

```js
// middleware.js
export default {
  async before(req) {
    // req: { server, kind: "tool"|"resource"|"prompt", name, params, meta? }
    if (req.kind === "tool" && req.name === "write_file") {
      if (req.params?.path?.includes("/etc/")) {
        throw new Error("writes under /etc are blocked");
      }
    }
    return req; // or void to leave unchanged
  },

  async after(req, res) {
    // res: { result, durationMs, error? }
    if (res.durationMs > 2000) {
      process.stderr.write(`slow: ${req.server}/${req.name}\n`);
    }
    return res;
  },
};
```

Both hooks may be sync or async. Return the modified request/response, or
nothing to leave it as-is. Throwing inside `before` cancels the call; throwing
inside `after` surfaces as an MCP error to the client.

## What's proxied

- **tools/list** — aggregated from every connected server. Names are namespaced
as `<server>__<tool>` unless `namespace: false`.
- **tools/call** — routed to the right upstream based on the namespaced name.
- **resources/list** / **resources/read** — aggregated; URIs are kept as-is.
- **prompts/list** / **prompts/get** — aggregated; names are namespaced.

If two upstreams expose the same name (or resource URI), the proxy logs a
collision warning and the later one wins. Use `namespace: true` (the default)
to avoid this.

## Notes

- Logs go to **stderr** — stdout is reserved for the MCP protocol.
- A server that fails to start is logged and skipped; the rest still come up.
- `SIGINT` / `SIGTERM` closes every upstream cleanly before exit.

## Publishing

### npm (manual)

```bash
npm version <patch|minor|major>      # bumps + tags + commits
npm publish --access public           # public scoped package
git push --follow-tags
```

`publishConfig.access: "public"` is set in `package.json`, so the
`--access public` flag is just belt-and-suspenders.

### Docker (automated)

Every push to `main` and every `v*.*.*` tag triggers
`.github/workflows/docker-publish.yml`, which builds a multi-arch image
(`linux/amd64` + `linux/arm64`) and pushes to `ghcr.io/qelos/better-mcp`.
Tags pushed:

- branch pushes  → `:main`, `:sha-<short>`
- semver tags    → `:latest`, `:vX.Y.Z`, `:X.Y`, `:X`

The workflow also flips the package to public on first push (no-op afterwards).

## License

MIT