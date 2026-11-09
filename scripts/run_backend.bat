@echo off
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
set "NODE_EXE=D:\dev\tools\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" backend/node_server.mjs >> logs\backend.log 2>&1
