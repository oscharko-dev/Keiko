#!/bin/sh
# Starts Keiko from this folder. Nothing is installed on this computer: Keiko runs with the
# Node.js runtime inside "system" and keeps its data in the ".keiko-standalone" folder of your
# user account.
here=$(cd "$(dirname "$0")" && pwd) || exit 1
payload="$here/system/Keiko"
resources="$payload/Keiko.app/Contents/Resources"
node="$resources/runtime/node/bin/node"
cli="$resources/app/dist/cli/index.js"
state="${KEIKO_STATE_DIR:-$HOME/.keiko-standalone}"

if [ ! -x "$node" ] || [ ! -f "$cli" ]; then
  echo "Keiko is incomplete: files are missing in the folder \"system\"."
  echo "Copy the whole Keiko folder again and start it from there."
  echo "Keiko ist unvollstaendig: Im Ordner \"system\" fehlen Dateien."
  echo "Kopiere den ganzen Keiko-Ordner noch einmal und starte ihn von dort."
  exit 1
fi

# In place: Keiko checks the folder and starts from it. Nothing is copied or registered, and the
# app offers neither a setup nor an update of its own; a new version arrives as a new folder.
set -- portable launch --in-place --portable-root "$payload" --state-dir "$state"
if [ -f "$here/keiko.config.json" ]; then
  set -- "$@" --provisioned-config "$here/keiko.config.json"
fi
"$node" "$cli" "$@"
status=$?
echo
if [ "$status" -ne 0 ]; then
  echo "Keiko could not start. Read the message above, then start Keiko again."
  echo "Keiko konnte nicht starten. Lies die Meldung oben und starte Keiko dann erneut."
else
  echo "Keiko is running in your browser. You can close this window."
  echo "Keiko laeuft in deinem Browser. Du kannst dieses Fenster schliessen."
fi
exit "$status"
