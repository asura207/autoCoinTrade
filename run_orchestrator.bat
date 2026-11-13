@echo off
chcp 65001 >nul
title Upbit Multi-Processing Auto Trading Orchestrator

cd /d "%~dp0"
set "PYTHON_EXE="
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
) else if exist "%~dp0venv\Scripts\python.exe" (
    set "PYTHON_EXE=%~dp0venv\Scripts\python.exe"
) else (
    where python >nul 2>&1
    if not errorlevel 1 set "PYTHON_EXE=python"
)
if "%PYTHON_EXE%"=="" if exist "C:\Program Files\LibreOffice\program\python.exe" (
    set "PYTHON_EXE=C:\Program Files\LibreOffice\program\python.exe"
)
if "%PYTHON_EXE%"=="" set "PYTHON_EXE=python"

echo ========================================================
echo   Upbit Multi-Processing Auto Trading & LLM Filter
echo ========================================================
echo [Runner] Python Executable: %PYTHON_EXE%
echo [Runner] Starting Supervisor Orchestrator...
echo.

"%PYTHON_EXE%" main_orchestrator.py
pause
