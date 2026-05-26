$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Francis Investment.lnk")
$Shortcut.TargetPath = "C:\Users\anzhe\FIRSTCC\Francis Investment\launch.vbs"
$Shortcut.WorkingDirectory = "C:\Users\anzhe\FIRSTCC\Francis Investment"
$Shortcut.WindowStyle = 7
$Shortcut.Description = "Francis Investment Mosaic Auto Start"
$Shortcut.Save()
Write-Output "Startup shortcut created successfully."
