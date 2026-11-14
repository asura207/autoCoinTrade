import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');
const scriptsDir = path.join(projectDir, 'scripts');

// 1. scripts/run_backend.bat
const runBackendBat = [
  '@echo off',
  'cd /d "%~dp0.."',
  'if not exist "logs" mkdir "logs"',
  'if not exist "data" mkdir "data"',
  '',
  'if exist ".env" (',
  '    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (',
  '        if not "%%~A"=="" set "%%~A=%%~B"',
  '    )',
  ')',
  '',
  'set "NODE_EXE="',
  'where node >nul 2>&1',
  'if not errorlevel 1 set "NODE_EXE=node"',
  'if "%NODE_EXE%"=="" if exist "D:\\dev\\tools\\nodejs\\node.exe" set "NODE_EXE=D:\\dev\\tools\\nodejs\\node.exe"',
  'if "%NODE_EXE%"=="" set "NODE_EXE=node"',
  '',
  'if not exist "node_modules" if exist "package.json" (',
  '    echo [Backend] Installing root dependencies...',
  '    call npm install --silent',
  ')',
  '',
  '"%NODE_EXE%" backend/node_server.mjs >> logs\\backend.log 2>&1',
  ''
].join('\r\n');
fs.writeFileSync(path.join(scriptsDir, 'run_backend.bat'), runBackendBat, 'utf8');

// 2. scripts/run_frontend.bat
const runFrontendBat = [
  '@echo off',
  'setlocal',
  'cd /d "%~dp0..\\frontend"',
  'if not exist "..\\logs" mkdir "..\\logs"',
  '',
  'set "FRONTEND_PORT=9000"',
  'set "FRONTEND_HOST=0.0.0.0"',
  'if exist "..\\.env" (',
  '    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("..\\.env") do (',
  '        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"',
  '        if /I "%%~A"=="FRONTEND_HOST" set "FRONTEND_HOST=%%~B"',
  '    )',
  ')',
  '',
  'set "NODE_EXE="',
  'where node >nul 2>&1',
  'if not errorlevel 1 set "NODE_EXE=node"',
  'if "%NODE_EXE%"=="" if exist "D:\\dev\\tools\\nodejs\\node.exe" set "NODE_EXE=D:\\dev\\tools\\nodejs\\node.exe"',
  'if "%NODE_EXE%"=="" set "NODE_EXE=node"',
  '',
  'if not exist "node_modules\\vite" (',
  '  echo [Frontend] Installing dependencies...',
  '  call npm install',
  ')',
  '"%NODE_EXE%" node_modules\\vite\\bin\\vite.js --port %FRONTEND_PORT% --host %FRONTEND_HOST% >> ..\\logs\\frontend.log 2>&1',
  ''
].join('\r\n');
fs.writeFileSync(path.join(scriptsDir, 'run_frontend.bat'), runFrontendBat, 'utf8');

// 3. scripts/start_silent.vbs
const vbsContent = [
  'Set WshShell = CreateObject("WScript.Shell")',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)',
  'q = Chr(34)',
  '',
  'WshShell.Run "cmd.exe /c " & q & scriptDir & "\\run_backend.bat" & q, 0, False',
  'WScript.Sleep 500',
  'WshShell.Run "cmd.exe /c " & q & scriptDir & "\\run_frontend.bat" & q, 0, False',
  ''
].join('\r\n');
fs.writeFileSync(path.join(scriptsDir, 'start_silent.vbs'), vbsContent, 'utf8');

