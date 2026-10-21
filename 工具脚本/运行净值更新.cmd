@echo off
chcp 65001 >nul
setlocal
set "PYTHONIOENCODING=utf-8"
set "PYTHONDONTWRITEBYTECODE=1"
if defined FUND_NAV_PYTHON (
  set "NAV_PYTHON=%FUND_NAV_PYTHON%"
  goto run
)
set "NAV_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%NAV_PYTHON%" goto run
where python >nul 2>nul
if errorlevel 1 (
  echo 未找到Python运行环境，任务无法启动。
  exit /b 1
)
set "NAV_PYTHON=python"
:run
"%NAV_PYTHON%" -X utf8 -B "%~dp0nav_update.py" %*
exit /b %errorlevel%
