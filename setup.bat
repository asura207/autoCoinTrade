@echo off
chcp 65001 >nul
title Upbit AutoCoinTrade - Initial Setup

echo ===================================================
echo [Upbit AutoCoinTrade] Initial Environment Setup
echo ===================================================
echo.

cd /d "%~dp0"

REM 1. Node.js check (>= 22.5.0)
echo [1/4] Checking Node.js installation and version...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not found in PATH.
    echo Please install Node.js 22 LTS or higher: https://nodejs.org/
    pause
    exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 5)) { console.error('[ERROR] Node.js >= 22.5.0 required. Current: ' + process.version); process.exit(1); } else { console.log('[OK] Node.js version verified: ' + process.version); }"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js version requirement not met.
    pause
    exit /b 1
)

REM 2. Create directories
echo.
echo [2/4] Creating logs and data directories...
if not exist "logs" mkdir "logs"
if not exist "data" mkdir "data"
echo [OK] Directories ready.

REM 3. Config file
echo.
echo [3/4] Checking config/upbit_config.json...
if not exist "config\upbit_config.json" (
    copy "config\upbit_config.example.json" "config\upbit_config.json" >nul
    echo [OK] Created config/upbit_config.json from template.
) else (
    echo [OK] config/upbit_config.json already exists.
)

REM 4. Frontend npm install
echo.
echo [4/4] Installing frontend dependencies...
cd frontend
call npm install
cd ..
echo [OK] Frontend dependencies installed successfully.

echo.
echo ===================================================
echo [SUCCESS] Environment setup completed successfully!
echo ===================================================
echo - Start services : start_services.bat (or start.bat)
echo - Stop services  : stop_services.bat
echo - Web Dashboard  : http://localhost:9000
echo - Entry Code     : stock
echo ===================================================
echo.
