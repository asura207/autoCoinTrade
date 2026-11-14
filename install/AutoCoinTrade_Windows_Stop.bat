@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title AutoCoinTrade - 원클릭 통합 종료기 (Windows)

set "INSTALL_DIR=%~dp0"
set "APP_DIR=%INSTALL_DIR%app"
set "BACKEND_PORT=8001"
set "FRONTEND_PORT=9000"
if exist "%APP_DIR%\.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%APP_DIR%\.env") do (
        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"
        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"
    )
)

echo ==============================================================
echo [AutoCoinTrade] 서비스 안전 종료 중... ^(Port %BACKEND_PORT%, %FRONTEND_PORT%^)
echo ==============================================================

set "STOPPED_COUNT=0"

for %%F in ("%APP_DIR%\logs\.backend.pid" "%APP_DIR%\logs\.frontend.pid" "%APP_DIR%\logs\.orchestrator.pid") do (
    if exist %%~F (
        set /p TARGET_PID=<%%~F
        if defined TARGET_PID (
            taskkill /F /T /PID !TARGET_PID! >nul 2>&1
            set /a "STOPPED_COUNT+=1"
        )
        del /f /q %%~F >nul 2>&1
    )
)

:: 1. 백엔드 포트 점유 프로세스 종료
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":!BACKEND_PORT! " ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /T /PID %%a >nul 2>&1
    set /a "STOPPED_COUNT+=1"
)

:: 2. 프론트엔드 포트 점유 프로세스 종료
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":!FRONTEND_PORT! " ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /T /PID %%a >nul 2>&1
    set /a "STOPPED_COUNT+=1"
)

:: 3. 패키지 내부 node/python 워커 추가 점검
powershell -NoProfile -Command "$app='%APP_DIR%'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*node_server.mjs*' -or $_.CommandLine -like '*main_orchestrator.py*' -or $_.CommandLine -like '*llm_filter_worker.py*') -and $_.CommandLine -like ('*' + $app + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo.
echo ==============================================================
echo [완료] AutoCoinTrade 백엔드, 웹 UI 및 워커 프로세스가 안전하게 종료되었습니다.
echo ==============================================================
echo.
ping 127.0.0.1 -n 2 >nul
