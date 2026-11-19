#!/usr/bin/env bash
# ========================================================
# Upbit Multi-Processing Auto Trading & LLM Filter (Linux)
# ========================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

mkdir -p logs data
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
export PYTHONUTF8=1
export PYTHONUNBUFFERED=1

if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

# [5중 중복 주문 가드레일] 단일 실전 실행 주체(LIVE_EXECUTOR_OWNER) 기본값 보전
# - 기본값 'node': Node.js 백엔드(backend/node_server.mjs)만 업비트 실전 주문 실행
# - Python 단독 실전 실행이 필요할 때만 Node 백엔드 중지 후 LIVE_EXECUTOR_OWNER=python 지정
export LIVE_EXECUTOR_OWNER="${LIVE_EXECUTOR_OWNER:-node}"
export DRY_RUN="${DRY_RUN:-True}"

if [ -f ".venv/bin/python" ]; then
    PYTHON_EXE=".venv/bin/python"
elif [ -f "venv/bin/python" ]; then
    PYTHON_EXE="venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON_EXE="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_EXE="python"
else
    echo "[ERROR] Python 3 executable not found." >&2
    exit 1
fi

echo "========================================================"
echo "  Upbit Multi-Processing Auto Trading & LLM Filter"
echo "========================================================"
echo "[Runner] Python Executable   : $PYTHON_EXE"
echo "[Runner] Backend Port        : ${BACKEND_PORT:-8001} | DryRun: ${DRY_RUN}"
echo "[Runner] LIVE_EXECUTOR_OWNER : ${LIVE_EXECUTOR_OWNER}"
if [ "${LIVE_EXECUTOR_OWNER}" != "python" ] && [ "${DRY_RUN}" != "True" ] && [ "${DRY_RUN}" != "true" ]; then
    echo "[Guardrail] LIVE_EXECUTOR_OWNER='${LIVE_EXECUTOR_OWNER}' (!= python) 상태이므로 Python 실전 주문은 하드 차단됩니다."
    echo "[Guardrail] Python 단독 실전 실행 시 먼저 ./stop_services.sh 실행 후 LIVE_EXECUTOR_OWNER=python 으로 설정하세요."
fi
echo "[Runner] Starting Supervisor Orchestrator..."
echo ""

exec "$PYTHON_EXE" main_orchestrator.py "$@"
