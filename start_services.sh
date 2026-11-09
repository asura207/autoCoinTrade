#!/usr/bin/env bash
# ===================================================
# Upbit AutoCoinTrade - Services Launcher (Linux)
# ===================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

# .env 환경 설정 로드
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8001}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-9000}"

echo "==================================================="
echo "[Upbit AutoCoinTrade] 서비스 시작 중..."
echo "==================================================="

mkdir -p logs data

# 1. 포트 점유 여부 확인 및 기존 프로세스 정리
check_port() {
    local port=$1
    if command -v ss >/dev/null 2>&1; then
        ss -tuln | grep -q ":${port} "
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tuln | grep -q ":${port} "
    elif command -v lsof >/dev/null 2>&1; then
        lsof -i ":${port}" >/dev/null 2>&1
    else
        return 1
    fi
}

if check_port "$BACKEND_PORT" || check_port "$FRONTEND_PORT"; then
    echo "[안내] 기존에 실행 중인 프로세스를 정리합니다..."
    "$PROJECT_ROOT/stop_services.sh" >/dev/null 2>&1 || true
    sleep 1
fi

# 2. 백엔드 실행 (Node.js Server)
echo "[1/2] 백엔드 서비스 시작 중 (Port ${BACKEND_PORT})..."
setsid node backend/node_server.mjs </dev/null >> logs/backend.log 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > logs/.backend.pid
echo "  -> 백엔드 PID: $BACKEND_PID (로그: logs/backend.log)"

# 3. 프론트엔드 실행 (Vite Dev Server)
echo "[2/2] 프론트엔드 서비스 시작 중 (Port ${FRONTEND_PORT})..."
setsid bash -c "cd frontend && npx vite --port ${FRONTEND_PORT} --host ${FRONTEND_HOST}" </dev/null >> logs/frontend.log 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > logs/.frontend.pid
echo "  -> 프론트엔드 PID: $FRONTEND_PID (로그: logs/frontend.log)"

# 4. 서비스 기동 대기 및 헬스체크
echo ""
echo "서비스 기동 상태 확인 중..."
BACKEND_OK=0
for i in {1..15}; do
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${BACKEND_PORT}/api/bots" 2>/dev/null | grep -q "200"; then
        echo "  [OK] 백엔드 API (http://localhost:${BACKEND_PORT}) 정상 응답"
        BACKEND_OK=1
        break
    fi
    sleep 0.5
done

if [ "$BACKEND_OK" -eq 0 ]; then
    echo "  [WARN] 백엔드 응답 대기 중입니다. logs/backend.log 를 확인하세요."
fi

FRONTEND_OK=0
for i in {1..15}; do
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${FRONTEND_PORT}" 2>/dev/null | grep -q "200"; then
        echo "  [OK] 웹 프론트엔드 (http://localhost:${FRONTEND_PORT}) 정상 응답"
        FRONTEND_OK=1
        break
    fi
    sleep 0.5
done

if [ "$FRONTEND_OK" -eq 0 ]; then
    echo "  [WARN] 프론트엔드 응답 대기 중입니다. logs/frontend.log 를 확인하세요."
fi

echo ""
echo "==================================================="
echo "[완료] 백엔드 및 웹 UI 서비스가 백그라운드에서 실행되었습니다."
echo "==================================================="
echo "- 웹 대시보드 : http://localhost:${FRONTEND_PORT}"
echo "- 기본 입장 코드 : stock"
echo "- 백엔드 API   : http://localhost:${BACKEND_PORT}"
echo "- 서비스 중지  : ./stop_services.sh (또는 ./stop.sh)"
echo "- 로그 확인    : tail -f logs/backend.log logs/frontend.log"
echo "==================================================="
echo ""
