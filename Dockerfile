# Stage 1: Frontend Production Build (Vite + React)
FROM node:22-slim AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Stage 2: Production Runtime (Node.js 22 + Python 3)
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Seoul \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=8001 \
    DB_MODE=sqlite \
    PG_SYNC_ENABLED=false \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    ca-certificates \
    curl \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Backend Node.js dependencies
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Python dependencies inside isolated virtualenv
COPY requirements.txt ./
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /app/.venv/bin/pip install --no-cache-dir -r requirements.txt

# Copy backend & Python sources + compiled frontend dist
COPY backend/ ./backend/
COPY config/upbit_config.example.json ./config/upbit_config.example.json
COPY agentBot/ ./agentBot/
COPY *.py ./
COPY history.md README.md ./
COPY --from=frontend-builder /build/frontend/dist ./frontend/dist

# Non-root user & persistent writable directories
RUN groupadd -r autocoin && useradd -r -g autocoin -m autocoin \
    && mkdir -p /app/data /app/logs /app/config \
    && chown -R autocoin:autocoin /app

USER autocoin

EXPOSE 8001

VOLUME ["/app/data", "/app/config", "/app/logs"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8001/api/version || exit 1

CMD ["node", "backend/node_server.mjs"]
