@echo off
chcp 65001 >nul
setlocal

set "ROOT_DIR=%~dp0"
set "WORKER_CONFIG=Worker\worker01.json"
set "NO_GATEWAY="
set "NO_BROWSER="
set "DRY_RUN="

for %%A in (%*) do (
    if /I "%%~A"=="--no-gateway" set "NO_GATEWAY=-NoGateway"
    if /I "%%~A"=="--no-browser" set "NO_BROWSER=-NoBrowser"
    if /I "%%~A"=="--what-if" set "DRY_RUN=-DryRun"
    if /I not "%%~A"=="--no-gateway" if /I not "%%~A"=="--no-browser" if /I not "%%~A"=="--what-if" set "WORKER_CONFIG=%%~A"
)

powershell.exe -NoProfile -ExecutionPolicy Bypass ^
  -File "%ROOT_DIR%scripts\start-all-stack.ps1" ^
  -WorkerConfig "%WORKER_CONFIG%" ^
  %NO_GATEWAY% %NO_BROWSER% %DRY_RUN%

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Pixel Streaming stack did not start.
    pause
)
exit /b %EXIT_CODE%
