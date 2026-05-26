Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "C:\Program Files\Google\Chrome\Application\chrome.exe" & Chr(34) & " --app=" & Chr(34) & "http://8.153.101.112:8765" & Chr(34) & " --window-size=1400,900", 1, False
