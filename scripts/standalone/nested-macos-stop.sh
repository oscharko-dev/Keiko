#!/bin/sh
# Stops the Keiko that was started from this folder.
here=$(cd "$(dirname "$0")" && pwd) || exit 1
node="$here/node/bin/node"
cli="$here/system/Keiko/Keiko.app/Contents/Resources/app/dist/cli/index.js"
state="${KEIKO_STATE_DIR:-$HOME/.keiko-standalone}"

if [ ! -x "$node" ]; then
  echo "Keiko is incomplete: the folder \"node\" is missing."
  echo "Keiko ist unvollstaendig: Der Ordner \"node\" fehlt."
  exit 1
fi
# Never unpacked: Keiko was never started from this folder, so there is nothing to stop.
if [ ! -f "$cli" ]; then
  echo "Keiko was not started from this folder. There is nothing to stop."
  echo "Keiko wurde aus diesem Ordner nicht gestartet. Es gibt nichts zu beenden."
  exit 0
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
