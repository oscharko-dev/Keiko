# Keiko

Deutsch weiter unten.

This folder holds everything Keiko needs, including its own Node.js. Nothing is installed on your
computer and nothing is downloaded.

| File                    | What it is                                                 |
| ----------------------- | ---------------------------------------------------------- |
| `start.sh`, `start.cmd` | Starts Keiko (`start.sh` on macOS, `start.cmd` on Windows) |
| `stop.sh`, `stop.cmd`   | Stops Keiko                                                |
| `node/`                 | The Node.js runtime Keiko runs with                        |
| `Keiko.zip`             | Keiko itself; the start file unpacks it into `system/`     |
| `Keiko.zip.sha256`      | The checksum the start file checks `Keiko.zip` against     |
| `package.json`          | The Keiko and Node.js versions in this folder              |
| `package-lock.json`     | Pins `package.json`; this folder has no npm dependencies   |
| `.npmrc`                | Keeps npm offline for this folder                          |
| `keiko.config.json`     | Only in an administrator's package: the team's gateway     |

## Start

- **Windows:** double-click `start.cmd`.
- **macOS:** open Terminal in this folder and run `sh start.sh`.

The first start checks `Keiko.zip` and unpacks it into `system/`; that takes a moment. Later starts
use `system/` directly. As soon as Keiko is ready, it opens in your browser.

Before your first chat after each start, open Settings > Models and click "Activate" on the model
you want, or "Activate all" if it is offered.

## Stop

- **Windows:** double-click `stop.cmd`.
- **macOS:** run `sh stop.sh` in this folder.

Closing the browser tab leaves Keiko running.

## Good to know

- Put this folder on your own computer, for example in Documents. Do not start it from a network
  drive. The folder must be writable: the first start creates `system/` in it.
- Do not open or change `system/`, `node/` or `Keiko.zip`.
- Your chats and settings live in the `.keiko-standalone` folder in your user folder, not here. They
  stay when you replace this folder with a newer one.
- A new version arrives as a new folder. Stop Keiko, delete the old folder and use the new one.

---

# Keiko (Deutsch)

In diesem Ordner ist alles, was Keiko braucht, auch sein eigenes Node.js. Auf deinem Computer wird
nichts installiert und nichts heruntergeladen.

| Datei                   | Was sie ist                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `start.sh`, `start.cmd` | Startet Keiko (`start.sh` unter macOS, `start.cmd` unter Windows) |
| `stop.sh`, `stop.cmd`   | Beendet Keiko                                                     |
| `node/`                 | Das Node.js, mit dem Keiko läuft                                  |
| `Keiko.zip`             | Keiko selbst; die Startdatei entpackt es nach `system/`           |
| `Keiko.zip.sha256`      | Die Prüfsumme, gegen die die Startdatei `Keiko.zip` prüft         |
| `package.json`          | Die Keiko- und Node.js-Version in diesem Ordner                   |
| `package-lock.json`     | Hält `package.json` fest; der Ordner hat keine npm-Abhängigkeiten |
| `.npmrc`                | Hält npm für diesen Ordner offline                                |
| `keiko.config.json`     | Nur im Paket deines Administrators: das Gateway deines Teams      |

## Starten

- **Windows:** Doppelklick auf `start.cmd`.
- **macOS:** Terminal in diesem Ordner öffnen und `sh start.sh` ausführen.

Der erste Start prüft `Keiko.zip` und entpackt es nach `system/`; das dauert einen Moment. Spätere
Starts nehmen `system/` direkt. Sobald Keiko bereit ist, öffnet es sich in deinem Browser.

Öffne vor deinem ersten Chat nach jedem Start Einstellungen > Modelle und klicke beim gewünschten
Modell auf "Aktivieren" oder, falls angezeigt, auf "Alle aktivieren".

## Beenden

- **Windows:** Doppelklick auf `stop.cmd`.
- **macOS:** `sh stop.sh` in diesem Ordner ausführen.

Wenn du nur den Browser-Tab schließt, läuft Keiko weiter.

## Gut zu wissen

- Lege diesen Ordner auf deinen eigenen Computer, zum Beispiel in Dokumente. Starte ihn nicht von
  einem Netzlaufwerk. Der Ordner muss beschreibbar sein: Der erste Start legt darin `system/` an.
- Öffne oder ändere nichts in `system/`, `node/` und `Keiko.zip`.
- Deine Chats und Einstellungen liegen im Ordner `.keiko-standalone` in deinem Benutzerordner, nicht
  hier. Sie bleiben erhalten, wenn du diesen Ordner durch einen neueren ersetzt.
- Eine neue Version kommt als neuer Ordner. Beende Keiko, lösche den alten Ordner und nimm den
  neuen.
