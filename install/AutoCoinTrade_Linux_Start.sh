#!/usr/bin/env bash
# ============================================================================
# AutoCoinTrade - Docker 기반 원클릭 빌드 및 실행기 (Linux, DB 포함)
# ============================================================================
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INSTALL_DIR"

echo "=============================================================="
echo "[AutoCoinTrade] Docker 이미지 빌드 & DB 통합 실행기 (Linux)"
echo "=============================================================="
echo ""

# 1. Docker / Compose 런타임 점검
echo "[1/4] Docker 환경 점검 중..."
COMPOSE_CMD=()
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(podman compose)
else
    echo "--------------------------------------------------------------"
    echo "[오류] Docker Compose (docker compose / docker-compose)가 필요합니다."
    echo "Docker Engine & Compose 플러그인을 설치한 뒤 다시 실행해주세요:"
    echo "  https://docs.docker.com/engine/install/"
    echo "--------------------------------------------------------------"
    exit 1
fi
echo "  -> Compose 확인 완료: ${COMPOSE_CMD[*]}"

# 2. .env 및 영구 볼륨 디렉토리 준비
echo ""
echo "[2/4] 설정(.env) 및 데이터 디렉토리 준비 중..."
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/config" "$INSTALL_DIR/logs"

if [ ! -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/.env.example" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    echo "  -> .env.example 에서 .env 생성 완료"
fi

if [ ! -f "$INSTALL_DIR/config/upbit_config.json" ] && [ -f "$INSTALL_DIR/app/config/upbit_config.example.json" ]; then
    cp "$INSTALL_DIR/app/config/upbit_config.example.json" "$INSTALL_DIR/config/upbit_config.json"
fi

if [ -f "$INSTALL_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$INSTALL_DIR/.env"
    set +a
fi

FRONTEND_PORT="${FRONTEND_PORT:-9000}"
BACKEND_PORT="${BACKEND_PORT:-8001}"
PGPORT="${PGPORT:-5432}"

# 3. Docker 이미지 빌드 및 컨테이너 기동 (PostgreSQL 16 + Backend + Frontend)
echo ""
echo "[3/4] Docker 이미지 빌드 및 DB 포함 전체 서비스 기동 중..."
"${COMPOSE_CMD[@]}" up -d --build

# 4. 헬스체크 대기
echo ""
echo "[4/4] 서비스 정상 기동 확인 중..."
for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${BACKEND_PORT}/api/version" >/dev/null 2>&1; then
        echo "  [OK] 백엔드 API (http://localhost:${BACKEND_PORT}) 정상 응답"
        break
    fi
    sleep 1
done

for i in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${FRONTEND_PORT}/" >/dev/null 2>&1; then
        echo "  [OK] 웹 대시보드 (http://localhost:${FRONTEND_PORT}) 정상 응답"
        break
    fi
    sleep 1
done

xdg-open "http://localhost:${FRONTEND_PORT}" >/dev/null 2>&1 || sensible-browser "http://localhost:${FRONTEND_PORT}" >/dev/null 2>&1 || true

echo ""
echo "=============================================================="
echo "🚀 AutoCoinTrade (Docker + PostgreSQL 16 + SQLite WAL) 기동 완료!"
echo "=============================================================="
echo "- 웹 대시보드   : http://localhost:${FRONTEND_PORT}"
echo "- 백엔드 API    : http://localhost:${BACKEND_PORT}"
echo "- PostgreSQL 16 : localhost:${PGPORT} (DB: ${PGDATABASE:-coin_trader})"
echo "- 기본 입장 코드 : ${GATE_CODE:-stock}"
echo "- 상태 확인     : ${COMPOSE_CMD[*]} ps"
echo "- 로그 확인     : ${COMPOSE_CMD[*]} logs -f"
echo "- 서비스 종료   : ./AutoCoinTrade_Linux_Stop.sh"
echo "=============================================================="
echo ""
