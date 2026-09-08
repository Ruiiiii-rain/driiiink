@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  🥤 喝了么 正在启动...
echo  启动后浏览器会自动打开 http://localhost:3000
echo  关闭本窗口即停止服务
echo.
start "" /b cmd /c "timeout /t 1 /nobreak >nul && start http://localhost:3000"
node server.js
pause
