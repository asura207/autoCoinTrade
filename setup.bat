@echo off
chcp 65001 >nul
title Upbit AutoCoinTrade - Initial Setup

echo ===================================================
echo [Upbit AutoCoinTrade] Initial Environment Setup
echo ===================================================
echo.

cd /d "%~dp0"

REM 1. Node.js check (>= 22.5.0)
echo [1/5] Checking Node.js installation and version...
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
echo [2/5] Creating logs and data directories...
if not exist "logs" mkdir "logs"
if not exist "data" mkdir "data"
echo [OK] Directories ready.

REM 3. Config files
echo.
echo [3/5] Checking configuration files...
if not exist "config\upbit_config.json" (
    if exist "config\upbit_config.example.json" (
        copy "config\upbit_config.example.json" "config\upbit_config.json" >nul
        echo [OK] Created config/upbit_config.json from template.
    )
) else (
    echo [OK] config/upbit_config.json already exists.
)

if not exist ".env" if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo [OK] Created .env from template.
)

REM 4. Node.js backend & frontend dependencies
echo.
echo [4/5] Installing Node.js backend and frontend dependencies...
if exist "package.json" (
    call npm install
    echo [OK] Root backend dependencies installed successfully.
)
cd frontend
call npm install
cd ..
echo [OK] Frontend dependencies installed successfully.

REM 5. Python virtual environment & dependencies (Optional / Quant Bot modules)
echo.
echo [5/5] Setting up Python virtual environment...
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    if not exist ".venv" (
        python -m venv .venv
        echo [OK] Created Python virtual environment in .venv.
    )
    if exist ".venv\Scripts\pip.exe" (
        call ".venv\Scripts\pip.exe" install --upgrade pip --quiet
        if exist "requirements.txt" call ".venv\Scripts\pip.exe" install -r requirements.txt --quiet
        if exist "backend\requirements.txt" call ".venv\Scripts\pip.exe" install -r backend\requirements.txt --quiet
        echo [OK] Python dependencies installed successfully.
    )
) else (
    echo [NOTE] Python not found. Skipping Python modules ^(Node.js backend runs independently^).
)

set "BACKEND_PORT=8001"
set "FRONTEND_PORT=9000"
if exist ".env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"
        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"
    )
)

echo.
echo ===================================================
echo [SUCCESS] Environment setup completed successfully!
echo ===================================================
echo - Start services : start_services.bat ^(or start.bat^)
echo - Stop services  : stop_services.bat ^(or stop.bat^)
echo - Orchestrator   : run_orchestrator.bat ^(standalone Python mode^)
echo - Web Dashboard  : http://localhost:%FRONTEND_PORT%
echo - Entry Code     : stock
echo - Backend API    : http://localhost:%BACKEND_PORT%
echo ===================================================
echo.
