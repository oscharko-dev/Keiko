#!/bin/sh
# Starts Keiko from this folder with the Node.js runtime inside "system". The first start loads
# Keiko from the npm registry into this folder; Keiko keeps its data in the ".keiko-standalone"
# folder of your user account.
here=$(cd "$(dirname "$0")" && pwd) || exit 1
node="$here/system/node/bin/node"
script="$here/system/keiko-npm.mjs"

if [ ! -x "$node" ] || [ ! -f "$script" ]; then
  echo "Keiko is incomplete: files are missing in the folder \"system\"."
  echo "Copy the whole Keiko folder again and start it from there."
  echo "Keiko ist unvollstaendig: Im Ordner \"system\" fehlen Dateien."
  echo "Kopiere den ganzen Keiko-Ordner noch einmal und starte ihn von dort."
  exit 1
fi

# The launcher says how the start ended: Keiko open, loaded by another start of this folder, or
# stopped while it was being loaded.
"$node" "$script" start
status=$?
if [ "$status" -ne 0 ]; then
  echo
  echo "Keiko could not start. Read the message above, then start Keiko again."
  echo "Keiko konnte nicht starten. Lies die Meldung oben und starte Keiko dann erneut."
fi
exit "$status"
