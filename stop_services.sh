#!/usr/bin/env bash
# ===================================================
# Upbit AutoCoinTrade - Services Stopper (Linux)
# ===================================================
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# .env 환경 설정 로드
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

BACKEND_PORT="${BACKEND_PORT:-8001}"
FRONTEND_PORT="${FRONTEND_PORT:-9000}"

echo "==================================================="
echo "[Upbit AutoCoinTrade] 서비스 중지 중... (Port ${BACKEND_PORT}, ${FRONTEND_PORT})"
echo "==================================================="

kill_pid_file() {
    local pid_file=$1
    local name=$2
    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$name 프로세스 종료 [PID: $pid]..."
            kill "$pid" 2>/dev/null || true
            sleep 0.5
            if kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null || true
            fi
        fi
        rm -f "$pid_file"
    fi
}

# 1. PID 파일 기반 종료
kill_pid_file "logs/.backend.pid" "백엔드 (PID 파일)"
kill_pid_file "logs/.frontend.pid" "프론트엔드 (PID 파일)"

# 2. 포트 기반 강제 정리
kill_port() {
    local port=$1
    local name=$2
    local pids=""

    if command -v fuser >/dev/null 2>&1; then
        pids=$(fuser "${port}/tcp" 2>/dev/null || true)
    elif command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -t -i ":${port}" 2>/dev/null || true)
    elif command -v ss >/dev/null 2>&1; then
        pids=$(ss -lptn "sport = :${port}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
    fi

    for p in $pids; do
        if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
            echo "Port ${port} 점유 프로세스 종료 ($name) [PID: $p]..."
            kill "$p" 2>/dev/null || true
            sleep 0.3
            kill -9 "$p" 2>/dev/null || true
        fi
    done
}

kill_port "$BACKEND_PORT" "백엔드"
kill_port "$FRONTEND_PORT" "프론트엔드"

echo "==================================================="
echo "[완료] 백엔드 및 웹 UI 서비스가 중지되었습니다."
echo "==================================================="
