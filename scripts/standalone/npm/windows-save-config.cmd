@echo off
rem For the administrator: saves the gateway access that Gateway Setup verified on this computer into
rem keiko.config.json next to "Start Keiko", so that nobody who starts this folder has to enter it.
setlocal
title Keiko
set "KEIKO_FOLDER=%~dp0..\"
"%KEIKO_FOLDER%system\node\node.exe" "%KEIKO_FOLDER%system\keiko-npm.mjs" save-config
echo.
echo You can close this window. / Du kannst dieses Fenster schliessen.
pause
