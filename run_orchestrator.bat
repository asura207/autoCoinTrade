@echo off
chcp 65001 >nul
title Upbit Multi-Processing Auto Trading Orchestrator

cd /d "%~dp0"
set "PYTHON_EXE=C:\Program Files\LibreOffice\program\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

echo ========================================================
echo   Upbit Multi-Processing Auto Trading & LLM Filter
echo ========================================================
echo [Runner] Python Executable: %PYTHON_EXE%
echo [Runner] Starting Supervisor Orchestrator...
echo.

"%PYTHON_EXE%" main_orchestrator.py
pause
