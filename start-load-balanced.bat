@echo off
REM Script to start multiple Connect server instances for load balancing on Windows
REM Usage: start-load-balanced.bat [number_of_instances]

setlocal enabledelayedexpansion

set NUM_INSTANCES=%1
if "%NUM_INSTANCES%"=="" set NUM_INSTANCES=4
set START_PORT=4000

echo Starting %NUM_INSTANCES% Connect server instances...

REM Create logs directory
if not exist logs mkdir logs

REM Start instances
for /L %%i in (0,1,%NUM_INSTANCES%-1) do (
    set /a PORT=%START_PORT% + %%i
    echo Starting instance on port !PORT!...
    start "Connect Server !PORT!" cmd /k "set PORT=!PORT! && node index.js"
)

echo.
echo All instances started in separate windows.
echo Close the windows to stop the instances.
