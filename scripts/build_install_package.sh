#!/usr/bin/env bash
# ============================================================================
# build_install_package.sh
# autoCoinTrade 프로젝트의 /install 독립 배포 패키지 빌드 및 번들링 스크립트
# ============================================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$PROJECT_ROOT/install"
APP_DIR="$INSTALL_DIR/app"

echo "======================================================================"
echo "[AutoCoinTrade] /install 배포 패키지 번들링 시작..."
echo "======================================================================"

# 1. 대상 디렉토리 생성
mkdir -p "$INSTALL_DIR"
mkdir -p "$APP_DIR/backend/common"
mkdir -p "$APP_DIR/frontend/src"
mkdir -p "$APP_DIR/frontend/public"
mkdir -p "$APP_DIR/config"
mkdir -p "$APP_DIR/data"
mkdir -p "$APP_DIR/logs"

# 2. 백엔드 파일 복사
echo "[1/6] 백엔드 모듈 복사 중..."
cp "$PROJECT_ROOT/backend/node_server.mjs" "$APP_DIR/backend/"
cp "$PROJECT_ROOT/backend/common/"*.mjs "$APP_DIR/backend/common/"

# 3. 프론트엔드 파일 복사
echo "[2/6] 프론트엔드 소스 및 설정 복사 중..."
cp "$PROJECT_ROOT/frontend/package.json" "$APP_DIR/frontend/"
cp "$PROJECT_ROOT/frontend/vite.config.js" "$APP_DIR/frontend/"
cp "$PROJECT_ROOT/frontend/index.html" "$APP_DIR/frontend/"
cp "$PROJECT_ROOT/frontend/src/"* "$APP_DIR/frontend/src/"
if [ -d "$PROJECT_ROOT/frontend/public" ]; then
    cp -r "$PROJECT_ROOT/frontend/public/"* "$APP_DIR/frontend/public/" 2>/dev/null || true
fi

# 프론트엔드 dist 빌드 및 복사 (즉시 실행 가능한 번들)
echo "[3/6] 프론트엔드 프로덕션 빌드 동기화 중..."
if [ -d "$PROJECT_ROOT/frontend/dist" ]; then
    rm -rf "$APP_DIR/frontend/dist"
    cp -r "$PROJECT_ROOT/frontend/dist" "$APP_DIR/frontend/dist"
fi

# 4. 설정 템플릿 복사 (실제 키가 포함된 파일은 절대 복사하지 않음)
echo "[4/6] 설정 템플릿 복사 중..."
cp "$PROJECT_ROOT/config/upbit_config.example.json" "$APP_DIR/config/"
if [ ! -f "$APP_DIR/config/upbit_config.json" ]; then
    cp "$PROJECT_ROOT/config/upbit_config.example.json" "$APP_DIR/config/upbit_config.json"
fi
cp "$PROJECT_ROOT/.env.example" "$APP_DIR/.env.example"
if [ ! -f "$APP_DIR/.env" ]; then
    cp "$PROJECT_ROOT/.env.example" "$APP_DIR/.env"
fi

# 5. 파이썬 봇 모듈 및 메인 오케스트레이터 복사
echo "[5/6] 봇 알고리즘 및 오케스트레이터 복사 중..."
cp "$PROJECT_ROOT/init_db.py" "$APP_DIR/"
cp "$PROJECT_ROOT/bots.py" "$APP_DIR/"
cp "$PROJECT_ROOT/market_hub.py" "$APP_DIR/"
cp "$PROJECT_ROOT/llm_filter_worker.py" "$APP_DIR/"
cp "$PROJECT_ROOT/main_orchestrator.py" "$APP_DIR/"
if [ -d "$PROJECT_ROOT/agentBot" ]; then
    rm -rf "$APP_DIR/agentBot"
    mkdir -p "$APP_DIR/agentBot"
    cp "$PROJECT_ROOT/agentBot/"*.py "$APP_DIR/agentBot/"
fi
cp "$PROJECT_ROOT/package.json" "$APP_DIR/"
cp "$PROJECT_ROOT/requirements.txt" "$APP_DIR/"
if [ -f "$PROJECT_ROOT/history.md" ]; then
    cp "$PROJECT_ROOT/history.md" "$APP_DIR/"
    cp "$PROJECT_ROOT/history.md" "$INSTALL_DIR/"
fi

# 6. 폴더 유지용 .gitkeep
touch "$APP_DIR/data/.gitkeep"
touch "$APP_DIR/logs/.gitkeep"

echo "[6/6] 패키징 파일 권한 설정 중..."
chmod +x "$INSTALL_DIR/"*.sh 2>/dev/null || true

echo "======================================================================"
echo "[완료] /install 배포 패키지 번들링이 성공적으로 완료되었습니다."
echo "======================================================================"
