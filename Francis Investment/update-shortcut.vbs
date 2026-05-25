Set WshShell = WScript.CreateObject("WScript.Shell")
Set lnk = WshShell.CreateShortcut(WshShell.SpecialFolders("Desktop") & "\Francis Investment.lnk")

lnk.TargetPath = "C:\Windows\System32\cmd.exe"
lnk.Arguments = "/c ""C:\Users\anzhe\FIRSTCC\Francis Investment\start.bat"""
lnk.Description = "Francis Investment - Mosaic Quantitative Analysis Engine"
lnk.WorkingDirectory = "C:\Users\anzhe\FIRSTCC\Francis Investment"
lnk.IconLocation = "C:\Users\anzhe\FIRSTCC\Francis Investment\report-engine\FI-icon.ico,0"
lnk.WindowStyle = 7
lnk.Save()

WScript.Echo "Desktop shortcut updated successfully!"
