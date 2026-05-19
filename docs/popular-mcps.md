# Popular MCP servers (copy-paste configs)

Ready-made `mcp.json` snippets for common MCP servers. Same shape as [Cursor](https://cursor.com/docs/context/mcp) and Claude Desktop — use them directly or behind [@qelos/better-mcp](https://github.com/qelos/better-mcp) for logging, redaction, offloading, and tracing.

**Starter file:** copy [`examples/mcp.popular.json`](../examples/mcp.popular.json), delete servers you do not need, fill in secrets, then point better-mcp at it.

## Use with better-mcp

Host config (Cursor / Claude Desktop / VS Code) — one proxy, many upstreams:

```json
{
  "mcpServers": {
    "stack": {
      "command": "npx",
      "args": ["-y", "@qelos/better-mcp", "-c", "/abs/path/to/mcp.popular.json"]
    }
  }
}
```

`mcp.popular.json` body — delete unused `mcpServers` entries; keep `middleware` for logging/redaction/offload:

```json
{
  "mcpServers": { },
  "namespace": true,
  "middleware": {
    "log": { "level": "info" },
    "redact": [
      "token", "password", "api_key", "authorization", "secret",
      "email", "phone", "mobile", "ssn", "social_security", "birth", "dob",
      "address", "street", "postal", "zip", "passport", "license", "iban",
      "credit_card", "card_number", "first_name", "last_name", "full_name",
      "display_name", "ip_address", "national_id"
    ],
    "offload": { "thresholdBytes": 16384, "dir": "./exports" }
  }
}
```

Tool names are prefixed as `<server>__<tool>` when `namespace` is true (default).

### Secrets via environment

better-mcp expands `${VAR}` and `${VAR:-default}` in strings (URLs, env values, headers). Prefer env over literals in config files:

```json
"env": {
  "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
}
```

### Windows

Wrap `npx` with `cmd`:

```json
"filesystem": {
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\you\\projects"]
}
```

`uvx` entries stay as-is (`command`: `uvx`, …).

### Docker

The [better-mcp image](https://github.com/qelos/better-mcp#option-b--docker-ghcr) ships Node/npx only. Upstreams that need Python (`uvx`), Chromium (Puppeteer/Playwright), or host paths must run on the host or in a custom image. Pass secrets with `-e`.

---

## Quick reference

| Server key | What it does | Secret / setup |
|------------|----------------|----------------|
| `filesystem` | Read/write under allowed dirs | Paths in `args` |
| `github` | Issues, PRs, repos | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `memory` | Persistent knowledge graph | None |
| `sequential-thinking` | Structured reasoning steps | None |
| `postgres` | Read-only SQL + schema | Connection URL in `args` |
| `brave-search` | Web search | `BRAVE_API_KEY` |
| `playwright` | Browser automation (a11y tree) | `npx playwright install` once |
| `puppeteer` | Headless Chrome | Chromium in image/host |
| `slack` | Channels, messages | `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID` |
| `context7` | Live library docs | `CONTEXT7_API_KEY` (remote) |
| `everything` | MCP protocol demo / smoke test | None |
| `git` | Repo read/search | `uvx` + repo path |

Many community servers moved to [servers-archived](https://github.com/modelcontextprotocol/servers-archived) but **npm packages still publish** for GitHub, Postgres, Slack, etc. Current reference servers in the main repo: [Filesystem, Memory, Fetch (Python), Git (Python), …](https://github.com/modelcontextprotocol/servers).

---

## Files & repos

### Filesystem

```json
"filesystem": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/root"]
}
```

Use multiple roots: add more path arguments.

### Git (Python — `uvx`)

```json
"git": {
  "command": "uvx",
  "args": ["mcp-server-git", "--repository", "/path/to/repo"]
}
```

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) first.

### GitHub

```json
"github": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
  }
}
```

[Create a fine-grained or classic PAT](https://github.com/settings/tokens) with the scopes you need (repo, issues, PRs).

---

## Data

### PostgreSQL (read-only)

```json
"postgres": {
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-postgres",
    "postgresql://user:pass@localhost:5432/mydb"
  ]
}
```

Or pass the URL via env and keep it out of the file:

```json
"postgres": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"]
}
```

### SQLite

Community package (not in the current reference repo):

```json
"sqlite": {
  "command": "npx",
  "args": ["-y", "mcp-server-sqlite", "--db-path", "/path/to/app.db"]
}
```

---

## Web & search

### Brave Search

```json
"brave-search": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-brave-search"],
  "env": {
    "BRAVE_API_KEY": "${BRAVE_API_KEY}"
  }
}
```

[Brave Search API key](https://brave.com/search/api/). Brave also ships an [official MCP server](https://github.com/brave/brave-search-mcp-server) if you outgrow the archived reference package.

### Playwright (recommended for browser tools)

```json
"playwright": {
  "command": "npx",
  "args": ["-y", "@playwright/mcp@latest"]
}
```

One-time: `npx playwright install` (or `install chromium`).

### Puppeteer (heavier; needs Chrome/Chromium)

```json
"puppeteer": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
}
```

---

## Agent utilities

### Memory (knowledge graph)

```json
"memory": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-memory"]
}
```

### Sequential thinking

```json
"sequential-thinking": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
}
```

### Everything (smoke test / protocol demo)

```json
"everything": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-everything"]
}
```

---

## Comms

### Slack

```json
"slack": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-slack"],
  "env": {
    "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
    "SLACK_TEAM_ID": "${SLACK_TEAM_ID}"
  }
}
```

Bot token + workspace ID from your [Slack app](https://api.slack.com/apps). For maintained Slack MCPs see also [zencoderai/slack-mcp-server](https://github.com/zencoderai/slack-mcp-server).

---

## Documentation (remote HTTP)

### Context7 — live library docs

Remote upstream (no local `npx` process). better-mcp supports `url` + `headers`:

```json
"context7": {
  "url": "https://mcp.context7.com/mcp",
  "headers": {
    "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
  }
}
```

Free key: [context7.com/dashboard](https://context7.com/dashboard). Stdio alternative:

```json
"context7": {
  "command": "npx",
  "args": ["-y", "@upstash/context7-mcp"],
  "env": {
    "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
  }
}
```

---

## Kitchen-sink example

See [`examples/mcp.popular.json`](../examples/mcp.popular.json) — filesystem, GitHub, memory, sequential-thinking, postgres, brave-search, playwright, context7 (remote), with middleware enabled. Remove blocks you do not use.

Minimal two-server proxy config:

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}/projects"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  },
  "namespace": true,
  "middleware": {
    "log": { "level": "info" },
    "redact": ["token", "password", "api_key", "authorization", "email", "phone", "ssn", "address"]
  }
}
```

---

## More servers

- [MCP Registry](https://registry.modelcontextprotocol.io/) — browse published servers
- [Awesome MCP Servers](https://github.com/punkpeye/awesome-mcp-servers) — curated list
- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — reference implementations

When adding a new upstream, match its README `mcpServers` block verbatim, then nest it under `mcpServers` in your better-mcp config file.
