# Update Francis Investment desktop shortcut to use Mosaic server
$shortcutPath = "$env:USERPROFILE\Desktop\Francis Investment.lnk"
$wsh = New-Object -ComObject WScript.Shell

if (Test-Path $shortcutPath) {
    $lnk = $wsh.CreateShortcut($shortcutPath)
    $lnk.TargetPath = "C:\Windows\System32\cmd.exe"
    $lnk.Arguments = "/c `"C:\Users\anzhe\FIRSTCC\Francis Investment\start.bat`""
    $lnk.Description = "Francis Investment · Mosaic 量化投资分析引擎"
    $lnk.WorkingDirectory = "C:\Users\anzhe\FIRSTCC\Francis Investment"
    $lnk.IconLocation = "C:\Users\anzhe\FIRSTCC\Francis Investment\report-engine\FI-icon.ico,0"
    $lnk.WindowStyle = 7  # Minimized
    $lnk.Save()
    Write-Host "✅ Shortcut updated: $shortcutPath"
} else {
    Write-Host "Creating new shortcut..."
    $lnk = $wsh.CreateShortcut($shortcutPath)
    $lnk.TargetPath = "C:\Windows\System32\cmd.exe"
    $lnk.Arguments = "/c `"C:\Users\anzhe\FIRSTCC\Francis Investment\start.bat`""
    $lnk.Description = "Francis Investment · Mosaic 量化投资分析引擎"
    $lnk.WorkingDirectory = "C:\Users\anzhe\FIRSTCC\Francis Investment"
    $lnk.IconLocation = "C:\Users\anzhe\FIRSTCC\Francis Investment\report-engine\FI-icon.ico,0"
    $lnk.WindowStyle = 7
    $lnk.Save()
    Write-Host "✅ Shortcut created: $shortcutPath"
}
