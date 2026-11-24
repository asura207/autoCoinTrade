#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/data /app/logs /app/config 2>/dev/null || true

if [ ! -f /app/config/upbit_config.json ] && [ -f /app/config/upbit_config.example.json ]; then
    cp /app/config/upbit_config.example.json /app/config/upbit_config.json 2>/dev/null || true
fi

if [ "${1:-}" = "--all" ]; then
    node /app/backend/common/log_rotator.mjs --startup >/dev/null 2>&1 || true
    node /app/backend/node_server.mjs &
    BACKEND_PID=$!
    FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}" \
    FRONTEND_PORT="${FRONTEND_PORT:-9000}" \
    BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:${BACKEND_PORT:-8001}}" \
    node /app/frontend/server.mjs &
    FRONTEND_PID=$!

    trap 'kill -TERM "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true; wait' INT TERM
    wait -n "$BACKEND_PID" "$FRONTEND_PID"
    EXIT_CODE=$?
    kill -TERM "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
    wait
    exit "$EXIT_CODE"
fi

exec "$@"
