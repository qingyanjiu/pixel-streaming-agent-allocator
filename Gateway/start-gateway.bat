@echo off
chcp 65001 >nul
setlocal

set "SERVICE_DIR=%~dp0"
set "CONFIG_FILE="
set "WORKER_CONFIG_FILE="
set "NODE_EXE="

if "%~1"=="" (
    set "CONFIG_FILE=%SERVICE_DIR%gateway.json"
) else if exist "%~1" (
    set "CONFIG_FILE=%~f1"
) else if exist "%SERVICE_DIR%%~1" (
    set "CONFIG_FILE=%SERVICE_DIR%%~1"
) else (
    echo [ERROR] Gateway config not found: %~1
    exit /b 1
)

if not "%~2"=="" (
    if exist "%~2" (
        set "WORKER_CONFIG_FILE=%~f2"
    ) else if exist "%SERVICE_DIR%%~2" (
        set "WORKER_CONFIG_FILE=%SERVICE_DIR%%~2"
    ) else (
        echo [ERROR] Worker config not found: %~2
        exit /b 1
    )
)

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SERVICE_DIR%common\resolve-node.ps1" -ConfigPath "%CONFIG_FILE%"`) do (
    set "NODE_EXE=%%I"
)

if not defined NODE_EXE (
    echo [ERROR] Node.js was not found. Set PS_NODE_EXE or configure nodeExecutable.
    exit /b 1
)

echo [Pixel Streaming] Gateway config: %CONFIG_FILE%
echo [Pixel Streaming] Node.js:        %NODE_EXE%
if defined WORKER_CONFIG_FILE echo [Pixel Streaming] Worker config:  %WORKER_CONFIG_FILE%

pushd "%SERVICE_DIR%"
if defined WORKER_CONFIG_FILE (
    "%NODE_EXE%" "%SERVICE_DIR%gateway.js" --config "%CONFIG_FILE%" --worker-config "%WORKER_CONFIG_FILE%"
) else (
    "%NODE_EXE%" "%SERVICE_DIR%gateway.js" --config "%CONFIG_FILE%"
)
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Gateway exited with code %EXIT_CODE%.
    pause
)
exit /b %EXIT_CODE%
