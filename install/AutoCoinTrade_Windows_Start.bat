@echo off
chcp 65001 >nul
title AutoCoinTrade - 원클릭 통합 실행기 (Windows)

setlocal enabledelayedexpansion

set "INSTALL_DIR=%~dp0"
set "APP_DIR=%INSTALL_DIR%app"

echo ==============================================================
echo [AutoCoinTrade] 비개발자용 원클릭 자동 설치 및 실행기 (Windows)
echo ==============================================================
echo.

:: 1. Node.js 설치 확인 (>= 22.5.0)
echo [1/5] Node.js 런타임 환경 확인 중...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo --------------------------------------------------------------
    echo [알림] Node.js 가 설치되어 있지 않습니다.
    echo 본 프로그램 구동을 위해 Node.js 22 LTS ^(^>= 22.5.0^) 설치가 필요합니다.
    echo 공식 웹사이트(https://nodejs.org/)로 자동 연결합니다.
    echo LTS 버전을 다운로드하여 기본 옵션으로 설치하신 후,
    echo 이 파일을 다시 실행해주세요!
    echo --------------------------------------------------------------
    start https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 5)) { console.error('[오류] Node.js >= 22.5.0 이상이 필요합니다 (node:sqlite 지원). 현재: ' + process.version); process.exit(1); }"
if %errorlevel% neq 0 (
    pause
    exit /b 1
)
echo   -> Node.js 정상 확인됨: !NODE_VER! ^(^>= 22.5.0^)

:: 2. Python 환경 확인 및 가상환경 구성 (선택/퀀트 보조)
echo.
echo [2/5] Python 환경 확인 중...
where python >nul 2>&1
if %errorlevel% equ 0 (
    if not exist "%APP_DIR%\.venv" (
        echo   -> Python 가상환경(.venv) 생성 중...
        python -m venv "%APP_DIR%\.venv" >nul 2>&1
    )
    if exist "%APP_DIR%\.venv\Scripts\pip.exe" (
        if exist "%APP_DIR%\requirements.txt" (
            echo   -> Python 필수 패키지 점검 중...
            call "%APP_DIR%\.venv\Scripts\pip.exe" install -r "%APP_DIR%\requirements.txt" --quiet >nul 2>&1
        )
    )
    echo   -> Python 환경 준비 완료
) else (
    echo   -> Python 미설치 (Node.js 독립 모드로 10대 알고리즘과 웹서버가 완벽 작동합니다)
)

:: 3. 설정 템플릿 및 폴더 준비
echo.
echo [3/5] 데이터 및 설정 디렉토리 준비 중...
if not exist "%APP_DIR%\logs" mkdir "%APP_DIR%\logs" >nul 2>&1
if not exist "%APP_DIR%\data" mkdir "%APP_DIR%\data" >nul 2>&1

if not exist "%APP_DIR%\config\upbit_config.json" (
    if exist "%APP_DIR%\config\upbit_config.example.json" (
        copy "%APP_DIR%\config\upbit_config.example.json" "%APP_DIR%\config\upbit_config.json" >nul
    )
)
if not exist "%APP_DIR%\.env" (
    if exist "%APP_DIR%\.env.example" (
        copy "%APP_DIR%\.env.example" "%APP_DIR%\.env" >nul
    )
)

set "BACKEND_PORT=8001"
set "FRONTEND_PORT=9000"
set "FRONTEND_HOST=0.0.0.0"
if exist "%APP_DIR%\.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%APP_DIR%\.env") do (
        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"
        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"
        if /I "%%~A"=="FRONTEND_HOST" set "FRONTEND_HOST=%%~B"
    )
)

:: 4. 의존성 패키지 설치 확인
echo.
echo [4/5] 필수 모듈 및 프론트엔드 번들 점검 중...
if not exist "%APP_DIR%\node_modules" if exist "%APP_DIR%\package.json" (
    echo   -> 백엔드 패키지 자동 설치 중 (최초 1회 약 15초 소요)...
    pushd "%APP_DIR%"
    call npm install --silent >nul 2>&1
    popd
)

if not exist "%APP_DIR%\frontend\node_modules" (
    echo   -> 프론트엔드 패키지 자동 설치 중 (최초 1회 약 20초 소요)...
    pushd "%APP_DIR%\frontend"
    call npm install --silent >nul 2>&1
    popd
)

if not exist "%APP_DIR%\frontend\dist" (
    echo   -> 프론트엔드 프로덕션 빌드 생성 중...
    pushd "%APP_DIR%\frontend"
    call npm run build >nul 2>&1
    popd
)

:: 기존 포트 충돌 방지 및 안전 종료
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":!BACKEND_PORT! " ^| findstr "LISTENING"') do taskkill /F /T /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":!FRONTEND_PORT! " ^| findstr "LISTENING"') do taskkill /F /T /PID %%a >nul 2>&1

:: 5. 백엔드 및 프론트엔드 백그라운드 구동
echo.
echo [5/5] 서비스 기동 중...
pushd "%APP_DIR%"
start /b "" node backend\node_server.mjs > logs\backend.log 2>&1
cd frontend
start /b "" npx vite --port !FRONTEND_PORT! --host !FRONTEND_HOST! > ..\logs\frontend.log 2>&1
popd

:: 서버 기동 대기
echo.
echo 시스템 초기화 및 기동 대기 중 (약 3초)...
ping 127.0.0.1 -n 4 >nul

:: 기본 웹 브라우저 자동 실행
echo 웹 대시보드 브라우저 자동 실행...
start http://localhost:!FRONTEND_PORT!

echo.
echo ==============================================================
echo 🚀 AutoCoinTrade 시스템이 백그라운드에서 성공적으로 구동되었습니다!
echo ==============================================================
echo - 접속 주소     : http://localhost:!FRONTEND_PORT! ^(대체 주소: http://localhost:!BACKEND_PORT!^)
echo - 기본 입장 코드 : stock (설정 화면에서 원하는 코드로 변경 가능)
echo - 최초 실행 안내 : 브라우저 화면에 [Step-by-Step 설정 마법사]가 뜹니다.
echo                  [DB 없음 (SQLite 자동)]을 선택하시면 별도 설치 없이
echo                  원클릭으로 즉시 사용 가능합니다!
echo - 서비스 종료   : 'AutoCoinTrade_Windows_Stop.bat' 파일을 실행하세요.
echo ==============================================================
echo.
pause
