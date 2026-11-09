@echo off
cd /d "%~dp0..\frontend"
if not exist "..\logs" mkdir "..\logs"
set "NODE_EXE=D:\dev\tools\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
if not exist "node_modules\vite" (
  echo [Frontend] Installing dependencies...
  call npm install
)
"%NODE_EXE%" node_modules\vite\bin\vite.js --host >> ..\logs\frontend.log 2>&1
