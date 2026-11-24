@echo off
chcp 65001 >nul
title AutoCoinTrade - Docker 원클릭 통합 종료기 (Windows)
setlocal enabledelayedexpansion

set "INSTALL_DIR=%~dp0"
cd /d "%INSTALL_DIR%"

echo ==============================================================
echo [AutoCoinTrade] Docker 서비스 안전 종료 중...
echo ==============================================================

docker compose --profile workers down

echo.
echo ==============================================================
echo [완료] 모든 컨테이너가 안전하게 종료되었습니다.
echo        (DB 볼륨 및 data/config 폴더는 안전하게 보존됩니다.)
echo ==============================================================
echo.
ping 127.0.0.1 -n 3 >nul
