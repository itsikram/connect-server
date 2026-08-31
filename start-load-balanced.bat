@echo off
REM Start the CPU load balancer plus API backends.
REM Usage: start-load-balanced.bat [number_of_backends]
REM Clients keep calling http://localhost:4000

cd /d "%~dp0"
node load-balancer/start-cluster.js %1
