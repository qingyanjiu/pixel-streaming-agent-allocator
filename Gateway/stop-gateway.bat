@echo off
chcp 65001 >nul
setlocal

set "CONFIG_FILE=%~dp0gateway.json"
if not "%~1"=="" (
    if exist "%~1" (
        set "CONFIG_FILE=%~f1"
    ) else (
        set "CONFIG_FILE=%~dp0%~1"
    )
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-gateway.ps1" -ConfigFile "%CONFIG_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Gateway could not be stopped.
    pause
)
exit /b %EXIT_CODE%
