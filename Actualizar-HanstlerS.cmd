@echo off
title Actualizar HanstlerS
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-local.ps1"
echo.
pause