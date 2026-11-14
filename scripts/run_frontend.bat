@echo off
setlocal
cd /d "%~dp0..\frontend"
if not exist "..\logs" mkdir "..\logs"

set "FRONTEND_PORT=9000"
set "FRONTEND_HOST=0.0.0.0"
if exist "..\.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("..\.env") do (
        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"
        if /I "%%~A"=="FRONTEND_HOST" set "FRONTEND_HOST=%%~B"
    )
)

set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 set "NODE_EXE=node"
if "%NODE_EXE%"=="" if exist "D:\dev\tools\nodejs\node.exe" set "NODE_EXE=D:\dev\tools\nodejs\node.exe"
if "%NODE_EXE%"=="" set "NODE_EXE=node"

if not exist "node_modules\vite" (
  echo [Frontend] Installing dependencies...
  call npm install
)
"%NODE_EXE%" node_modules\vite\bin\vite.js --port %FRONTEND_PORT% --host %FRONTEND_HOST% >> ..\logs\frontend.log 2>&1
