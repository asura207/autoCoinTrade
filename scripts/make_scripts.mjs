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
  'set "NODE_EXE=D:\\dev\\tools\\nodejs\\node.exe"',
  'if not exist "%NODE_EXE%" set "NODE_EXE=node"',
  '"%NODE_EXE%" backend/node_server.mjs >> logs\\backend.log 2>&1',
  ''
].join('\r\n');
fs.writeFileSync(path.join(scriptsDir, 'run_backend.bat'), runBackendBat, 'utf8');

// 2. scripts/run_frontend.bat
const runFrontendBat = [
  '@echo off',
  'cd /d "%~dp0..\\frontend"',
  'if not exist "..\\logs" mkdir "..\\logs"',
  'set "NODE_EXE=D:\\dev\\tools\\nodejs\\node.exe"',
  'if not exist "%NODE_EXE%" set "NODE_EXE=node"',
  'if not exist "node_modules\\vite" (',
  '  echo [Frontend] Installing dependencies...',
  '  call npm install',
  ')',
  '"%NODE_EXE%" node_modules\\vite\\bin\\vite.js --host >> ..\\logs\\frontend.log 2>&1',
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
  'title Upbit AutoCoinTrade Services Launcher',
  '',
  'echo ===================================================',
  'echo [Upbit AutoTrade] 서비스 시작 중...',
  'echo ===================================================',
  '',
  'wscript.exe "%~dp0start_silent.vbs"',
  '',
  'echo.',
  'echo [안내] 백엔드(Port 8001) 및 웹 UI(Port 9000)가 백그라운드에서 실행되었습니다.',
  'echo [접속 주소] http://localhost:9000',
  'echo.',
  'ping 127.0.0.1 -n 3 >nul',
  ''
].join('\r\n');
fs.writeFileSync(path.join(scriptsDir, 'start_services.bat'), startBatContent, 'utf8');

// 5. stop_services.bat (root)
const stopBatContent = [
  '@echo off',
  'chcp 65001 >nul',
  'title Upbit AutoCoinTrade Services Stopper',
  '',
  'echo ===================================================',
  'echo [Upbit AutoTrade] 서비스 중지 중... (Port 8001, 9000)',
  'echo ===================================================',
  '',
  'for /f "tokens=5" %%a in (\'netstat -aon ^| findstr :8001 ^| findstr LISTENING\') do (',
  '    echo Port 8001 백엔드 프로세스 종료 [PID: %%a]...',
  '    taskkill /F /PID %%a >nul 2>&1',
  ')',
  '',
  'for /f "tokens=5" %%a in (\'netstat -aon ^| findstr :9000 ^| findstr LISTENING\') do (',
  '    echo Port 9000 웹 UI 프로세스 종료 [PID: %%a]...',
  '    taskkill /F /PID %%a >nul 2>&1',
  ')',
  '',
  'echo ===================================================',
  'echo [완료] 백엔드 및 웹 UI 서비스가 중지되었습니다.',
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
