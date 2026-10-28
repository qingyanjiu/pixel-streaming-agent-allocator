@echo off
chcp 65001 >nul
setlocal

set "SERVICE_DIR=%~dp0"
set "CONFIG_FILE=worker01.json"
if not "%~1"=="" set "CONFIG_FILE=%~1"

powershell.exe -NoProfile -ExecutionPolicy Bypass ^
  -File "%SERVICE_DIR%stop-slot.ps1" ^
  -ConfigPath "%CONFIG_FILE%" ^
  -All

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Failed to stop all slots.
    pause
)
exit /b %EXIT_CODE%
