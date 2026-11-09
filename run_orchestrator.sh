#!/usr/bin/env bash
# ========================================================
# Upbit Multi-Processing Auto Trading & LLM Filter (Linux)
# ========================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

if [ -f ".venv/bin/python" ]; then
    PYTHON_EXE=".venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON_EXE="python3"
else
    echo "[ERROR] Python 3 executable not found." >&2
    exit 1
fi

echo "========================================================"
echo "  Upbit Multi-Processing Auto Trading & LLM Filter"
echo "========================================================"
echo "[Runner] Python Executable: $PYTHON_EXE"
echo "[Runner] Starting Supervisor Orchestrator..."
echo ""

exec "$PYTHON_EXE" main_orchestrator.py
