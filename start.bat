@echo off
setlocal
chcp 65001 > nul
call "%~dp0start_services.bat"
endlocal
