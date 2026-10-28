@echo off
chcp 65001 >nul
setlocal

set "SERVICE_DIR=%~dp0"
set "CONFIG_FILE=%SERVICE_DIR%allocator.json"
set "NODE_EXE="

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SERVICE_DIR%common\resolve-node.ps1" -ConfigPath "%CONFIG_FILE%"`) do (
    set "NODE_EXE=%%I"
)

if not defined NODE_EXE (
    echo [ERROR] Node.js was not found. Set PS_NODE_EXE or configure nodeExecutable.
    exit /b 1
)

pushd "%SERVICE_DIR%"
"%NODE_EXE%" "%SERVICE_DIR%allocator.js" --config "%CONFIG_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Allocator exited with code %EXIT_CODE%.
    pause
)
exit /b %EXIT_CODE%
