@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" %*
set "FUND_WEB_EXIT=%ERRORLEVEL%"
if not "%FUND_WEB_EXIT%"=="0" pause
exit /b %FUND_WEB_EXIT%
