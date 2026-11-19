Keiko
=====

In diesem Ordner liegt alles, was Keiko zum Starten braucht. Keiko selbst
kommt beim ersten Start aus der npm-Registry. Auf deinem Computer wird nichts
installiert, und du brauchst keine Administratorrechte.


Starten
-------

macOS:   Doppelklick auf "Start Keiko.command"
Windows: Doppelklick auf "Start Keiko.cmd"

Beim ersten Start lädt Keiko sich aus der npm-Registry in diesen Ordner. Das
kann einige Minuten dauern. Danach öffnet sich Keiko in deinem Browser.

Öffne vor deinem ersten Chat nach jedem Start Einstellungen > Modelle und
klicke beim gewünschten Modell auf "Aktivieren" oder, falls angezeigt, auf
"Alle aktivieren".


Beenden
-------

macOS:   Doppelklick auf "Stop Keiko.command"
Windows: Doppelklick auf "Stop Keiko.cmd"

Wenn du nur den Browser-Tab schließt, läuft Keiko weiter.


Gut zu wissen
-------------

- Lege diesen Ordner auf deinen eigenen Computer, zum Beispiel in Dokumente.
  Starte ihn nicht von einem Netzlaufwerk.
- Deine Chats und Einstellungen liegen im Ordner ".keiko-standalone" in deinem
  Benutzerordner. Sie bleiben erhalten, wenn du diesen Ordner durch einen
  neueren ersetzt.
- Eine neue Version kommt als neuer Ordner. Beende Keiko, lösche den alten
  Ordner und nimm den neuen.
- Unter Windows gibt es in dieser Form keine Coding Workbench. Chat, Knowledge
  Pods, Jira und der Editor funktionieren.


Für Administratoren
-------------------

Registry: Lädt dein Unternehmen npm-Pakete über eine eigene Registry, lege die
Datei ".npmrc" mit dieser Registry neben "Start Keiko". Ohne sie folgt npm der
npm-Einstellung der Person, sonst der öffentlichen npm-Registry. Die Datei "package-lock.json" legt jede Version
und ihre Prüfsumme fest; npm prüft sie bei der Installation. Enthält ".npmrc"
ein Zugangstoken der Registry, ist sie so vertraulich wie "keiko.config.json".

Zugang für alle hinterlegen, damit niemand Gateway-Adresse und Token eingibt:

1. Keiko aus diesem Ordner starten und die Gateway-Einrichtung mit Adresse und
   Token abschließen. Keiko prüft dabei das Gateway und seine Modelle.
2. Keiko beenden.
3. Im Ordner "system" doppelt auf "Zugang speichern.command" (macOS) oder
   "Zugang speichern.cmd" (Windows) klicken und das Token einfügen. Das legt
   "keiko.config.json" neben "Start Keiko".
4. Vor dem Weitergeben den Ordner "node_modules" löschen und den Ordner
   packen. Jeder, der ihn startet, übernimmt den Zugang beim ersten Start.

"keiko.config.json" enthält das Token im Klartext. Gib den Ordner nur an dein
Team weiter, nie öffentlich, und nimm ein eigenes Team-Token mit Budget und
Ablaufdatum.


Wenn Keiko nicht startet
------------------------

- macOS meldet "kann nicht geöffnet werden" oder "kann nicht überprüft werden",
  oder Windows meldet "Der Computer wurde durch Windows geschützt": Diese Kopie
  trägt noch die Markierung eines Internet-Downloads. Nimm den Ordner von dem
  Ort, den dein Administrator genannt hat, oder frage deinen Administrator.
- "Keiko konnte nicht aus der npm-Registry geladen werden": Prüfe die
  Netzwerkverbindung und die Datei ".npmrc", oder frag deinen Administrator.
- Das Fenster meldet, dass Keiko nicht starten konnte: Lies die Meldung im
  Fenster und starte Keiko erneut. Bleibt es dabei, gib die Meldung an deinen
  Administrator weiter.
- Keiko fragt nach einer Gateway-Adresse und einem API-Token: Die hat dein
  Administrator.
