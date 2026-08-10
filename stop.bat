@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [stop.bat] Stopping AgentXin dev stack...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-dev.ps1"
if errorlevel 1 (
  echo.
  echo [error] Stop failed. See messages above.
  pause
  exit /b 1
)
echo.
pause
