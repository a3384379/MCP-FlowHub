@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "%~dp0scripts\build-windows.ps1"
set "FLOWHUB_BUILD_EXIT=%ERRORLEVEL%"
echo.
echo Build-Windows exit code: %FLOWHUB_BUILD_EXIT%
if /I not "%~1"=="--no-pause" pause
exit /b %FLOWHUB_BUILD_EXIT%
