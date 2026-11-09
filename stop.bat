@echo off
chcp 65001 > nul
title Upbit Auto Coin Trade - Stopper

echo ========================================================
echo   Upbit 다중 전략 코인 자동매매 시스템 종료 (Stop)
echo ========================================================

echo [1/2] 프론트엔드(Port 9000) 및 백엔드(Port 8001) 프로세스 종료 중...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8001" ^| findstr "LISTENING"') do (
    echo Stopping Backend PID: %%a
    taskkill /F /PID %%a > nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9000" ^| findstr "LISTENING"') do (
    echo Stopping Frontend PID: %%a
    taskkill /F /PID %%a > nul 2>&1
)

taskkill /FI "WINDOWTITLE eq AutoCoinTrade-Backend*" /F > nul 2>&1
taskkill /FI "WINDOWTITLE eq AutoCoinTrade-Frontend*" /F > nul 2>&1

echo [2/2] 모든 서버 프로세스가 안전하게 종료되었습니다.
echo ========================================================
pause

