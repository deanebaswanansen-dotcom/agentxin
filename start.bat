@echo off
setlocal
cd /d "%~dp0"

title 小说Agent - 启动中
echo ========================================
echo   小说 Agent 一键启动
echo   文件夹拷给别人后，双击本文件即可
echo ========================================
echo.
echo [1/3] 检查 / 自动安装运行环境 (Node.js + 依赖)...
echo       首次运行可能需要几分钟，请保持网络畅通。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-env.ps1"
if errorlevel 1 (
  echo.
  echo [失败] 环境安装失败。
  echo 可手动安装 Node.js 18+ ： https://nodejs.org
  echo 然后重新双击 start.bat
  echo.
  pause
  exit /b 1
)

echo.
echo [2/3] 启动前后端服务...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dev.ps1"
if errorlevel 1 (
  echo.
  echo [失败] 启动失败。请查看 logs\dev\ 下的 *.err.log
  echo.
  pause
  exit /b 1
)

echo.
echo [3/3] 完成
echo   浏览器访问: http://127.0.0.1:5173
echo   停止服务: 双击 stop.bat
echo.
pause
endlocal
