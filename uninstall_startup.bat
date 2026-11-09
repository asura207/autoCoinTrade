@echo off
chcp 65001 >nul
setlocal

echo ===================================================
echo [Upbit AutoTrade] 윈도우 시작프로그램 등록 해제
echo ===================================================

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\UpbitAutoTrade.lnk"

if exist "%SHORTCUT_PATH%" (
    del /f /q "%SHORTCUT_PATH%"
    echo [완료] 윈도우 시작프로그램에서 바로가기가 삭제되었습니다.
) else (
    echo [안내] 시작프로그램에 등록된 항목이 없습니다.
)

echo.
pause
