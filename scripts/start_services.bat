@echo off
REM 표준 루트 실행 진입점(start_services.bat)으로 위임
call "%~dp0..\start_services.bat" %*
