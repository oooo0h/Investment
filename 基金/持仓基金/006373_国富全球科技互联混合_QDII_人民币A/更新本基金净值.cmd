@echo off
chcp 65001 >nul
setlocal
call "%~dp0..\..\..\工具脚本\运行净值更新.cmd" --fund-dir "%~dp0." %*
set "NAV_EXIT=%errorlevel%"
echo.
if not "%NAV_EXIT%"=="0" echo 当前基金更新未成功，请查看上方提示和日志。
if /I not "%~1"=="--no-pause" pause
exit /b %NAV_EXIT%
