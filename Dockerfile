# ShareTool Docker Image
# ======================
# Multi-stage build: builder + runtime
#
# Build: docker build -t sharetool .
# Run:   docker run -d -p 18790:18790 -p 18791:18791 \
#          -v sharetool-data:/data \
#          -e SHARETOOL_PORT=18790 \
#          --name sharetool \
#          sharetool

# ============================================================
# Stage 1: Builder
# ============================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 (native module)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

# Install node modules (including native modules)
COPY package*.json ./
RUN npm ci --only=production=false

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM node:22-alpine AS runtime

LABEL maintainer="guige"
LABEL description="ShareTool - Local LAN file sharing tool"

# Runtime dependencies
RUN apk add --no-cache dumb-init

# Data volume
VOLUME ["/data"]

# Environment defaults
ENV SHARETOOL_PORT=18790 \
    SHARETOOL_WS_PORT=18791 \
    SHARETOOL_DB_PATH=/data/share-tool.db \
    SHARETOOL_LOG_LEVEL=info \
    SHARETOOL_HTTPS=true \
    NODE_ENV=production

# Exposed ports
# 18790: HTTP/HTTPS API
# 18791: WebSocket sync
EXPOSE 18790 18791

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:${SHARETOOL_PORT}/api/health || exit 1

# Copy app from builder
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server.js ./
COPY --from=builder /app/db.js ./
COPY --from=builder /app/crypto.js ./
COPY --from=builder /app/cli.js ./
COPY --from=builder /app/routes ./routes
COPY --from=builder /app/public ./public 2>/dev/null || true

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
