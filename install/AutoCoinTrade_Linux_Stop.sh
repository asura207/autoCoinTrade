#!/usr/bin/env bash
# ============================================================================
# AutoCoinTrade - 원클릭 통합 종료기 (Linux)
# ============================================================================
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$INSTALL_DIR/app"

echo "=============================================================="
echo "[AutoCoinTrade] 서비스 안전 종료 중..."
echo "=============================================================="

# 1. 저장된 PID 파일 기반 종료
if [ -f "$APP_DIR/logs/.backend.pid" ]; then
    BACKEND_PID=$(cat "$APP_DIR/logs/.backend.pid" 2>/dev/null || true)
    if [ -n "$BACKEND_PID" ]; then
        kill "$BACKEND_PID" >/dev/null 2>&1 || true
    fi
    rm -f "$APP_DIR/logs/.backend.pid"
fi

if [ -f "$APP_DIR/logs/.frontend.pid" ]; then
    FRONTEND_PID=$(cat "$APP_DIR/logs/.frontend.pid" 2>/dev/null || true)
    if [ -n "$FRONTEND_PID" ]; then
        kill "$FRONTEND_PID" >/dev/null 2>&1 || true
    fi
    rm -f "$APP_DIR/logs/.frontend.pid"
fi

# 2. 포트 점유 프로세스 강제 정리
kill_port() {
    local port=$1
    if command -v fuser >/dev/null 2>&1; then
        fuser -k "${port}/tcp" >/dev/null 2>&1 || true
    elif command -v lsof >/dev/null 2>&1; then
        local pids
        pids=$(lsof -t -i ":${port}" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            kill -9 $pids >/dev/null 2>&1 || true
        fi
    fi
}

kill_port 8001
kill_port 9000

echo ""
echo "=============================================================="
echo "[완료] AutoCoinTrade 백엔드 및 웹 UI 서비스가 안전하게 종료되었습니다."
echo "=============================================================="
echo ""
