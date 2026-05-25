@echo off
chcp 65001 >nul
title Francis Investment · Mosaic
setlocal enabledelayedexpansion

echo.
echo ============================================
echo   Francis Investment · Mosaic
echo ============================================
echo.

cd /d "%~dp0"

:: Check if server is already running on port 8765
set SERVER_RUNNING=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765.*LISTENING" 2^>nul') do (
    set SERVER_RUNNING=1
)

if !SERVER_RUNNING! EQU 1 (
    echo [OK] Server is already running on port 8765.
    echo [>>] Opening Chrome directly...
    goto :launch
)

echo [1/2] Starting Mosaic server...
start "Francis Investment · Mosaic Server" cmd /c "node mosaic_server.js"

echo [2/2] Waiting for server to be ready...
set RETRY=0
:waitloop
timeout /t 1 /nobreak >nul
set /a RETRY+=1

:: Check if server is responding
curl -s -o NUL http://127.0.0.1:8765/api/status 2>nul
if !ERRORLEVEL! EQU 0 (
    echo   Server is ready ^(took !RETRY!s^)
    goto :launch
)

if !RETRY! LSS 15 (
    goto :waitloop
)

echo   [WARNING] Server not responding after 15s, launching browser anyway...
echo   Check the "Francis Investment · Mosaic Server" window for errors.

:launch
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app="http://127.0.0.1:8765" --window-size=1400,900 --no-proxy-server --disable-features=AsyncDns --disable-quic --disable-background-networking

echo.
echo   Server: http://127.0.0.1:8765
echo   Close "Francis Investment · Mosaic Server" console to stop.
echo.

timeout /t 2 /nobreak >nul
exit
