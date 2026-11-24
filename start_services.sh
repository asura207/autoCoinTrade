#!/usr/bin/env bash
# ===================================================
# Upbit AutoCoinTrade - Services Launcher (Linux)
# ===================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

# 0. Node.js 런타임 버전 확인 (>= 22.5.0)
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js가 설치되어 있지 않습니다. Node.js 22.5.0 이상을 설치해주세요." >&2
    exit 1
fi
node -e "
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
    console.error('[ERROR] Node.js >= 22.5.0 required. Current: ' + process.version);
    process.exit(1);
}
"

# .env 환경 설정 로드
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8001}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-9000}"
export LIVE_EXECUTOR_OWNER="${LIVE_EXECUTOR_OWNER:-node}"
USE_LOCAL_OLLAMA_NEWS="${USE_LOCAL_OLLAMA_NEWS:-true}"
OLLAMA_NEWS_MODEL="${OLLAMA_NEWS_MODEL:-qwen3-news}"

echo "==================================================="
echo "[Upbit AutoCoinTrade] 서비스 시작 중..."
echo "==================================================="
echo "  - LIVE_EXECUTOR_OWNER : ${LIVE_EXECUTOR_OWNER}"
echo "  - Local Ollama News   : ${USE_LOCAL_OLLAMA_NEWS} (${OLLAMA_NEWS_MODEL})"

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

# 2. 프론트엔드 프로덕션 정적 번들 확인 및 자동 빌드 (Vite Dev Server 외부 노출 방지)
if [ ! -f "$PROJECT_ROOT/frontend/dist/index.html" ] || [ "$PROJECT_ROOT/frontend/src/App.jsx" -nt "$PROJECT_ROOT/frontend/dist/index.html" ] || [ "$PROJECT_ROOT/frontend/src/styles.css" -nt "$PROJECT_ROOT/frontend/dist/index.html" ] || [ "$PROJECT_ROOT/frontend/index.html" -nt "$PROJECT_ROOT/frontend/dist/index.html" ]; then
    echo "[0/2] 프론트엔드 정적 프로덕션 번들 빌드 중..."
    (cd "$PROJECT_ROOT/frontend" && npm run build >/dev/null 2>&1 || npm run build)
fi

# 3. 이전 일자 로그 분할 및 7일 경과 로그 정리
if command -v node >/dev/null 2>&1; then
    node "$PROJECT_ROOT/backend/common/log_rotator.mjs" --startup >/dev/null 2>&1 || true
fi

# 4. 백엔드 실행 (Node.js Server - 타 프로젝트의 전역 pkill -f "backend/node_server.mjs" 오폭 방지를 위해 ./ 분리 경로 사용)
echo "[1/2] 백엔드 서비스 시작 중 (Port ${BACKEND_PORT})..."
setsid node "$PROJECT_ROOT/backend/./node_server.mjs" </dev/null >> logs/backend.log 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > logs/.backend.pid
echo "  -> 백엔드 PID: $BACKEND_PID (로그: logs/backend.log)"

# 4. 프론트엔드 실행 (보안 정적 파일 + API 프록시 서버)
echo "[2/2] 프론트엔드 서비스 시작 중 (${FRONTEND_HOST}:${FRONTEND_PORT})..."
setsid env FRONTEND_HOST="${FRONTEND_HOST}" FRONTEND_PORT="${FRONTEND_PORT}" BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}" node "$PROJECT_ROOT/frontend/./server.mjs" </dev/null >> logs/frontend.log 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > logs/.frontend.pid
echo "  -> 프론트엔드 PID: $FRONTEND_PID (로그: logs/frontend.log)"

# 4. 서비스 기동 대기 및 헬스체크
echo ""
echo "서비스 기동 상태 확인 중..."
BACKEND_OK=0
for i in {1..15}; do
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${BACKEND_PORT}/api/version" 2>/dev/null | grep -q "200"; then
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
echo "- 실전 실행 주체 : ${LIVE_EXECUTOR_OWNER}"
echo "- 서비스 중지  : ./stop_services.sh"
echo "- 로그 확인    : tail -f logs/backend.log logs/frontend.log"
echo "==================================================="
echo ""
