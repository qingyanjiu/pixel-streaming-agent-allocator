@echo off
chcp 65001 >nul
setlocal

set "SERVICE_DIR=%~dp0"

if "%~1"=="" (
    echo Usage: stop-slot.bat ^<slotId^> [worker-config.json]
    echo Example: stop-slot.bat slot01
    echo Example: stop-slot.bat slot01 worker02.json
    exit /b 1
)

set "SLOT_ID=%~1"
set "CONFIG_FILE=worker01.json"
if not "%~2"=="" set "CONFIG_FILE=%~2"

powershell.exe -NoProfile -ExecutionPolicy Bypass ^
  -File "%SERVICE_DIR%stop-slot.ps1" ^
  -ConfigPath "%CONFIG_FILE%" ^
  -SlotId "%SLOT_ID%"

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Failed to stop slot %SLOT_ID%.
    pause
)
exit /b %EXIT_CODE%
