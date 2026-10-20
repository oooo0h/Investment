@echo off
setlocal
cd /d "%~dp0"
set "FUND_WEB_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%FUND_WEB_NODE%" goto bundled
node scripts/serve.mjs
goto finished
:bundled
"%FUND_WEB_NODE%" scripts/serve.mjs
:finished
set "FUND_WEB_EXIT=%ERRORLEVEL%"
if not "%FUND_WEB_EXIT%"=="0" pause
exit /b %FUND_WEB_EXIT%
