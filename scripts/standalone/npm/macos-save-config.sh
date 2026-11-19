#!/bin/sh
# For the administrator: saves the gateway access that Gateway Setup verified on this computer into
# keiko.config.json next to "Start Keiko", so that nobody who starts this folder has to enter it.
here=$(cd "$(dirname "$0")/.." && pwd) || exit 1
"$here/system/node/bin/node" "$here/system/keiko-npm.mjs" save-config
status=$?
echo
echo "You can close this window. / Du kannst dieses Fenster schliessen."
exit "$status"
