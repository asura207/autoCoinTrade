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
  'if "%LIVE_EXECUTOR_OWNER%"=="" set "LIVE_EXECUTOR_OWNER=node"',
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
  '"%NODE_EXE%" backend\\common\\log_rotator.mjs --startup >nul 2>&1',
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
  'set "FRONTEND_HOST=127.0.0.1"',
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
  'if not exist "node_modules" (',
  '  echo [Frontend] Installing dependencies...',
  '  call npm install',
  ')',
  'if not exist "dist\\index.html" (',
  '  echo [Frontend] Building production static bundle...',
  '  call npm run build',
  ')',
  '"%NODE_EXE%" ..\\backend\\common\\log_rotator.mjs --startup >nul 2>&1',
  '"%NODE_EXE%" server.mjs >> ..\\logs\\frontend.log 2>&1',
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

// 4. scripts/start_services.bat (루트 표준 진입점 start_services.bat 위임)
const startBatContent = [
  '@echo off',
  'REM 표준 루트 실행 진입점(start_services.bat)으로 위임',
  'call "%~dp0..\\start_services.bat" %*',
  ''
].join('\r\n');
fs.writeFileSync(path.join(scriptsDir, 'start_services.bat'), startBatContent, 'utf8');

console.log('Helper runner scripts (scripts/run_backend.bat, run_frontend.bat, start_silent.vbs, scripts/start_services.bat) updated successfully.');
console.log('Note: Root start_services.bat / stop_services.bat are maintained directly in project root.');
