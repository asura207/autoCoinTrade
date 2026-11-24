@echo off
chcp 65001 >nul
title AutoCoinTrade - Docker 원클릭 통합 실행기 (Windows)
setlocal enabledelayedexpansion

set "INSTALL_DIR=%~dp0"
cd /d "%INSTALL_DIR%"

echo ==============================================================
echo [AutoCoinTrade] Docker 이미지 빌드 ^& DB 통합 실행기 (Windows)
echo ==============================================================
echo.

:: 1. Docker Desktop / Docker Compose 확인
echo [1/4] Docker Desktop 환경 확인 중...
where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo --------------------------------------------------------------
    echo [알림] Docker Desktop 이 설치되어 있지 않습니다.
    echo 공식 홈페이지^(https://www.docker.com/products/docker-desktop/^)에서
    echo Docker Desktop 을 설치하고 실행한 뒤 이 파일을 다시 실행해주세요!
    echo --------------------------------------------------------------
    start https://www.docker.com/products/docker-desktop/
    pause
    exit /b 1
)

docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [오류] Docker 엔진이 실행 중이지 않습니다. Docker Desktop 을 먼저 켜주세요.
    pause
    exit /b 1
)

:: 2. 설정 파일 및 데이터 폴더 준비
echo.
echo [2/4] 설정^(.env^) 및 데이터 디렉토리 준비 중...
if not exist "%INSTALL_DIR%data" mkdir "%INSTALL_DIR%data" >nul 2>&1
if not exist "%INSTALL_DIR%config" mkdir "%INSTALL_DIR%config" >nul 2>&1
if not exist "%INSTALL_DIR%logs" mkdir "%INSTALL_DIR%logs" >nul 2>&1

if not exist "%INSTALL_DIR%.env" (
    if exist "%INSTALL_DIR%.env.example" (
        copy "%INSTALL_DIR%.env.example" "%INSTALL_DIR%.env" >nul
        echo   -^> .env.example 에서 .env 생성 완료
    )
)
if not exist "%INSTALL_DIR%config\upbit_config.json" (
    if exist "%INSTALL_DIR%app\config\upbit_config.example.json" (
        copy "%INSTALL_DIR%app\config\upbit_config.example.json" "%INSTALL_DIR%config\upbit_config.json" >nul
    )
)

set "FRONTEND_PORT=9000"
set "BACKEND_PORT=8001"
set "PGPORT=5432"
set "GATE_CODE=stock"
if exist "%INSTALL_DIR%.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%INSTALL_DIR%.env") do (
        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"
        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"
        if /I "%%~A"=="PGPORT" set "PGPORT=%%~B"
        if /I "%%~A"=="GATE_CODE" set "GATE_CODE=%%~B"
    )
)

:: 3. Docker 이미지 빌드 및 컨테이너 기동 (PostgreSQL 16 + Backend + Frontend)
echo.
echo [3/4] Docker 이미지 빌드 및 DB 포함 전체 서비스 기동 중...
docker compose up -d --build
if %errorlevel% neq 0 (
    echo [오류] Docker Compose 기동에 실패했습니다. 위 로그를 확인해주세요.
    pause
    exit /b 1
)

:: 4. 기동 대기 및 브라우저 오픈
echo.
echo [4/4] 서비스 초기화 대기 중...
ping 127.0.0.1 -n 6 >nul
start http://localhost:!FRONTEND_PORT!

echo.
echo ==============================================================
echo 🚀 AutoCoinTrade (Docker + PostgreSQL 16 + SQLite WAL) 기동 완료!
echo ==============================================================
echo - 웹 대시보드   : http://localhost:!FRONTEND_PORT!
echo - 백엔드 API    : http://localhost:!BACKEND_PORT!
echo - PostgreSQL 16 : localhost:!PGPORT!
echo - 기본 입장 코드 : !GATE_CODE!
echo - 로그 확인     : docker compose logs -f
echo - 서비스 종료   : AutoCoinTrade_Windows_Stop.bat 실행
echo ==============================================================
echo.
pause
