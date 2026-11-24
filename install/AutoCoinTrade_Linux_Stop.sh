#!/usr/bin/env bash
# ============================================================================
# AutoCoinTrade - Docker 통합 종료기 (Linux)
# 사용법:
#   ./AutoCoinTrade_Linux_Stop.sh          # 컨테이너 중지 및 제거 (DB 볼륨 보존)
#   ./AutoCoinTrade_Linux_Stop.sh --clean  # 컨테이너 + PostgreSQL 볼륨까지 초기화
# ============================================================================
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INSTALL_DIR"

COMPOSE_CMD=()
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(podman compose)
else
    echo "[오류] docker compose / docker-compose 를 찾을 수 없습니다." >&2
    exit 1
fi

echo "=============================================================="
echo "[AutoCoinTrade] Docker 서비스 안전 종료 중..."
echo "=============================================================="

if [ "${1:-}" = "--clean" ]; then
    "${COMPOSE_CMD[@]}" --profile workers down -v
    echo "[완료] 컨테이너 및 PostgreSQL 볼륨이 모두 정리되었습니다."
else
    "${COMPOSE_CMD[@]}" --profile workers down
    echo "[완료] 모든 컨테이너가 종료되었습니다. (DB 및 ./data, ./config 데이터는 안전하게 보존됨)"
fi
