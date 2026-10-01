@echo off
chcp 936 >nul
cd /d "%~dp0"
title 算法可视化平台

echo ==================================================
echo    算法可视化平台  正在启动
echo ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "node_modules" goto firstrun
goto start

:firstrun
echo [1/2] 首次运行，正在安装依赖...
echo       大约需要 1-3 分钟，请耐心等待，不要关闭本窗口。
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto installfail
echo.
goto start

:start
echo [2/2] 启动服务中，几秒后浏览器会自动打开。
echo.
echo    如果浏览器没有自动打开，请手动访问下面这个网址：
echo.
echo        http://localhost:5173/
echo.
echo    要停止服务，直接关闭这个黑窗口即可。
echo ==================================================
echo.
start "" http://localhost:5173/
call npm run dev
echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
exit /b 0

:nonode
echo [错误] 没有检测到 Node.js。
echo.
echo 请先安装 Node.js：打开 https://nodejs.org/zh-cn
echo 下载 LTS 版本，一路点“下一步”装好，然后重新双击本文件。
echo.
pause
exit /b 1

:installfail
echo.
echo [错误] 依赖安装失败，通常是网络问题。
echo 请连上网络后重新双击本文件。
echo.
pause
exit /b 1
