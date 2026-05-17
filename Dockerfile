# syntax=docker/dockerfile:1.7

# ---------- builder ----------
# Full Node + dev deps; compile TypeScript once.
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime ----------
# Slim image with only the compiled JS and prod deps. Driven over stdio by
# an MCP host (Claude Desktop, Cursor, etc.).
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Mount your mcp.json at /app/mcp.json (auto-discovered) or pass `-c <path>`.
# For offload output, mount a writable volume and set `middleware.offload.dir`
# in your mcp.json to that path (e.g. /exports).
ENTRYPOINT ["node", "/app/dist/index.js"]
