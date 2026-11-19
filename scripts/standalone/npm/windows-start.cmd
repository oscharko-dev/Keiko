@echo off
rem Starts Keiko from this folder with the Node.js runtime inside "system". The first start loads
rem Keiko from the npm registry into this folder; Keiko keeps its data in the ".keiko-standalone"
rem folder of your user account.
rem No parenthesized blocks: a folder name such as "Keiko (1)" would end a block early.
setlocal
title Keiko
set "KEIKO_FOLDER=%~dp0"
set "KEIKO_NODE=%KEIKO_FOLDER%system\node\node.exe"
set "KEIKO_SCRIPT=%KEIKO_FOLDER%system\keiko-npm.mjs"

if not exist "%KEIKO_NODE%" goto incomplete
if not exist "%KEIKO_SCRIPT%" goto incomplete

"%KEIKO_NODE%" "%KEIKO_SCRIPT%" start
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Keiko could not start. Read the message above, then start Keiko again.
echo Keiko konnte nicht starten. Lies die Meldung oben und starte Keiko dann erneut.
pause
exit /b 1

:incomplete
echo Keiko is incomplete: files are missing in the folder "system".
echo Copy the whole Keiko folder again and start it from there.
echo Keiko ist unvollstaendig: Im Ordner "system" fehlen Dateien.
echo Kopiere den ganzen Keiko-Ordner noch einmal und starte ihn von dort.
pause
exit /b 1
