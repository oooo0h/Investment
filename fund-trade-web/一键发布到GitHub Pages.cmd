@echo off
chcp 65001 >nul
setlocal
title 基金账本 - 发布网站
cd /d "%~dp0"
set "FUND_WEB_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%FUND_WEB_NODE%" set "FUND_WEB_NODE=node"
"%FUND_WEB_NODE%" "%~dp0scripts\publish-local.mjs" %*
set "RESULT=%ERRORLEVEL%"
echo.
echo 本次操作已结束，请以上方最终结果为准。
echo 按任意键关闭此窗口……
if not "%FUND_PUBLISH_NO_PAUSE%"=="1" pause >nul
exit /b %RESULT%
