@echo off
chcp 65001 >nul
setlocal

set "ORCHESTRATOR_DIR=%~dp0"
set "CONFIG_FILE="
set "NODE_EXE="

if "%~1"=="" (
    echo Usage: start-worker.bat ^<worker-config.json^>
    echo Example: start-worker.bat worker-01.json
    echo Config files are searched in "%ORCHESTRATOR_DIR%agent" first.
    exit /b 1
)

if exist "%~1" (
    set "CONFIG_FILE=%~f1"
)

if not defined CONFIG_FILE if exist "%ORCHESTRATOR_DIR%agent\%~1" (
    set "CONFIG_FILE=%ORCHESTRATOR_DIR%agent\%~1"
)

if not defined CONFIG_FILE if exist "%ORCHESTRATOR_DIR%agent\%~1.json" (
    set "CONFIG_FILE=%ORCHESTRATOR_DIR%agent\%~1.json"
)

if not defined CONFIG_FILE (
    echo [ERROR] Worker config not found: %~1
    echo Looked in the current directory and "%ORCHESTRATOR_DIR%agent".
    exit /b 1
)

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ORCHESTRATOR_DIR%common\resolve-node.ps1" -ConfigPath "%CONFIG_FILE%"`) do (
    set "NODE_EXE=%%I"
)

if not defined NODE_EXE (
    echo [ERROR] Node.js was not found. Set PS_NODE_EXE or configure nodeExecutable.
    exit /b 1
)

echo [Pixel Streaming] Worker config: %CONFIG_FILE%
echo [Pixel Streaming] Node.js:      %NODE_EXE%

pushd "%ORCHESTRATOR_DIR%"
"%NODE_EXE%" "%ORCHESTRATOR_DIR%agent\worker-agent.js" --config "%CONFIG_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Worker Agent exited with code %EXIT_CODE%.
    pause
)
exit /b %EXIT_CODE%
