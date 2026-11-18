#!/bin/sh
# Stops the Keiko that "Start Keiko" started.
here=$(cd "$(dirname "$0")" && pwd) || exit 1
"$here/system/node/bin/node" "$here/system/keiko-npm.mjs" stop
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
