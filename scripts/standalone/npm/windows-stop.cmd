@echo off
rem Stops the Keiko that "Start Keiko" started.
rem No parenthesized blocks: a folder name such as "Keiko (1)" would end a block early.
setlocal
title Keiko
set "KEIKO_FOLDER=%~dp0"
"%KEIKO_FOLDER%system\node\node.exe" "%KEIKO_FOLDER%system\keiko-npm.mjs" stop
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Keiko could not be stopped. Read the message above.
echo Keiko konnte nicht beendet werden. Lies die Meldung oben.
pause
exit /b 1
