$startupFolder = [Environment]::GetFolderPath("Startup")
$projectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$vbsPath = Join-Path $projectDir "scripts\start_silent.vbs"
$shortcutPath = Join-Path $startupFolder "UpbitAutoTrade.lnk"

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($shortcutPath)
$s.TargetPath = "wscript.exe"
$s.Arguments = "`"$vbsPath`""
$s.WorkingDirectory = $projectDir
$s.Description = "Upbit AutoCoinTrade 자동 시작"
$s.Save()

if (Test-Path $shortcutPath) {
    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Cyan
    Write-Host "[성공] 윈도우 시작프로그램에 등록되었습니다!" -ForegroundColor Green
    Write-Host "===================================================" -ForegroundColor Cyan
    Write-Host "- 등록 위치: $shortcutPath"
    Write-Host "- 동작 방식: 윈도우 부팅 시 백엔드 및 웹 UI가 백그라운드에서 자동 실행됩니다."
    Write-Host "- 등록 해제: uninstall_startup.bat 실행"
    Write-Host ""
} else {
    Write-Host "[오류] 바로가기 등록 실패. 권한을 확인해주세요." -ForegroundColor Red
}

