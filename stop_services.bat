@echo off
REM ===================================================
REM Upbit AutoCoinTrade - Services Stopper (Windows)
REM - stop_services.sh (Linux) 100% 대칭 안전 종료기
REM - PID 파일 / 포트 / 저장소 경로(CommandLine) 기준 좀비 프로세스 완전 차단
REM ===================================================
chcp 65001 >nul
setlocal enabledelayedexpansion
title Upbit AutoCoinTrade - Services Stopper

set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"
set "BACKEND_PORT=8001"
set "FRONTEND_PORT=9000"
if exist ".env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"
        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"
    )
)

echo ===================================================
echo [Upbit AutoCoinTrade] 서비스 안전 중지 중... ^(Port !BACKEND_PORT!, !FRONTEND_PORT!^)
echo ===================================================

REM 1. PID 파일 기반 종료 (백엔드 / 프론트엔드 / 오케스트레이터)
for %%F in ("logs\.backend.pid" "logs\.frontend.pid" "logs\.orchestrator.pid") do (
    if exist %%~F (
        set "TARGET_PID="
        set /p TARGET_PID=<%%~F
        if defined TARGET_PID (
            echo PID 파일 기반 프로세스 종료 [PID: !TARGET_PID!]...
            taskkill /F /T /PID !TARGET_PID! >nul 2>&1
        )
        del /f /q %%~F >nul 2>&1
    )
)

REM 2. 포트 기반 안전 정리 (타 프로젝트 포트 보호)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":!BACKEND_PORT! " ^| findstr "LISTENING"') do (
    echo Port !BACKEND_PORT! 백엔드 프로세스 종료 [PID: %%a]...
    taskkill /F /T /PID %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":!FRONTEND_PORT! " ^| findstr "LISTENING"') do (
    echo Port !FRONTEND_PORT! 웹 UI 프로세스 종료 [PID: %%a]...
    taskkill /F /T /PID %%a >nul 2>&1
)

REM 3. 본 저장소 경로 기준 잔여 Node/Python 좀비 워커 안전 정리
powershell -NoProfile -Command "$root='%CD%'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*node_server.mjs*' -or $_.CommandLine -like '*server.mjs*' -or $_.CommandLine -like '*main_orchestrator.py*' -or $_.CommandLine -like '*llm_filter_worker.py*') -and $_.CommandLine -like ('*' + $root + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

REM 4. 옵션: --with-tunnel 전달 시 cloudflared 터널 프로세스도 함께 종료
if /I "%~1"=="--with-tunnel" (
    if exist "logs\.tunnel.pid" (
        set "TUNNEL_PID="
        set /p TUNNEL_PID=<logs\.tunnel.pid
        if defined TUNNEL_PID taskkill /F /T /PID !TUNNEL_PID! >nul 2>&1
        del /f /q logs\.tunnel.pid >nul 2>&1
    )
    powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'cloudflared*' -and $_.CommandLine -like '*:!FRONTEND_PORT!*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
)

echo ===================================================
echo [완료] 백엔드, 웹 UI 및 워커 서비스가 안전하게 중지되었습니다.
echo ===================================================
if /I not "%~1"=="--nopause" if /I not "%~2"=="--nopause" ping 127.0.0.1 -n 3 >nul
endlocal
