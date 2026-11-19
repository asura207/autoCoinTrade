@echo off
REM ===================================================
REM Upbit AutoCoinTrade - Services Launcher (Windows)
REM - start_services.sh (Linux) 100% 대칭 표준 실행 진입점
REM - Node.js >= 22.5.0 검증, .env / LIVE_EXECUTOR_OWNER / Ollama 연동
REM - 중복 기동 방지, 프론트엔드 프로덕션 자동 빌드, 백그라운드 기동 및 헬스체크
REM ===================================================
chcp 65001 >nul
setlocal enabledelayedexpansion
title Upbit AutoCoinTrade - Services Launcher

set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"

REM 1. Node.js 런타임 버전 확인 (>= 22.5.0)
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js가 설치되어 있지 않습니다. Node.js 22.5.0 이상을 설치해주세요.
    pause
    exit /b 1
)
node -e "const [maj, min] = process.versions.node.split('.').map(Number); if (maj < 22 || (maj === 22 && min < 5)) { console.error('[ERROR] Node.js >= 22.5.0 required. Current: ' + process.version); process.exit(1); }"
if errorlevel 1 (
    pause
    exit /b 1
)

REM 2. .env 환경 설정 로드 (기본값 포함)
set "BACKEND_HOST=127.0.0.1"
set "BACKEND_PORT=8001"
set "FRONTEND_HOST=127.0.0.1"
set "FRONTEND_PORT=9000"
set "LIVE_EXECUTOR_OWNER=node"
set "USE_LOCAL_OLLAMA_NEWS=true"
set "OLLAMA_BASE_URL=http://192.168.0.100:11434"
set "OLLAMA_NEWS_MODEL=qwen3-news"

if exist ".env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        set "K=%%~A"
        set "V=%%~B"
        if not "!K!"=="" (
            set "!K!=!V!"
        )
    )
)
if "!BACKEND_URL!"=="" set "BACKEND_URL=http://127.0.0.1:!BACKEND_PORT!"

echo ===================================================
echo [Upbit AutoCoinTrade] 서비스 시작 중... (Windows)
echo ===================================================
echo   - LIVE_EXECUTOR_OWNER : !LIVE_EXECUTOR_OWNER!
echo   - Local Ollama News   : !USE_LOCAL_OLLAMA_NEWS! (!OLLAMA_NEWS_MODEL! @ !OLLAMA_BASE_URL!)

if not exist "logs" mkdir "logs"
if not exist "data" mkdir "data"

REM 3. 포트 점유 여부 확인 및 기존 프로세스 안전 정리 (중복 기동 방지)
set "NEED_CLEANUP=0"
netstat -aon 2>nul | findstr ":!BACKEND_PORT! " | findstr "LISTENING" >nul 2>&1 && set "NEED_CLEANUP=1"
netstat -aon 2>nul | findstr ":!FRONTEND_PORT! " | findstr "LISTENING" >nul 2>&1 && set "NEED_CLEANUP=1"
if "!NEED_CLEANUP!"=="1" (
    echo [안내] 기존에 실행 중인 프로세스를 정리합니다...
    if exist "%PROJECT_ROOT%stop_services.bat" (
        call "%PROJECT_ROOT%stop_services.bat" --nopause >nul 2>&1
    )
    ping 127.0.0.1 -n 2 >nul
)

REM 4. 백엔드 의존성 및 프론트엔드 프로덕션 정적 번들 확인/자동 빌드
if not exist "node_modules" if exist "package.json" (
    echo [0/2] 백엔드 패키지 설치 중...
    call npm install --silent >nul 2>&1
)

set "NEED_BUILD=0"
if not exist "frontend\dist\index.html" set "NEED_BUILD=1"
if "!NEED_BUILD!"=="0" (
    powershell -NoProfile -Command "$d=(Get-Item 'frontend\dist\index.html').LastWriteTime; if ((Get-Item 'frontend\src\App.jsx').LastWriteTime -gt $d -or (Get-Item 'frontend\src\styles.css').LastWriteTime -gt $d -or (Get-Item 'frontend\index.html').LastWriteTime -gt $d) { exit 2 } else { exit 0 }" >nul 2>&1
    if errorlevel 2 set "NEED_BUILD=1"
)
if "!NEED_BUILD!"=="1" (
    echo [0/2] 프론트엔드 정적 프로덕션 번들 빌드 중...
    pushd "frontend"
    if not exist "node_modules" call npm install --silent >nul 2>&1
    call npm run build >nul 2>&1 || call npm run build
    popd
)

REM 5. 이전 일자 로그 분할 및 7일 경과 로그 정리
node "%PROJECT_ROOT%backend\common\log_rotator.mjs" --startup >nul 2>&1

REM 6. 백엔드 및 프론트엔드 백그라운드 실행
echo [1/2] 백엔드 서비스 시작 중 (Port !BACKEND_PORT!)...
echo [2/2] 프론트엔드 서비스 시작 중 (!FRONTEND_HOST!:!FRONTEND_PORT!)...
if exist "%PROJECT_ROOT%scripts\start_silent.vbs" (
    wscript.exe "%PROJECT_ROOT%scripts\start_silent.vbs"
) else (
    start /b "" node backend\node_server.mjs >> logs\backend.log 2>&1
    pushd "frontend"
    start /b "" node server.mjs >> ..\logs\frontend.log 2>&1
    popd
)

REM 7. 서비스 기동 대기 및 헬스체크
echo.
echo 서비스 기동 상태 확인 중...
set "BACKEND_OK=0"
for /L %%I in (1,1,15) do (
    if "!BACKEND_OK!"=="0" (
        powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:!BACKEND_PORT!/api/version'; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
        if not errorlevel 1 (
            echo   [OK] 백엔드 API ^(http://localhost:!BACKEND_PORT!^) 정상 응답
            set "BACKEND_OK=1"
        ) else (
            ping 127.0.0.1 -n 2 >nul
        )
    )
)
if "!BACKEND_OK!"=="0" (
    echo   [WARN] 백엔드 응답 대기 중입니다. logs\backend.log 를 확인하세요.
)

set "FRONTEND_OK=0"
for /L %%I in (1,1,15) do (
    if "!FRONTEND_OK!"=="0" (
        powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:!FRONTEND_PORT!'; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
        if not errorlevel 1 (
            echo   [OK] 웹 프론트엔드 ^(http://localhost:!FRONTEND_PORT!^) 정상 응답
            set "FRONTEND_OK=1"
        ) else (
            ping 127.0.0.1 -n 2 >nul
        )
    )
)
if "!FRONTEND_OK!"=="0" (
    echo   [WARN] 프론트엔드 응답 대기 중입니다. logs\frontend.log 를 확인하세요.
)

echo.
echo ===================================================
echo [완료] 백엔드 및 웹 UI 서비스가 백그라운드에서 실행되었습니다.
echo ===================================================
echo - 웹 대시보드       : http://localhost:!FRONTEND_PORT!
echo - 기본 입장 코드     : stock
echo - 백엔드 API        : http://localhost:!BACKEND_PORT!
echo - 실전 실행 주체     : !LIVE_EXECUTOR_OWNER!
echo - 서비스 중지       : stop_services.bat
echo - 로그 확인         : logs\backend.log / logs\frontend.log
echo ===================================================
echo.
if /I not "%~1"=="--nopause" ping 127.0.0.1 -n 3 >nul
endlocal
