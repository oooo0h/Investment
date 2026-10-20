@echo off
setlocal
cd /d "%~dp0"
set "FUND_WEB_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%FUND_WEB_NODE%" set "FUND_WEB_NODE=node"
"%FUND_WEB_NODE%" "%~dp0scripts\publish-local.mjs" %*
set "RESULT=%ERRORLEVEL%"
echo Logs: ..\临时文件\fund-trade-web\logs\publish-*.log
pause >nul
exit /b %RESULT%
