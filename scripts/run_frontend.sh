#!/usr/bin/env bash
# Upbit AutoCoinTrade - Frontend Runner (Linux)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

FRONTEND_PORT="${FRONTEND_PORT:-9000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"

cd "$PROJECT_ROOT/frontend"
mkdir -p "$PROJECT_ROOT/logs"

if [ ! -d "node_modules" ]; then
    echo "[Frontend] Dependencies not found. Running npm install..."
    npm install
fi

if [ ! -f "dist/index.html" ] || [ "src/App.jsx" -nt "dist/index.html" ] || [ "src/styles.css" -nt "dist/index.html" ] || [ "index.html" -nt "dist/index.html" ]; then
    echo "[Frontend] Building production static bundle (dist)..."
    npm run build
fi

node "$PROJECT_ROOT/backend/common/log_rotator.mjs" --startup >/dev/null 2>&1 || true

echo "[Frontend] Starting Hardened Static + Proxy Server on ${FRONTEND_HOST}:${FRONTEND_PORT}..."
exec node server.mjs
