@echo off
chcp 65001 >nul
setlocal
title Upbit AutoCoinTrade Services Launcher

cd /d "%~dp0.."
set "BACKEND_PORT=8001"
set "FRONTEND_PORT=9000"
if exist ".env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"
        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"
    )
)

echo ===================================================
echo [Upbit AutoTrade] 서비스 시작 중...
echo ===================================================

if exist "%~dp0..\stop_services.bat" (
    call "%~dp0..\stop_services.bat" >nul 2>&1
)

wscript.exe "%~dp0start_silent.vbs"

echo.
echo [안내] 백엔드(Port %BACKEND_PORT%) 및 웹 UI(Port %FRONTEND_PORT%)가 백그라운드에서 실행되었습니다.
echo [접속 주소] http://localhost:%FRONTEND_PORT%
echo [입장 코드] stock
echo.
ping 127.0.0.1 -n 3 >nul
