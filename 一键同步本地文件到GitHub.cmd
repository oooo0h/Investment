@echo off
chcp 65001 >nul
setlocal
title 本地文件同步到 GitHub
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"
set "PYTHONDONTWRITEBYTECODE=1"
set "GITHUB_SYNC_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%GITHUB_SYNC_PYTHON%" goto run
where python >nul 2>nul
if errorlevel 1 goto missing_python
set "GITHUB_SYNC_PYTHON=python"
:run
"%GITHUB_SYNC_PYTHON%" -X utf8 -u -B "%~dp0工具脚本\github_sync.py" %*
set "GITHUB_SYNC_RESULT=%ERRORLEVEL%"
goto finish
:missing_python
echo 未找到 Python 运行环境，本次同步无法启动。
set "GITHUB_SYNC_RESULT=1"
:finish
echo.
echo 本次操作已结束，请以上方最终结果为准。
if /I "%~1"=="--no-pause" goto done
if "%GITHUB_SYNC_NO_PAUSE%"=="1" goto done
echo 按任意键关闭此窗口……
pause >nul
:done
exit /b %GITHUB_SYNC_RESULT%
