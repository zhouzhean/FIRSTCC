@echo off
chcp 65001 >nul
title Francis Investment · Mosaic

echo.
echo ============================================
echo   Francis Investment · Mosaic
echo ============================================
echo.

cd /d "%~dp0"

:: Kill any existing server on port 8765
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765.*LISTENING" 2^>nul') do (
    echo [0] Stopping previous server (PID %%a)...
    powershell -Command "Stop-Process -Id %%a -Force -ErrorAction SilentlyContinue" >nul 2>&1
    if !ERRORLEVEL! NEQ 0 taskkill /F /PID %%a >nul 2>&1
)

echo [1/2] Starting Mosaic server...
start "Francis Investment · Mosaic Server" /MIN cmd /c "node mosaic_server.js"

echo [2/2] Waiting for server to start...
timeout /t 3 /nobreak >nul

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app="http://localhost:8765" --window-size=1400,900

echo.
echo   Server: http://localhost:8765
echo   Close "Francis Investment · Mosaic Server" console to stop.
echo.

timeout /t 2 /nobreak >nul
exit
