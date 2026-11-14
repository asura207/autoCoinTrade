@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Upbit AutoCoinTrade Services Stopper

cd /d "%~dp0"
set "BACKEND_PORT=8001"
set "FRONTEND_PORT=9000"
if exist ".env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"
        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"
    )
)

echo ===================================================
echo [Upbit AutoTrade] 서비스 안전 중지 중... (Port %BACKEND_PORT%, %FRONTEND_PORT%)
echo ===================================================

for %%F in ("logs\.backend.pid" "logs\.frontend.pid" "logs\.orchestrator.pid") do (
    if exist %%~F (
        set /p TARGET_PID=<%%~F
        if defined TARGET_PID (
            echo PID 파일 기반 프로세스 종료 [PID: !TARGET_PID!]...
            taskkill /F /T /PID !TARGET_PID! >nul 2>&1
        )
        del /f /q %%~F >nul 2>&1
    )
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%BACKEND_PORT% " ^| findstr "LISTENING"') do (
    echo Port %BACKEND_PORT% 백엔드 프로세스 종료 [PID: %%a]...
    taskkill /F /T /PID %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%FRONTEND_PORT% " ^| findstr "LISTENING"') do (
    echo Port %FRONTEND_PORT% 웹 UI 프로세스 종료 [PID: %%a]...
    taskkill /F /T /PID %%a >nul 2>&1
)

powershell -NoProfile -Command "$root='%CD%'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*node_server.mjs*' -or $_.CommandLine -like '*main_orchestrator.py*' -or $_.CommandLine -like '*llm_filter_worker.py*') -and $_.CommandLine -like ('*' + $root + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo ===================================================
echo [완료] 백엔드, 웹 UI 및 워커 서비스가 안전하게 중지되었습니다.
echo ===================================================
ping 127.0.0.1 -n 3 >nul
