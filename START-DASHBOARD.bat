@echo off
title SEO Approval Agent - keep this window open
rem Run from the folder this file is in (works wherever the project is copied).
cd /d "%~dp0"

where node >nul 2>nul || (
  echo  Node.js is not installed. Install it from https://nodejs.org and run this again.
  pause
  exit /b
)

rem Already running? Then only open the dashboard.
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul && (
  echo  SEO Approval Agent is already running. Opening the dashboard...
  start "" http://localhost:3000
  timeout /t 3 >nul
  exit /b
)

if not exist node_modules (
  echo  First start: installing packages...
  call npm install
)

echo.
echo  SEO Approval Agent is starting...
echo  Dashboard: http://localhost:3000  (opens in your browser in a few seconds)
echo  Keep this window open. Closing it stops the agent.
echo.
rem Open the browser once the agent has had time to start.
start "" /min cmd /c "timeout /t 5 >nul & start http://localhost:3000"
call npm start
echo.
echo  The agent stopped. Press any key to close this window.
pause >nul
