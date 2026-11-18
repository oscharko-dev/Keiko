#!/bin/sh
# Starts Keiko from this folder. Nothing is installed on this computer: on the first start this
# file checks Keiko.zip and unpacks it into "system"; Keiko then runs with the Node.js runtime in
# "node" and keeps its data in the ".keiko-standalone" folder of your user account.
here=$(cd "$(dirname "$0")" && pwd) || exit 1
node="$here/node/bin/node"
archive="$here/Keiko.zip"
archive_sum="$here/Keiko.zip.sha256"
system="$here/system"
partial="$here/system.partial"
payload="$system/Keiko"
cli="$payload/Keiko.app/Contents/Resources/app/dist/cli/index.js"
state="${KEIKO_STATE_DIR:-$HOME/.keiko-standalone}"

if [ ! -x "$node" ] || [ ! -f "$archive" ] || [ ! -f "$archive_sum" ]; then
  echo "Keiko is incomplete: node, Keiko.zip or Keiko.zip.sha256 is missing."
  echo "Copy the whole Keiko folder again and start it from there."
  echo "Keiko ist unvollstaendig: node, Keiko.zip oder Keiko.zip.sha256 fehlt."
  echo "Kopiere den ganzen Keiko-Ordner noch einmal und starte ihn von dort."
  exit 1
fi

unpack_failed() {
  echo
  echo "Keiko could not be unpacked. Stop a running Keiko with stop.sh, make sure the disk has"
  echo "free space, then start Keiko again."
  echo "Keiko konnte nicht entpackt werden. Beende ein laufendes Keiko mit stop.sh, sorge fuer"
  echo "freien Speicherplatz und starte Keiko dann erneut."
  rm -rf "$partial"
  exit 1
}

verify_archive() {
  "$node" -e "const f=require('node:fs'),c=require('node:crypto');const [a,s]=process.argv.slice(1);const e=f.readFileSync(s,'utf8').slice(0,64);const h=c.createHash('sha256').update(f.readFileSync(a)).digest('hex');process.exit(h===e?0:1)" "$archive" "$archive_sum"
}

# The stamp travels with the unpacked folder: "system" is either complete or absent.
unpack() {
  echo "Keiko is being unpacked. The first start takes a moment."
  echo "Keiko wird entpackt. Der erste Start dauert einen Moment."
  if ! verify_archive; then
    echo
    echo "Keiko.zip does not match Keiko.zip.sha256: the file is damaged or was changed."
    echo "Copy the whole Keiko folder again and start it from there."
    echo "Keiko.zip passt nicht zu Keiko.zip.sha256: Die Datei ist beschaedigt oder wurde veraendert."
    echo "Kopiere den ganzen Keiko-Ordner noch einmal und starte ihn von dort."
    exit 1
  fi
  rm -rf "$partial" && mkdir "$partial" || unpack_failed
  /usr/bin/ditto -x -k "$archive" "$partial" || unpack_failed
  cp "$archive_sum" "$partial/Keiko.zip.sha256" || unpack_failed
  rm -rf "$system" || unpack_failed
  mv "$partial" "$system" || unpack_failed
  [ -f "$cli" ] || unpack_failed
}

# A "system" folder unpacked from this very Keiko.zip is used as it is.
if [ ! -f "$cli" ] || ! cmp -s "$system/Keiko.zip.sha256" "$archive_sum"; then
  unpack
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
