#!/usr/bin/env bash
# ============================================================================
# build_install_package.sh
# autoCoinTrade 프로젝트의 /install Docker 독립 배포 패키지 소스 동기화 스크립트
# ============================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$PROJECT_ROOT/install"
APP_DIR="$INSTALL_DIR/app"

echo "======================================================================"
echo "[AutoCoinTrade] /install Docker 배포 패키지 소스 동기화 시작..."
echo "======================================================================"

# 1. 기존 app 디렉토리 정리 후 깨끗하게 재생성 (node_modules/.venv/비밀파일 완전 배제)
echo "[1/5] /install/app 디렉토리 초기화 중..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/backend/common"
mkdir -p "$APP_DIR/frontend/src"
mkdir -p "$APP_DIR/frontend/public"
mkdir -p "$APP_DIR/config"
mkdir -p "$APP_DIR/agentBot"

# 2. 백엔드 파일 복사
echo "[2/5] 백엔드 모듈 복사 중..."
cp "$PROJECT_ROOT/backend/node_server.mjs" "$APP_DIR/backend/"
cp "$PROJECT_ROOT/backend/common/"*.mjs "$APP_DIR/backend/common/"

# 3. 프론트엔드 소스 복사 (Docker 빌드 시 Stage 1에서 dist 자동 컴파일)
echo "[3/5] 프론트엔드 소스 및 설정 복사 중..."
cp "$PROJECT_ROOT/frontend/package.json" "$APP_DIR/frontend/"
if [ -f "$PROJECT_ROOT/frontend/package-lock.json" ]; then
    cp "$PROJECT_ROOT/frontend/package-lock.json" "$APP_DIR/frontend/"
fi
cp "$PROJECT_ROOT/frontend/vite.config.js" "$APP_DIR/frontend/"
cp "$PROJECT_ROOT/frontend/server.mjs" "$APP_DIR/frontend/"
cp "$PROJECT_ROOT/frontend/index.html" "$APP_DIR/frontend/"
cp -r "$PROJECT_ROOT/frontend/src/"* "$APP_DIR/frontend/src/"
if [ -d "$PROJECT_ROOT/frontend/public" ]; then
    cp -r "$PROJECT_ROOT/frontend/public/"* "$APP_DIR/frontend/public/" 2>/dev/null || true
fi

# 4. 파이썬 봇/워커 모듈, 의존성 명세 및 설정 템플릿 복사 (민감 파일 제외)
echo "[4/5] 봇/워커 모듈 및 템플릿 복사 중..."
cp "$PROJECT_ROOT/config/upbit_config.example.json" "$APP_DIR/config/"
cp "$PROJECT_ROOT/.env.example" "$APP_DIR/.env.example"
cp "$PROJECT_ROOT/init_db.py" "$APP_DIR/"
cp "$PROJECT_ROOT/bots.py" "$APP_DIR/"
cp "$PROJECT_ROOT/market_hub.py" "$APP_DIR/"
cp "$PROJECT_ROOT/llm_filter_worker.py" "$APP_DIR/"
cp "$PROJECT_ROOT/main_orchestrator.py" "$APP_DIR/"
if [ -d "$PROJECT_ROOT/agentBot" ]; then
    cp "$PROJECT_ROOT/agentBot/"*.py "$APP_DIR/agentBot/"
fi
cp "$PROJECT_ROOT/package.json" "$APP_DIR/"
if [ -f "$PROJECT_ROOT/package-lock.json" ]; then
    cp "$PROJECT_ROOT/package-lock.json" "$APP_DIR/"
fi
cp "$PROJECT_ROOT/requirements.txt" "$APP_DIR/"
if [ -f "$PROJECT_ROOT/history.md" ]; then
    cp "$PROJECT_ROOT/history.md" "$APP_DIR/"
    cp "$PROJECT_ROOT/history.md" "$INSTALL_DIR/"
fi

# 5. 실행 권한 설정
echo "[5/5] 스크립트 실행 권한 설정 중..."
chmod +x "$INSTALL_DIR/"*.sh 2>/dev/null || true

echo "======================================================================"
echo "[완료] /install Docker 배포 패키지 동기화가 완료되었습니다."
echo "  - 이미지 빌드 : cd install && ./AutoCoinTrade_Linux_Build_Image.sh"
echo "  - DB포함 실행 : cd install && ./AutoCoinTrade_Linux_Start.sh"
echo "======================================================================"
