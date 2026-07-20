# Build context: mcp-server/ directory
# Usage: docker build -t oas-mcp-remote ./mcp-server
FROM oven/bun:1.3.11 AS builder
WORKDIR /app
COPY package.json ./
RUN bun install
COPY src/ src/
COPY build.ts ./
COPY mcp-icon.png ./
RUN bun run build:remote

FROM oven/bun:1.3.11-slim
WORKDIR /app
COPY --chown=1001:1001 --from=builder /app/dist-remote/remote.js ./remote.js
COPY --chown=1001:1001 --from=builder /app/dist-remote/mcp-icon.png ./mcp-icon.png
USER 1001:1001
EXPOSE 8080
ENV PORT=8080
CMD ["bun", "run", "remote.js"]
