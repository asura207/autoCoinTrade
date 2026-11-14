@echo off
chcp 65001 > nul
title Upbit Auto Coin Trade - Stopper
cd /d "%~dp0"
call "%~dp0stop_services.bat"
taskkill /FI "WINDOWTITLE eq AutoCoinTrade-Backend*" /F > nul 2>&1
taskkill /FI "WINDOWTITLE eq AutoCoinTrade-Frontend*" /F > nul 2>&1
if /I not "%~1"=="--nopause" pause

