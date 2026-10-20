@echo off
chcp 65001 >nul
setlocal
call "%~dp0工具脚本\运行净值更新.cmd" --held %*
set "NAV_EXIT=%errorlevel%"
echo.
if not "%NAV_EXIT%"=="0" echo 有任务未成功，请查看上方提示和临时文件中的日志。
if /I not "%~1"=="--no-pause" pause
exit /b %NAV_EXIT%
