@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js, then run this file again.
  pause
  exit /b 1
)
rem NodeCut setup: uses the installed Node.js runtime directly.
node "%~dp0scripts\install.mjs" setup %*
set "NODECUT_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %NODECUT_EXIT%
