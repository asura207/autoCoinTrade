#!/usr/bin/env bash
# ===================================================
# Upbit AutoCoinTrade - Initial Setup Script (Linux)
# ===================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

echo "==================================================="
echo "[Upbit AutoCoinTrade] Initial Environment Setup (Linux)"
echo "==================================================="
echo ""

# 1. Node.js check (>= 22.5.0)
echo "[1/5] Checking Node.js installation and version..."
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not found in PATH." >&2
    echo "Please install Node.js 22 LTS or higher: https://nodejs.org/" >&2
    exit 1
fi

node -e "
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
    console.error('[ERROR] Node.js >= 22.5.0 required. Current: ' + process.version);
    process.exit(1);
} else {
    console.log('[OK] Node.js version verified: ' + process.version);
}
"

# 2. Create directories
echo ""
echo "[2/5] Creating logs and data directories..."
mkdir -p logs data
echo "[OK] Directories ready."

# 3. Config files setup
echo ""
echo "[3/5] Checking configuration files..."
if [ ! -f "config/upbit_config.json" ]; then
    cp "config/upbit_config.example.json" "config/upbit_config.json"
    echo "[OK] Created config/upbit_config.json from template."
else
    echo "[OK] config/upbit_config.json already exists."
fi

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp ".env.example" ".env"
    echo "[OK] Created .env from template."
fi

# 4. Frontend dependencies
echo ""
echo "[4/5] Installing frontend dependencies..."
cd frontend
npm install
cd "$PROJECT_ROOT"
echo "[OK] Frontend dependencies installed successfully."

# 5. Python virtual environment & dependencies (Optional / Quant Bot modules)
echo ""
echo "[5/5] Setting up Python virtual environment..."
if command -v python3 >/dev/null 2>&1; then
    if [ ! -d ".venv" ]; then
        python3 -m venv .venv
        echo "[OK] Created Python virtual environment in .venv."
    fi
    source .venv/bin/activate
    pip install --upgrade pip --quiet
    if [ -f "requirements.txt" ]; then
        pip install -r requirements.txt --quiet
    fi
    if [ -f "backend/requirements.txt" ]; then
        pip install -r backend/requirements.txt --quiet
    fi
    echo "[OK] Python dependencies installed successfully."
else
    echo "[NOTE] Python3 not found. Skipping Python modules (Node.js backend runs independently)."
fi

# Make scripts executable
chmod +x scripts/*.sh *.sh 2>/dev/null || true

echo ""
echo "==================================================="
echo "[SUCCESS] Environment setup completed successfully!"
echo "==================================================="
echo "- Start services : ./start_services.sh (or ./start.sh)"
echo "- Stop services  : ./stop_services.sh (or ./stop.sh)"
FRONTEND_PORT="${FRONTEND_PORT:-9000}"
BACKEND_PORT="${BACKEND_PORT:-8001}"
echo "- Web Dashboard  : http://localhost:${FRONTEND_PORT}"
echo "- Entry Code     : stock"
echo "- Backend API    : http://localhost:${BACKEND_PORT}"
echo "==================================================="
echo ""
