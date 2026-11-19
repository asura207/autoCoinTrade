@echo off
chcp 65001 >nul
title Upbit Multi-Processing Auto Trading Orchestrator

cd /d "%~dp0"
if not exist "logs" mkdir "logs"
if not exist "data" mkdir "data"

if exist ".env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if not "%%~A"=="" set "%%~A=%%~B"
    )
)

set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"
if "%BACKEND_PORT%"=="" set "BACKEND_PORT=8001"
if "%DRY_RUN%"=="" set "DRY_RUN=True"
REM [5중 중복 주문 가드레일] 단일 실전 실행 주체(LIVE_EXECUTOR_OWNER) 기본값 보전 ('node' 고정)
REM Python 단독 실전 실행이 필요할 때만 stop_services.bat 종료 후 LIVE_EXECUTOR_OWNER=python 지정
if "%LIVE_EXECUTOR_OWNER%"=="" set "LIVE_EXECUTOR_OWNER=node"

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
echo   Upbit Multi-Processing Auto Trading ^& LLM Filter
echo ========================================================
echo [Runner] Python Executable   : %PYTHON_EXE%
echo [Runner] Backend Port        : %BACKEND_PORT% ^| DryRun: %DRY_RUN%
echo [Runner] LIVE_EXECUTOR_OWNER : %LIVE_EXECUTOR_OWNER%
if /I not "%LIVE_EXECUTOR_OWNER%"=="python" if /I not "%DRY_RUN%"=="True" (
    echo [Guardrail] LIVE_EXECUTOR_OWNER='%LIVE_EXECUTOR_OWNER%' 상태이므로 Python 실전 주문은 하드 차단됩니다.
    echo [Guardrail] Python 단독 실전 실행 시 먼저 stop_services.bat 종료 후 LIVE_EXECUTOR_OWNER=python 으로 설정하세요.
)
echo [Runner] Starting Supervisor Orchestrator...
echo.

"%PYTHON_EXE%" main_orchestrator.py
if /I not "%~1"=="--nopause" pause
