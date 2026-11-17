@echo off
rem Stops the Keiko that was started from this folder.
rem No parenthesized blocks: a folder name such as "Keiko (1)" would end a block early.
setlocal
title Keiko
set "KEIKO_FOLDER=%~dp0"
set "KEIKO_PAYLOAD=%KEIKO_FOLDER%system\Keiko"
set "KEIKO_NODE=%KEIKO_PAYLOAD%\runtime\node\node.exe"
set "KEIKO_CLI=%KEIKO_PAYLOAD%\app\dist\cli\index.js"
if not defined KEIKO_STATE_DIR set "KEIKO_STATE_DIR=%USERPROFILE%\.keiko-standalone"

if not exist "%KEIKO_NODE%" goto incomplete
if not exist "%KEIKO_CLI%" goto incomplete

"%KEIKO_NODE%" "%KEIKO_CLI%" stop --state-dir "%KEIKO_STATE_DIR%"
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Keiko could not be stopped. Read the message above.
echo Keiko konnte nicht beendet werden. Lies die Meldung oben.
pause
exit /b 1

:incomplete
echo Keiko is incomplete: files are missing in the folder "system".
echo Keiko ist unvollstaendig: Im Ordner "system" fehlen Dateien.
pause
exit /b 1
