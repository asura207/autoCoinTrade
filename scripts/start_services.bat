@echo off
chcp 65001 >nul
title Upbit AutoCoinTrade Services Launcher

echo ===================================================
echo [Upbit AutoTrade] 서비스 시작 중...
echo ===================================================

wscript.exe "%~dp0start_silent.vbs"

echo.
echo [안내] 백엔드(Port 8001) 및 웹 UI(Port 9000)가 백그라운드에서 실행되었습니다.
echo [접속 주소] http://localhost:9000
echo.
ping 127.0.0.1 -n 3 >nul
