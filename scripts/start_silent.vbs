Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)

WshShell.Run "cmd.exe /c " & q & scriptDir & "\run_backend.bat" & q, 0, False
WScript.Sleep 500
WshShell.Run "cmd.exe /c " & q & scriptDir & "\run_frontend.bat" & q, 0, False
