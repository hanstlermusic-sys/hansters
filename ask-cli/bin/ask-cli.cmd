@ECHO OFF
SETLOCAL
set "_script=%~dp0ask-cli.ps1"
REM pwsh 7 arranca notablemente mas rapido que Windows PowerShell 5.1.
where pwsh >NUL 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%_script%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%_script%" %*
)
EXIT /B %ERRORLEVEL%
