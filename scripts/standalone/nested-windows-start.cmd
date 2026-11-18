@echo off
rem Starts Keiko from this folder. Nothing is installed on this computer: on the first start this
rem file checks Keiko.zip and unpacks it into "system"; Keiko then runs with the Node.js runtime in
rem "node" and keeps its data in the ".keiko-standalone" folder of your user account.
rem No parenthesized blocks: a folder name such as "Keiko (1)" would end a block early.
setlocal
title Keiko
set "KEIKO_FOLDER=%~dp0"
set "KEIKO_NODE=%KEIKO_FOLDER%node\node.exe"
set "KEIKO_ARCHIVE=%KEIKO_FOLDER%Keiko.zip"
set "KEIKO_ARCHIVE_SUM=%KEIKO_FOLDER%Keiko.zip.sha256"
set "KEIKO_SYSTEM=%KEIKO_FOLDER%system"
set "KEIKO_PARTIAL=%KEIKO_FOLDER%system.partial"
set "KEIKO_STAMP=%KEIKO_SYSTEM%\Keiko.zip.sha256"
set "KEIKO_PAYLOAD=%KEIKO_SYSTEM%\Keiko"
set "KEIKO_CLI=%KEIKO_PAYLOAD%\app\dist\cli\index.js"
if not defined KEIKO_STATE_DIR set "KEIKO_STATE_DIR=%USERPROFILE%\.keiko-standalone"

if not exist "%KEIKO_NODE%" goto incomplete
if not exist "%KEIKO_ARCHIVE%" goto incomplete
if not exist "%KEIKO_ARCHIVE_SUM%" goto incomplete

rem A "system" folder unpacked from this very Keiko.zip is used as it is.
if not exist "%KEIKO_CLI%" goto unpack
if not exist "%KEIKO_STAMP%" goto unpack
fc /b "%KEIKO_STAMP%" "%KEIKO_ARCHIVE_SUM%" >nul 2>nul
if errorlevel 1 goto unpack
goto launch

:unpack
echo Keiko is being unpacked. The first start takes a moment.
echo Keiko wird entpackt. Der erste Start dauert einen Moment.
"%KEIKO_NODE%" -e "const f=require('node:fs'),c=require('node:crypto');const [a,s]=process.argv.slice(1);const e=f.readFileSync(s,'utf8').slice(0,64);const h=c.createHash('sha256').update(f.readFileSync(a)).digest('hex');process.exit(h===e?0:1)" "%KEIKO_ARCHIVE%" "%KEIKO_ARCHIVE_SUM%"
if errorlevel 1 goto damaged
if exist "%KEIKO_PARTIAL%" rmdir /s /q "%KEIKO_PARTIAL%"
mkdir "%KEIKO_PARTIAL%"
if errorlevel 1 goto unpack_failed
"%SystemRoot%\System32\tar.exe" -xf "%KEIKO_ARCHIVE%" -C "%KEIKO_PARTIAL%"
if errorlevel 1 goto unpack_failed
copy /y "%KEIKO_ARCHIVE_SUM%" "%KEIKO_PARTIAL%\Keiko.zip.sha256" >nul
if errorlevel 1 goto unpack_failed
rem The stamp travels with the unpacked folder: "system" is either complete or absent.
if exist "%KEIKO_SYSTEM%" rmdir /s /q "%KEIKO_SYSTEM%"
if exist "%KEIKO_SYSTEM%" goto unpack_failed
ren "%KEIKO_PARTIAL%" system
if errorlevel 1 goto unpack_failed
if not exist "%KEIKO_CLI%" goto unpack_failed

:launch
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

:damaged
echo.
echo Keiko.zip does not match Keiko.zip.sha256: the file is damaged or was changed.
echo Copy the whole Keiko folder again and start it from there.
echo Keiko.zip passt nicht zu Keiko.zip.sha256: Die Datei ist beschaedigt oder wurde veraendert.
echo Kopiere den ganzen Keiko-Ordner noch einmal und starte ihn von dort.
pause
exit /b 1

:unpack_failed
echo.
echo Keiko could not be unpacked. Stop a running Keiko with stop.cmd, make sure the disk has
echo free space, then start Keiko again.
echo Keiko konnte nicht entpackt werden. Beende ein laufendes Keiko mit stop.cmd, sorge fuer
echo freien Speicherplatz und starte Keiko dann erneut.
pause
exit /b 1

:incomplete
echo Keiko is incomplete: node, Keiko.zip or Keiko.zip.sha256 is missing.
echo Copy the whole Keiko folder again and start it from there.
echo Keiko ist unvollstaendig: node, Keiko.zip oder Keiko.zip.sha256 fehlt.
echo Kopiere den ganzen Keiko-Ordner noch einmal und starte ihn von dort.
pause
exit /b 1
