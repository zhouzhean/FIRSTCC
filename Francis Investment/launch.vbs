Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d " & Chr(34) & "C:\Users\anzhe\FIRSTCC\Francis Investment" & Chr(34) & " && node mosaic_server.js", 0, False
