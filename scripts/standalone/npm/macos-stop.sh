#!/bin/sh
# Stops the Keiko that "Start Keiko" started.
here=$(cd "$(dirname "$0")" && pwd) || exit 1
# The launcher says how the stop ended: Keiko stopped, not running, or still being loaded.
"$here/system/node/bin/node" "$here/system/keiko-npm.mjs" stop
status=$?
if [ "$status" -ne 0 ]; then
  echo
  echo "Keiko could not be stopped. Read the message above."
  echo "Keiko konnte nicht beendet werden. Lies die Meldung oben."
fi
exit "$status"
