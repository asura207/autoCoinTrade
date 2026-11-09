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
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"

cd "$PROJECT_ROOT/frontend"
mkdir -p "$PROJECT_ROOT/logs"

if [ ! -d "node_modules/vite" ]; then
    echo "[Frontend] Dependencies not found. Running npm install..."
    npm install
fi

echo "[Frontend] Starting Vite Dev Server on port ${FRONTEND_PORT}..."
exec npx vite --port "${FRONTEND_PORT}" --host "${FRONTEND_HOST}"
