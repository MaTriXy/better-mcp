# @qelos/better-mcp

A stdio MCP proxy that connects to one or more upstream MCP servers and exposes
their **tools, resources, and prompts** through a single endpoint — with a
configurable middleware pipeline (logging, redaction, oversize-response
offloading, and your own `before` / `after` hooks) wrapping every call.

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
  the container**. The image has `node` and `npx`, so `npx -y @modelcontextprotocol/server-*`
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

    // Offload oversize responses to a file and return a short pointer.
    // `true` enables defaults; pass an object to tune.
    "offload": {
      "thresholdBytes": 16384,         // default 16 KB
      "dir": "./exports",              // default <os.tmpdir()>/better-mcp
      "includeResources": false,        // default false (tools only)
      "inferArrayShape": true           // default true
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
   ```

   `length` and `interface` only appear when the saved data is an array. The
   interface is inferred from a sample of up to 200 elements and depth-capped
   at 4 to keep it lean.

Tool responses are always considered. Resource reads are skipped by default;
flip `includeResources: true` (or pass `--offload-resources`) to include them.
Prompts are never offloaded.

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
