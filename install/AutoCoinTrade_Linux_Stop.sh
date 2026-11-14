#!/usr/bin/env bash
# ============================================================================
# AutoCoinTrade - 원클릭 통합 종료기 (Linux)
# ============================================================================
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$INSTALL_DIR/app"

if [ -f "$APP_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$APP_DIR/.env"
    set +a
fi

BACKEND_PORT="${BACKEND_PORT:-8001}"
FRONTEND_PORT="${FRONTEND_PORT:-9000}"

echo "=============================================================="
echo "[AutoCoinTrade] 서비스 안전 종료 중... (Port ${BACKEND_PORT}, ${FRONTEND_PORT})"
echo "=============================================================="

kill_pid_file() {
    local pid_file=$1
    if [ -f "$pid_file" ]; then
        local pid
        pid=$(cat "$pid_file" 2>/dev/null || true)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
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
        rm -f "$pid_file"
    fi
}

# 1. 저장된 PID 파일 기반 종료
kill_pid_file "$APP_DIR/logs/.backend.pid"
kill_pid_file "$APP_DIR/logs/.frontend.pid"
kill_pid_file "$APP_DIR/logs/.orchestrator.pid"

# 2. 포트 점유 프로세스 안전 정리
kill_port() {
    local port=$1
    local pids=""
    if command -v fuser >/dev/null 2>&1; then
        pids=$(fuser "${port}/tcp" 2>/dev/null || true)
    elif command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -t -i ":${port}" 2>/dev/null || true)
    fi
    for p in $pids; do
        if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
            kill -TERM "$p" >/dev/null 2>&1 || true
            sleep 0.5
            if kill -0 "$p" 2>/dev/null; then
                kill -9 "$p" >/dev/null 2>&1 || true
            fi
        fi
    done
}

kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

# 3. 패키지 내부 잔여 워커 정리
if command -v pgrep >/dev/null 2>&1; then
    for pattern in "${APP_DIR}/backend/node_server.mjs" "${APP_DIR}/main_orchestrator.py" "${APP_DIR}/llm_filter_worker.py"; do
        for wp in $(pgrep -f "$pattern" 2>/dev/null || true); do
            if [ -n "$wp" ] && [ "$wp" != "$$" ] && kill -0 "$wp" 2>/dev/null; then
                kill -TERM "$wp" >/dev/null 2>&1 || true
                sleep 0.5
                kill -9 "$wp" >/dev/null 2>&1 || true
            fi
        done
    done
fi

echo ""
echo "=============================================================="
echo "[완료] AutoCoinTrade 백엔드, 웹 UI 및 워커 서비스가 안전하게 종료되었습니다."
echo "=============================================================="
echo ""
