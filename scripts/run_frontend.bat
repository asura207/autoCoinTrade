@echo off
setlocal
cd /d "%~dp0..\frontend"
if not exist "..\logs" mkdir "..\logs"

set "FRONTEND_PORT=9000"
set "FRONTEND_HOST=127.0.0.1"
set "BACKEND_PORT=8001"
set "BACKEND_URL="
if exist "..\.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("..\.env") do (
        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"
        if /I "%%~A"=="FRONTEND_HOST" set "FRONTEND_HOST=%%~B"
        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"
        if /I "%%~A"=="BACKEND_URL" set "BACKEND_URL=%%~B"
    )
)
if "%BACKEND_URL%"=="" set "BACKEND_URL=http://127.0.0.1:%BACKEND_PORT%"

set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 set "NODE_EXE=node"
if "%NODE_EXE%"=="" if exist "D:\dev\tools\nodejs\node.exe" set "NODE_EXE=D:\dev\tools\nodejs\node.exe"
if "%NODE_EXE%"=="" set "NODE_EXE=node"

if not exist "dist\index.html" (
  if not exist "node_modules\vite" (
    echo [Frontend] Installing dependencies...
    call npm install
  )
  echo [Frontend] Building static production bundle...
  call npm run build
)
"%NODE_EXE%" ..\backend\common\log_rotator.mjs --startup >nul 2>&1
"%NODE_EXE%" server.mjs >> ..\logs\frontend.log 2>&1
