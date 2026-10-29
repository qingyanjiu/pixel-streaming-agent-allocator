@echo off
chcp 65001 >nul
setlocal

set "SERVICE_DIR=%~dp0"
set "CONFIG_FILE="
set "NODE_EXE="
set "START_GATEWAY=1"
set "GATEWAY_CONFIG="

for %%I in ("%SERVICE_DIR%..\Gateway\gateway.json") do set "GATEWAY_CONFIG=%%~fI"
if defined PS_GATEWAY_CONFIG set "GATEWAY_CONFIG=%PS_GATEWAY_CONFIG%"

if "%~1"=="" (
    echo Usage: start-worker.bat ^<worker-config.json^> [gateway-config.json^|--no-gateway]
    echo Example: start-worker.bat worker01.json
    echo Example: start-worker.bat worker02.json ..\Gateway\gateway-worker02.json
    echo Example: start-worker.bat worker01.json --no-gateway
    echo Config files are searched in "%SERVICE_DIR%" first.
    exit /b 1
)

if /I "%~2"=="--no-gateway" (
    set "START_GATEWAY=0"
) else if not "%~2"=="" (
    if exist "%~2" (
        set "GATEWAY_CONFIG=%~f2"
    ) else if exist "%SERVICE_DIR%..\%~2" (
        for %%I in ("%SERVICE_DIR%..\%~2") do set "GATEWAY_CONFIG=%%~fI"
    ) else (
        echo [ERROR] Gateway config not found: %~2
        exit /b 1
    )
)

if exist "%~1" (
    set "CONFIG_FILE=%~f1"
)

if not defined CONFIG_FILE if exist "%SERVICE_DIR%%~1" (
    set "CONFIG_FILE=%SERVICE_DIR%%~1"
)

if not defined CONFIG_FILE if exist "%SERVICE_DIR%%~1.json" (
    set "CONFIG_FILE=%SERVICE_DIR%%~1.json"
)

if not defined CONFIG_FILE (
    echo [ERROR] Worker config not found: %~1
    echo Looked in the current directory and "%SERVICE_DIR%".
    exit /b 1
)

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SERVICE_DIR%common\resolve-node.ps1" -ConfigPath "%CONFIG_FILE%"`) do (
    set "NODE_EXE=%%I"
)

if not defined NODE_EXE (
    echo [ERROR] Node.js was not found. Set PS_NODE_EXE or configure nodeExecutable.
    exit /b 1
)

echo [Pixel Streaming] Worker config: %CONFIG_FILE%
echo [Pixel Streaming] Node.js:      %NODE_EXE%

if "%START_GATEWAY%"=="1" (
    if not exist "%GATEWAY_CONFIG%" (
        echo [ERROR] Gateway config not found: %GATEWAY_CONFIG%
        echo Set PS_GATEWAY_CONFIG or pass a Gateway config as the second argument.
        exit /b 1
    )
    echo [Pixel Streaming] Gateway config: %GATEWAY_CONFIG%
    echo [Pixel Streaming] Starting Gateway in a separate window...
    start "Pixel Streaming Gateway" cmd.exe /D /K call "%SERVICE_DIR%..\Gateway\start-gateway.bat" "%GATEWAY_CONFIG%" "%CONFIG_FILE%"
) else (
    echo [Pixel Streaming] Gateway autostart disabled.
)

pushd "%SERVICE_DIR%"
"%NODE_EXE%" "%SERVICE_DIR%worker-agent.js" --config "%CONFIG_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Worker Agent exited with code %EXIT_CODE%.
    pause
)
exit /b %EXIT_CODE%
