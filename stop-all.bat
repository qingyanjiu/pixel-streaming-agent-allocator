@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0"
set "ALLOCATOR_CONFIG=%ROOT_DIR%Allocator\allocator.json"
set "WORKERS_FILE=%ROOT_DIR%Allocator\config\workers.json"
set "DRY_RUN="

if /I "%~1"=="--what-if" set "DRY_RUN=-DryRun"

if /I not "%~1"=="--force" if /I not "%~1"=="--what-if" (
    echo ============================================================
    echo WARNING: This will stop:
    echo   - All Worker Agents listed in Allocator\config\workers.json
    echo   - All UE and Wilbur instances managed by those Workers
    echo   - The local Allocator
    echo ============================================================
    set /p "CONFIRM=Type YES to continue: "
    if /I not "!CONFIRM!"=="YES" (
        echo [stop-all] Cancelled.
        exit /b 1
    )
)

powershell.exe -NoProfile -ExecutionPolicy Bypass ^
  -File "%ROOT_DIR%scripts\stop-all-services.ps1" ^
  -AllocatorConfig "%ALLOCATOR_CONFIG%" ^
  -WorkersFile "%WORKERS_FILE%" ^
  %DRY_RUN%

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] One or more services could not be stopped.
    pause
)
exit /b %EXIT_CODE%
