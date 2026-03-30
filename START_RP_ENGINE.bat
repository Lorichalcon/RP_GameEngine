@echo off
title RP Game Engine Starter

cd /d "l:\Antigravity\RP_Game_Engine"

echo Starting RP Game Engine...
start "RP Engine" cmd /k "npm run dev"

echo Waiting for server...
timeout /t 4 /nobreak > nul

echo Opening browser...
start http://localhost:5173/

echo Done! Close the RP Engine window to stop the server.