// 4. scripts/start_services.bat
const startBatContent = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'title Upbit AutoCoinTrade Services Launcher',
  '',
  'cd /d "%~dp0.."',
  'set "BACKEND_PORT=8001"',
  'set "FRONTEND_PORT=9000"',
  'if exist ".env" (',
  '    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (',
  '        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"',
  '        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"',
  '    )',
  ')',
  '',
  'echo ===================================================',
  'echo [Upbit AutoTrade] 서비스 시작 중...',
  'echo ===================================================',
  '',
  'if exist "%~dp0..\\stop_services.bat" (',
  '    call "%~dp0..\\stop_services.bat" >nul 2>&1',
  ')',
  '',
  'wscript.exe "%~dp0start_silent.vbs"',
  '',
  'echo.',
  'echo [안내] 백엔드(Port %BACKEND_PORT%) 및 웹 UI(Port %FRONTEND_PORT%)가 백그라운드에서 실행되었습니다.',
  'echo [접속 주소] http://localhost:%FRONTEND_PORT%',
  'echo [입장 코드] stock',
  'echo.',
  'ping 127.0.0.1 -n 3 >nul',
  ''
].join('\r\n');
fs.writeFileSync(path.join(scriptsDir, 'start_services.bat'), startBatContent, 'utf8');

// 5. stop_services.bat (root)
const stopBatContent = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal enabledelayedexpansion',
  'title Upbit AutoCoinTrade Services Stopper',
  '',
  'cd /d "%~dp0"',
  'set "BACKEND_PORT=8001"',
  'set "FRONTEND_PORT=9000"',
  'if exist ".env" (',
  '    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (',
  '        if /I "%%~A"=="BACKEND_PORT" set "BACKEND_PORT=%%~B"',
  '        if /I "%%~A"=="FRONTEND_PORT" set "FRONTEND_PORT=%%~B"',
  '    )',
  ')',
  '',
  'echo ===================================================',
  'echo [Upbit AutoTrade] 서비스 안전 중지 중... (Port %BACKEND_PORT%, %FRONTEND_PORT%)',
  'echo ===================================================',
  '',
  'for %%F in ("logs\\.backend.pid" "logs\\.frontend.pid" "logs\\.orchestrator.pid") do (',
  '    if exist %%~F (',
  '        set /p TARGET_PID=<%%~F',
  '        if defined TARGET_PID (',
  '            echo PID 파일 기반 프로세스 종료 [PID: !TARGET_PID!]...',
  '            taskkill /F /T /PID !TARGET_PID! >nul 2>&1',
  '        )',
  '        del /f /q %%~F >nul 2>&1',
  '    )',
  ')',
  '',
  'for /f "tokens=5" %%a in (\'netstat -aon ^| findstr ":%BACKEND_PORT% " ^| findstr "LISTENING"\') do (',
  '    echo Port %BACKEND_PORT% 백엔드 프로세스 종료 [PID: %%a]...',
  '    taskkill /F /T /PID %%a >nul 2>&1',
  ')',
  '',
  'for /f "tokens=5" %%a in (\'netstat -aon ^| findstr ":%FRONTEND_PORT% " ^| findstr "LISTENING"\') do (',
  '    echo Port %FRONTEND_PORT% 웹 UI 프로세스 종료 [PID: %%a]...',
  '    taskkill /F /T /PID %%a >nul 2>&1',
  ')',
  '',
  'powershell -NoProfile -Command "$root=\'%CD%\'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like \'*node_server.mjs*\' -or $_.CommandLine -like \'*main_orchestrator.py*\' -or $_.CommandLine -like \'*llm_filter_worker.py*\') -and $_.CommandLine -like (\'*\' + $root + \'*\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1',
  '',
  'echo ===================================================',
  'echo [완료] 백엔드, 웹 UI 및 워커 서비스가 안전하게 중지되었습니다.',
  'echo ===================================================',
  'ping 127.0.0.1 -n 3 >nul',
  ''
].join('\r\n');
fs.writeFileSync(path.join(projectDir, 'stop_services.bat'), stopBatContent, 'utf8');

// 6. start_services.bat (root)
const rootStartBatContent = [
  '@echo off',
  'call "%~dp0scripts\\start_services.bat"',
  ''
].join('\r\n');
fs.writeFileSync(path.join(projectDir, 'start_services.bat'), rootStartBatContent, 'utf8');

console.log('All launcher and runner scripts updated successfully.');
