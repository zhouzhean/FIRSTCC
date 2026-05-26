Set WshShell = CreateObject("WScript.Shell")
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")

Dim serverOk
serverOk = False
On Error Resume Next
http.Open "GET", "http://127.0.0.1:8765/api/status", False
http.SetTimeouts 2000, 2000, 2000, 2000
http.Send
If Err.Number = 0 Then
    If http.Status = 200 Then
        serverOk = True
    End If
End If
On Error Goto 0

If Not serverOk Then
    WshShell.Run "cmd /c cd /d " & Chr(34) & "C:\Users\anzhe\FIRSTCC\Francis Investment" & Chr(34) & " && node mosaic_server.js", 0, False
    WScript.Sleep 4000
End If

WshShell.Run Chr(34) & "C:\Program Files\Google\Chrome\Application\chrome.exe" & Chr(34) & " --app=" & Chr(34) & "http://127.0.0.1:8765" & Chr(34) & " --window-size=1400,900", 1, False
