@echo off
chcp 65001 >nul
title AutoCoinTrade - 원클릭 통합 종료기 (Windows)

echo ==============================================================
echo [AutoCoinTrade] 서비스 안전 종료 중...
echo ==============================================================

set "STOPPED_COUNT=0"

:: 1. 백엔드 포트(8001) 점유 프로세스 종료
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8001" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
    set /a "STOPPED_COUNT+=1"
)

:: 2. 프론트엔드 포트(9000) 점유 프로세스 종료
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9000" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
    set /a "STOPPED_COUNT+=1"
)

:: 3. node_server 및 vite 프로세스 추가 점검
taskkill /F /IM "node.exe" /FI "WINDOWTITLE eq AutoCoinTrade*" >nul 2>&1

echo.
echo ==============================================================
echo [완료] AutoCoinTrade 백엔드 및 웹 UI 프로세스가 안전하게 종료되었습니다.
echo ==============================================================
echo.
ping 127.0.0.1 -n 2 >nul
