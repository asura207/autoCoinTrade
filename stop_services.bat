@echo off
chcp 65001 >nul
title Upbit AutoCoinTrade Services Stopper

echo ===================================================
echo [Upbit AutoTrade] 서비스 중지 중... (Port 8001, 9000)
echo ===================================================

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8001 ^| findstr LISTENING') do (
    echo Port 8001 백엔드 프로세스 종료 [PID: %%a]...
    taskkill /F /PID %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :9000 ^| findstr LISTENING') do (
    echo Port 9000 웹 UI 프로세스 종료 [PID: %%a]...
    taskkill /F /PID %%a >nul 2>&1
)

echo ===================================================
echo [완료] 백엔드 및 웹 UI 서비스가 중지되었습니다.
echo ===================================================
ping 127.0.0.1 -n 3 >nul
