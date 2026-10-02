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
echo [1/3] 首次运行，正在安装依赖...
echo       大约需要 1-3 分钟，请耐心等待，不要关闭本窗口。
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto installfail
echo.
goto start

:start
echo [2/3] 正在启动后端服务（端口 3000）...
echo.
rem 上一次的后端可能还占着 3000 端口，先关掉，免得新的起不来
call :killport 3000
start "算法可视化平台-后端服务（别关）" /min cmd /c "node server\index.mjs"
call :waitport 3000
if errorlevel 1 echo    提示：后端好像没起来，请看那个最小化的“后端服务”窗口里的报错。
echo.

echo [3/3] 正在启动前端服务（端口 5173），几秒后浏览器会自动打开。
echo.
echo    如果浏览器没有自动打开，请手动访问下面这个网址：
echo.
echo        http://localhost:5173/
echo.
echo    要停止服务：关掉这个黑窗口（后端会一起停）。
echo ==================================================
echo.
start "" http://localhost:5173/
call npm run dev

rem 前端停了，后端也一起停掉，不然下次双击会撞端口
call :killport 3000
echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
exit /b 0

:waitport
set _n=0
:waitloop
netstat -ano | findstr ":%~1 " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 exit /b 0
set /a _n+=1
if %_n% GEQ 15 exit /b 1
ping -n 2 127.0.0.1 >nul
goto waitloop

:killport
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%~1 " ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>nul
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
