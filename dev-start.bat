@echo off
setlocal

set "ROOT=%~dp0"
set "APPDIR=%ROOT%desktop"

if "%~1"=="--check" goto check

call :check_tools
if errorlevel 1 goto fail

cd /d "%APPDIR%" || goto fail

if not exist "node_modules\.package-lock.json" (
  echo Installing desktop dependencies...
  call npm install
  if errorlevel 1 goto fail
)

set ELECTRON_RUN_AS_NODE=
echo.
echo Starting Prompt Studio Desktop dev...
echo Local API: http://127.0.0.1:8768
echo.
call npm start
exit /b %errorlevel%

:check
call :check_tools
if errorlevel 1 exit /b 1
echo.
echo [OK] dev environment looks ready.
exit /b 0

:check_tools
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not installed or not in PATH.
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  where python3 >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Python 3 is not installed or not in PATH.
    exit /b 1
  )
)

if not exist "%APPDIR%\package.json" (
  echo [ERROR] Missing desktop\package.json.
  exit /b 1
)

exit /b 0

:fail
echo.
echo [ERROR] Failed to start. See messages above.
pause
exit /b 1
