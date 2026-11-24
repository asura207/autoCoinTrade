#!/usr/bin/env bash
# ============================================================================
# AutoCoinTrade - Docker 이미지 빌드 및 오프라인(.tar) 내보내기 도구 (Linux)
# 사용법:
#   ./AutoCoinTrade_Linux_Build_Image.sh          # autocoin-trade:latest 빌드
#   ./AutoCoinTrade_Linux_Build_Image.sh --save   # App + PostgreSQL 16 이미지 .tar 저장
# ============================================================================
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INSTALL_DIR"

IMAGE_NAME="${IMAGE_NAME:-autocoin-trade:latest}"
PG_IMAGE="postgres:16-alpine"
SAVE_TAR=0

if [ "${1:-}" = "--save" ]; then
    SAVE_TAR=1
fi

CONTAINER_CLI=""
if command -v docker >/dev/null 2>&1; then
    CONTAINER_CLI="docker"
elif command -v podman >/dev/null 2>&1; then
    CONTAINER_CLI="podman"
else
    echo "[오류] docker 또는 podman 이 설치되어 있지 않습니다." >&2
    exit 1
fi

echo "=============================================================="
echo "[AutoCoinTrade] Docker 이미지 빌드 시작 (${CONTAINER_CLI})"
echo "  - 대상 이미지 : ${IMAGE_NAME}"
echo "  - 포함 DB     : ${PG_IMAGE} (PostgreSQL 16) + SQLite WAL"
echo "=============================================================="

"$CONTAINER_CLI" build -t "$IMAGE_NAME" -f "$INSTALL_DIR/Dockerfile" "$INSTALL_DIR"

echo ""
echo "[OK] 앱 이미지 빌드 완료: ${IMAGE_NAME}"

if [ "$SAVE_TAR" -eq 1 ]; then
    echo ""
    echo "[오프라인 패키지] PostgreSQL 16 이미지 풀 및 통합 .tar 아카이브 생성 중..."
    "$CONTAINER_CLI" pull "$PG_IMAGE"
    OUT_TAR="$INSTALL_DIR/autocoin-docker-images.tar"
    "$CONTAINER_CLI" save -o "$OUT_TAR" "$IMAGE_NAME" "$PG_IMAGE"
    echo "[OK] 저장 완료: ${OUT_TAR}"
    echo "     대상 서버에서 로드: ${CONTAINER_CLI} load -i autocoin-docker-images.tar"
fi
