@echo off
rem Stops the Keiko that was started from this folder.
rem No parenthesized blocks: a folder name such as "Keiko (1)" would end a block early.
setlocal
title Keiko
set "KEIKO_FOLDER=%~dp0"
set "KEIKO_NODE=%KEIKO_FOLDER%node\node.exe"
set "KEIKO_CLI=%KEIKO_FOLDER%system\Keiko\app\dist\cli\index.js"
if not defined KEIKO_STATE_DIR set "KEIKO_STATE_DIR=%USERPROFILE%\.keiko-standalone"

if not exist "%KEIKO_NODE%" goto incomplete
rem Never unpacked: Keiko was never started from this folder, so there is nothing to stop.
if not exist "%KEIKO_CLI%" goto never_started

"%KEIKO_NODE%" "%KEIKO_CLI%" stop --state-dir "%KEIKO_STATE_DIR%"
if errorlevel 1 goto failed
exit /b 0

:never_started
echo Keiko was not started from this folder. There is nothing to stop.
echo Keiko wurde aus diesem Ordner nicht gestartet. Es gibt nichts zu beenden.
exit /b 0

:failed
echo.
echo Keiko could not be stopped. Read the message above.
echo Keiko konnte nicht beendet werden. Lies die Meldung oben.
pause
exit /b 1

:incomplete
echo Keiko is incomplete: the folder "node" is missing.
echo Keiko ist unvollstaendig: Der Ordner "node" fehlt.
pause
exit /b 1
