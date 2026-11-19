#!/usr/bin/env bash
# ===================================================
# Upbit AutoCoinTrade - Cloudflare Public Tunnel Stopper
# - start_tunnel.sh와 100% 대칭 안전 종료 (Grace Period + 타 프로젝트 터널 보호)
# ===================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

FRONTEND_PORT="${FRONTEND_PORT:-9000}"

echo "==================================================="
echo "[Upbit AutoCoinTrade] 외부 접속 보안 터널 중지 중... (Port ${FRONTEND_PORT})"
echo "==================================================="

stop_tunnel_pid() {
    local pid=$1
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "터널 프로세스 안전 종료 [PID: $pid]..."
        kill -TERM "$pid" 2>/dev/null || true
        local i
        for i in $(seq 1 10); do
            if ! kill -0 "$pid" 2>/dev/null; then
                break
            fi
            sleep 0.5
        done
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    fi
}

PID_FILE="$PROJECT_ROOT/logs/.tunnel.pid"
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || true)
    stop_tunnel_pid "$PID"
    rm -f "$PID_FILE"
fi

# 잔여 cloudflared 폴백 정리 (본 프로젝트 FRONTEND_PORT 전용 터널만 안전 종료하여 타 프로젝트 터널 보호)
if command -v pgrep >/dev/null 2>&1; then
    for tp in $(pgrep -f "cloudflared.*(127\.0\.0\.1|localhost):${FRONTEND_PORT}" 2>/dev/null || true); do
        stop_tunnel_pid "$tp"
    done
else
    pkill -f "cloudflared.*:${FRONTEND_PORT}" >/dev/null 2>&1 || true
fi

echo "==================================================="
echo "[완료] 외부 접속 터널이 안전하게 종료되었습니다."
echo "==================================================="
