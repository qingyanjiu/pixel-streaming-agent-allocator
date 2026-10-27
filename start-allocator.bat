@echo off
chcp 65001 >nul
setlocal

set "ORCHESTRATOR_DIR=%~dp0"
set "CONFIG_FILE=%ORCHESTRATOR_DIR%allocator\allocator.json"
set "NODE_EXE="

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ORCHESTRATOR_DIR%common\resolve-node.ps1" -ConfigPath "%CONFIG_FILE%"`) do (
    set "NODE_EXE=%%I"
)

if not defined NODE_EXE (
    echo [ERROR] Node.js was not found. Set PS_NODE_EXE or configure nodeExecutable.
    exit /b 1
)

pushd "%ORCHESTRATOR_DIR%"
"%NODE_EXE%" "%ORCHESTRATOR_DIR%allocator\allocator.js" --config "%CONFIG_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Allocator exited with code %EXIT_CODE%.
    pause
)
exit /b %EXIT_CODE%
