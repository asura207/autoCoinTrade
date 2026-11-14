@echo off
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
if not exist "data" mkdir "data"

if exist ".env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if not "%%~A"=="" set "%%~A=%%~B"
    )
)

set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 set "NODE_EXE=node"
if "%NODE_EXE%"=="" if exist "D:\dev\tools\nodejs\node.exe" set "NODE_EXE=D:\dev\tools\nodejs\node.exe"
if "%NODE_EXE%"=="" set "NODE_EXE=node"

if not exist "node_modules" if exist "package.json" (
    echo [Backend] Installing root dependencies...
    call npm install --silent
)

"%NODE_EXE%" backend/node_server.mjs >> logs\backend.log 2>&1
