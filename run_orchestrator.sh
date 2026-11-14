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
echo "[Runner] Python Executable: $PYTHON_EXE"
echo "[Runner] Backend Port: ${BACKEND_PORT:-8001} | DryRun: ${DRY_RUN:-True}"
echo "[Runner] Starting Supervisor Orchestrator..."
echo ""

exec "$PYTHON_EXE" main_orchestrator.py "$@"
