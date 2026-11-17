#!/bin/sh
# Stops the Keiko that was started from this folder.
here=$(cd "$(dirname "$0")" && pwd) || exit 1
resources="$here/system/Keiko/Keiko.app/Contents/Resources"
node="$resources/runtime/node/bin/node"
cli="$resources/app/dist/cli/index.js"
state="${KEIKO_STATE_DIR:-$HOME/.keiko-standalone}"

if [ ! -x "$node" ] || [ ! -f "$cli" ]; then
  echo "Keiko is incomplete: files are missing in the folder \"system\"."
  echo "Keiko ist unvollstaendig: Im Ordner \"system\" fehlen Dateien."
  exit 1
fi

"$node" "$cli" stop --state-dir "$state"
status=$?
echo
if [ "$status" -ne 0 ]; then
  echo "Keiko could not be stopped. Read the message above."
  echo "Keiko konnte nicht beendet werden. Lies die Meldung oben."
else
  echo "Keiko is stopped. You can close this window."
  echo "Keiko ist beendet. Du kannst dieses Fenster schliessen."
fi
exit "$status"
