$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\Francis Investment.lnk")
$Shortcut.TargetPath = "C:\Users\anzhe\FIRSTCC\Francis Investment\start.bat"
$Shortcut.WorkingDirectory = "C:\Users\anzhe\FIRSTCC\Francis Investment"
$Shortcut.IconLocation = "C:\Users\anzhe\FIRSTCC\Francis Investment\report-engine\FI-icon.ico,0"
$Shortcut.WindowStyle = 7
$Shortcut.Save()
Write-Output "OK: Desktop shortcut created"
