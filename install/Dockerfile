# ============================================================================
# AutoCoinTrade - Production Docker Image (Node.js 22 + Python 3 + SQLite/PG)
# ============================================================================
# Stage 1: Frontend Production Build (Vite + React)
FROM node:22-bookworm-slim AS frontend-builder

WORKDIR /build/frontend
COPY app/frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY app/frontend/ ./
RUN npm run build

# Stage 2: Production Runtime (Node.js 22 + Python 3 + PostgreSQL/SQLite Clients)
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Seoul \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=8001 \
    FRONTEND_HOST=0.0.0.0 \
    FRONTEND_PORT=9000 \
    BACKEND_URL=http://127.0.0.1:8001 \
    LIVE_EXECUTOR_OWNER=node \
    DB_MODE=postgres_hybrid \
    PG_SYNC_ENABLED=true \
    DB_PATH=data/auto_coin_trade.db \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    postgresql-client \
    sqlite3 \
    ca-certificates \
    curl \
    tzdata \
    && ln -snf /usr/share/zoneinfo/Asia/Seoul /etc/localtime \
    && echo "Asia/Seoul" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Backend Node.js dependencies (better-sqlite3 native build, pg, web-push)
COPY app/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/* /root/.cache/node-gyp /root/.npm

# Python virtualenv & quant/worker dependencies
COPY app/requirements.txt ./
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /app/.venv/bin/pip install --no-cache-dir -r requirements.txt

# Copy backend, frontend hardened server + built dist, Python bots & workers
COPY app/backend/ ./backend/
COPY app/frontend/server.mjs ./frontend/server.mjs
COPY --from=frontend-builder /build/frontend/dist ./frontend/dist
COPY app/config/upbit_config.example.json ./config/upbit_config.example.json
COPY app/agentBot/ ./agentBot/
COPY app/init_db.py app/bots.py app/market_hub.py app/llm_filter_worker.py app/main_orchestrator.py ./
COPY app/history.md ./history.md
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Writable runtime directories (owned by built-in UID/GID 1000 'node' user)
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data /app/logs /app/config \
    && chown -R node:node /app

USER node

EXPOSE 8001 9000

VOLUME ["/app/data", "/app/config", "/app/logs"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8001/api/version || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "backend/node_server.mjs"]
