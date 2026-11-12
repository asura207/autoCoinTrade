#!/usr/bin/env bash
# ============================================================================
# AutoCoinTrade - 원클릭 통합 설치 및 실행기 (Linux)
# ============================================================================
set -e

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$INSTALL_DIR/app"

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

echo "=============================================================="
echo "[AutoCoinTrade] 비개발자용 원클릭 자동 설치 및 실행기 (Linux)"
echo "=============================================================="
echo ""

# 1. Node.js 런타임 확인
echo "[1/5] Node.js 런타임 환경 점검 중..."
if ! command -v node >/dev/null 2>&1; then
    echo "--------------------------------------------------------------"
    echo "[오류] 시스템에 Node.js 가 설치되어 있지 않습니다."
    echo "autoCoinTrade 구동을 위해 Node.js (v20 이상) 설치가 필요합니다."
    echo "Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
    echo "RHEL/Fedora  : sudo dnf install -y nodejs"
    echo "--------------------------------------------------------------"
    exit 1
fi

NODE_VERSION=$(node -v)
echo "  -> Node.js 확인 완료: $NODE_VERSION"

# 2. Python 환경 점검 (선택)
echo ""
echo "[2/5] Python 보조 환경 점검 중..."
if command -v python3 >/dev/null 2>&1; then
    if [ ! -d "$APP_DIR/.venv" ]; then
        echo "  -> Python 가상환경(.venv) 생성 중..."
        python3 -m venv "$APP_DIR/.venv" >/dev/null 2>&1 || true
    fi
    if [ -f "$APP_DIR/.venv/bin/pip" ] && [ -f "$APP_DIR/requirements.txt" ]; then
        "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" --quiet >/dev/null 2>&1 || true
    fi
    echo "  -> Python 환경 준비 완료"
else
    echo "  -> Python3 미설치 (Node.js 독립 엔진으로 모든 기능이 완벽 동작합니다)"
fi

# 3. 디렉토리 및 설정 템플릿 준비
echo ""
echo "[3/5] 데이터 및 설정 디렉토리 준비 중..."
mkdir -p "$APP_DIR/logs" "$APP_DIR/data"

if [ ! -f "$APP_DIR/config/upbit_config.json" ] && [ -f "$APP_DIR/config/upbit_config.example.json" ]; then
    cp "$APP_DIR/config/upbit_config.example.json" "$APP_DIR/config/upbit_config.json"
fi

if [ ! -f "$APP_DIR/.env" ] && [ -f "$APP_DIR/.env.example" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi

# 4. 필수 패키지 점검 및 프론트엔드 번들 확인
echo ""
echo "[4/5] 필수 모듈 및 웹 UI 번들 점검 중..."
if [ ! -d "$APP_DIR/node_modules" ]; then
    echo "  -> 백엔드 패키지 자동 설치 중 (최초 1회 약 15초 소요)..."
    (cd "$APP_DIR" && npm install --silent >/dev/null 2>&1)
fi

if [ ! -d "$APP_DIR/frontend/node_modules" ]; then
    echo "  -> 프론트엔드 패키지 자동 설치 중 (최초 1회 약 20초 소요)..."
    (cd "$APP_DIR/frontend" && npm install --silent >/dev/null 2>&1)
fi

if [ ! -d "$APP_DIR/frontend/dist" ]; then
    echo "  -> 프론트엔드 프로덕션 번들 빌드 중..."
    (cd "$APP_DIR/frontend" && npm run build >/dev/null 2>&1)
fi

# 기존 포트 충돌 방지 및 안전 종료
"$INSTALL_DIR/AutoCoinTrade_Linux_Stop.sh" >/dev/null 2>&1 || true
sleep 1

# 5. 백그라운드 서비스 기동
echo ""
echo "[5/5] 백엔드 및 웹 UI 서비스 기동 중..."
cd "$APP_DIR"

setsid node backend/node_server.mjs </dev/null >> logs/backend.log 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > logs/.backend.pid

setsid bash -c "cd frontend && npx vite --port 9000 --host 0.0.0.0" </dev/null >> logs/frontend.log 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > logs/.frontend.pid

# 서비스 기동 대기 및 헬스체크
echo "  -> 서버 기동 대기 및 연결 확인 중..."
for i in {1..15}; do
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8001/api/setup/status" 2>/dev/null | grep -q "200"; then
        echo "  [OK] 백엔드 API (Port 8001) 정상 응답"
        break
    fi
    sleep 0.5
done

for i in {1..15}; do
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:9000" 2>/dev/null | grep -q "200"; then
        echo "  [OK] 웹 UI 대시보드 (Port 9000) 정상 응답"
        break
    fi
    sleep 0.5
done

# 브라우저 자동 실행 시도
xdg-open "http://localhost:9000" >/dev/null 2>&1 || sensible-browser "http://localhost:9000" >/dev/null 2>&1 || true

echo ""
echo "=============================================================="
echo "🚀 AutoCoinTrade 시스템이 백그라운드에서 성공적으로 구동되었습니다!"
echo "=============================================================="
echo "- 웹 대시보드 URL : http://localhost:9000 (대체 주소: http://localhost:8001)"
echo "- 기본 입장 코드   : stock (설정 화면에서 원하는 코드로 변경 가능)"
echo "- 최초 실행 안내   : 브라우저에 표시된 [Step-by-Step 설정 마법사]를 따라"
echo "                    DB 선택(SQLite 권장) 및 설정을 완료해주세요."
echo "- 서비스 종료     : ./AutoCoinTrade_Linux_Stop.sh 실행"
echo "- 실행 로그 확인   : tail -f app/logs/backend.log app/logs/frontend.log"
echo "=============================================================="
echo ""
