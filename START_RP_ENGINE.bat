@echo off
title RP Game Engine Starter
echo Starting RP Game Engine Server...

cd /d "l:\Antigravity\RP_Game_Engine"

:: サーバーを別ウィンドウで起動し、少し待ってからブラウザを開く
start /b npm run dev

echo Waiting for server to initialize...
timeout /t 3 /nobreak > nul

echo Opening Browser...
start http://localhost:5173/

echo.
echo ==========================================
echo  RP Engine is now running!
echo  URL: http://localhost:5173/
echo ==========================================
echo.
echo Press any key to stop the server and exit.
pause > nul
