@echo off
rem Starts Keiko from this folder. Nothing is installed on this computer: Keiko runs with the
rem Node.js runtime inside "system" and keeps its data in the ".keiko-standalone" folder of your
rem user account.
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

rem In place: Keiko checks the folder and starts from it. Nothing is copied or registered, and the
rem app offers neither a setup nor an update of its own; a new version arrives as a new folder.
if exist "%KEIKO_FOLDER%keiko.config.json" goto start_provisioned
"%KEIKO_NODE%" "%KEIKO_CLI%" portable launch --in-place --portable-root "%KEIKO_PAYLOAD%" --state-dir "%KEIKO_STATE_DIR%"
goto started

:start_provisioned
"%KEIKO_NODE%" "%KEIKO_CLI%" portable launch --in-place --portable-root "%KEIKO_PAYLOAD%" --state-dir "%KEIKO_STATE_DIR%" --provisioned-config "%KEIKO_FOLDER%keiko.config.json"

:started
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
