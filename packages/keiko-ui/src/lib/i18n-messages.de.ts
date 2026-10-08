import type { MessageCatalog } from "./i18n-messages.en";
export const DE_MESSAGES = {
  "editor.taskWorkspaceAccess.checking": "Verbindung zum Aufgabenarbeitsbereich wird hergestellt…",
  "editor.taskWorkspaceAccess.checkingDescription":
    "Keiko prüft, ob dieser Browser auf den lokalen Arbeitsbereich zugreifen kann.",
  "editor.taskWorkspaceAccess.unpairedTitle": "Browsersitzung nicht gekoppelt",
  "editor.taskWorkspaceAccess.unpairedDescription":
    "Das ausgewählte Projekt ist verfügbar, aber dieser Browser hat keine Launcher-Berechtigung für private Task-Workspace-Inhalte. Starte Keiko über den Launcher neu.",
  "editor.taskWorkspaceAccess.title":
    "Der Aufgabenarbeitsbereich ist in diesem Browser nicht verfügbar",
  "editor.taskWorkspaceAccess.description":
    "Starte Keiko über das Startprogramm neu. Alternativ kannst du oben im Arbeitskontext einen Ordner oder ein Repository auswählen.",
  "editor.taskWorkspaceAccess.retry": "Erneut prüfen",
  "editor.multiRoot.label": "Mehrwurzel-Editor",
  "editor.multiRoot.switcher": "Editor-Arbeitsbereichswurzeln",
  "editor.multiRoot.error":
    "Die fokussierte Arbeitsbereichswurzel konnte nicht aktualisiert werden.",

  "app.skipToContent": "Zum Inhalt springen",
  "app.workspaceHeading": "Keiko-Arbeitsbereich",
  "header.tileAll": "Alle Fenster kacheln",
  "header.lockLayout": "Anordnung sperren",
  "header.unlockLayout": "Anordnung entsperren",
  "header.splitFront": "Vordere Fenster teilen",
  "header.cascade": "Fenster stapeln",
  "rail.primaryNavigation": "Primäre Arbeitsbereichsnavigation",
  "rail.newChat": "Neuer Chat",
  "rail.codingHistory": "Coding History",
  "window.type.codingHistory.title": "Coding History",
  "window.type.codingHistory.desc": "Coding-Aufgaben fortsetzen",
  "rail.chatHistory": "Chatverlauf",
  "rail.memoria": "MemoriaViva",
  "rail.quality": "Quality Intelligence",
  "rail.promptEnhancer": "Prompt Enhancer",
  "rail.coding": "Coding Workbench",
  "rail.localKnowledge": "Lokales Wissen",
  "rail.editor": "Editor",
  "editor.empty.opening": "Wird geöffnet…",
  "supportReport.globalFailure": "Keiko hat einen Fehler festgestellt.",
  "supportReport.readinessUnavailable": "Fehlerberichte können derzeit unvollständig sein.",
  "supportReport.create": "Fehlerbericht erstellen",
  "supportReport.creating": "Bericht wird erstellt…",
  "supportReport.download": "Bericht herunterladen",
  "supportReport.expired": "Der Download-Link ist abgelaufen. Bericht erneut erstellen.",
  "supportReport.regenerate": "Bericht erneut erstellen",
  "supportReport.limitedReady": "Eingeschränkter Bericht bereit (Serverdiagnosen fehlen).",
  "supportReport.saved": "Bericht bereit. Lade ihn herunter und sende ihn an den Support.",
  "supportReport.failed": "Bericht nicht verfügbar. Erneut versuchen.",
  "supportReport.sessionDenied": "Bericht in diesem Browser nicht verfügbar. Erneut erstellen.",
  "supportReport.serviceUnavailable":
    "Bericht nicht verfügbar. Prüfen, ob Keiko lokal läuft, dann erneut versuchen.",
  "supportReport.rateLimited": "Bitte eine Minute warten, dann diesen Bericht erneut erstellen.",
  "editor.projectRestricted": "Arbeitsbereichsskripte sind nicht verfügbar.",
  "git.error.moduleLoadFailed":
    "Git konnte nicht geladen werden. Lade Keiko neu und versuche es erneut.",
  "editor.runtime.loadFailed": "Datei konnte nicht geöffnet werden.",
  "editor.runtime.retry": "Erneut versuchen",

  "editor.command.openProblems": "Probleme öffnen",
  "editor.command.openFileHistory": "Dateiverlauf öffnen",
  "editor.command.runFileTests": "Tests für Datei ausführen",
  "editor.command.runTypecheck": "Typprüfung ausführen",
  "editor.command.runLint": "Lint-Prüfung ausführen",
  "editor.command.runBuild": "Build ausführen",
  "editor.command.cancelVerification": "Verifizierung abbrechen",
  "editor.command.trustWorkspaceScripts": "Arbeitsbereichsskripten vertrauen",
  "editor.command.revokeWorkspaceScriptTrust": "Vertrauen in Arbeitsbereichsskripte widerrufen",
  "settings.profiles.reset": "Auf Standard zurücksetzen",
  "settings.profiles.portabilityTitle": "Profilübertragung",
  "settings.profiles.portabilityDescription":
    "Exportiere ein serverseitig bereinigtes Profil oder prüfe jede Einstellung vor dem Import als neues Profil.",
  "settings.profiles.export": "Ausgewähltes Profil exportieren",
  "settings.profiles.importFile": "Profildatei importieren",
  "settings.profiles.switchAfterImport": "Nach Import wechseln",
  "settings.profiles.proposedName": "Neues Profil: {name}",
  "settings.profiles.setting": "Einstellung",
  "settings.profiles.disposition": "Änderung",
  "settings.profiles.value": "Wert oder Grund",
  "settings.profiles.disposition.add": "Hinzufügen",
  "settings.profiles.disposition.change": "Ändern",
  "settings.profiles.disposition.noOp": "Keine Änderung",
  "settings.profiles.disposition.rejected": "Abgelehnt",
  "settings.profiles.applyImport": "Import anwenden",
  "settings.profiles.exported": "Profil exportiert.",
  "settings.profiles.exportedRedacted":
    "Profil mit {count} entfernten unsicheren Werten exportiert.",
  "settings.profiles.imported": "Profil als neues Profil importiert.",
  "settings.profiles.fileTooLarge": "Die Profildatei überschreitet das Importlimit von 64 KiB.",
  "settings.profiles.invalid": "Der Profilimport konnte nicht validiert oder angewendet werden.",
  "settings.profiles.stale": "Profile wurden nach der Vorschau geändert. Prüfe die Datei erneut.",
  "boundRoot.pickerLabel": "{surface}-Root",
  "boundRoot.surface.problems": "Probleme",
  "boundRoot.surface.debug": "Debug",
  "boundRoot.surface.terminal": "Terminal",
  "boundRoot.surface.commands": "Befehle",
  "boundRoot.surface.runtime": "Laufzeit",
  "boundRoot.surface.governedGit": "Git",
  "boundRoot.surface.governedPullRequest": "Pull Request",
  "boundRoot.surface.governedMerge": "Merge",
  "boundRoot.surface.containerStatus": "Container",
  "boundRoot.denied.title": "Arbeitsbereichs-Root wählen",
  "boundRoot.denied.rootBindingRequired":
    "Dieses Fenster arbeitet auf genau einem Arbeitsbereichs-Root, und es wurde keiner gewählt. Der fokussierte Root wird nie automatisch verwendet — wähle oben einen Root, um fortzufahren.",
  "boundRoot.denied.placeholder": "Kein Root gewählt",
  "workspaceTrust.title": "Arbeitsbereichsvertrauen",
  "workspaceTrust.restrictedMode": "Eingeschränkter Modus",
  "workspaceTrust.trustedMode": "Vertrauenswürdiger Arbeitsbereich",
  "workspaceTrust.unavailable": "Arbeitsbereichsvertrauen nicht verfügbar",
  "workspaceTrust.manage": "Arbeitsbereichsvertrauen verwalten",
  "workspaceTrust.loading": "Serverseitigen Vertrauensstatus laden…",
  "workspaceTrust.retry": "Erneut versuchen",
  "workspaceTrust.loadFailed":
    "Das Arbeitsbereichsvertrauen konnte nicht sicher gelesen werden. Ausführungsfunktionen bleiben nicht verfügbar.",
  "workspaceTrust.updateFailed":
    "Der Server hat die Vertrauensänderung nicht bestätigt. Dieser Arbeitsbereich bleibt eingeschränkt.",
  "workspaceTrust.updateFailedTrusted":
    "Der Server hat die Vertrauensänderung nicht bestätigt. Dieser Arbeitsbereich bleibt vertrauenswürdig.",
  "workspaceTrust.errorCode": "Fehlercode: {code}",
  "workspaceTrust.supportId": "Support-ID: {correlationId}",
  "workspaceTrust.banner.editor":
    "Arbeitsbereichsskripte, Sprachserver und Agentenausführung bleiben für diese Wurzel nicht verfügbar.",
  "workspaceTrust.banner.commands":
    "Vom Repository definierte Befehle bleiben deaktiviert, bis dieser Wurzel vertraut wird.",
  "workspaceTrust.banner.languages":
    "Verwaltete Sprachserver bleiben deaktiviert, bis dieser Wurzel vertraut wird.",
  "workspaceTrust.reason.humanGrant":
    "Das Vertrauen wurde ausdrücklich für den aktuellen Arbeitsbereich erteilt.",
  "workspaceTrust.reason.derivedFromTrustedRoot": "Vom freigegebenen Repository abgeleitet.",
  "workspaceTrust.reason.humanRevocation":
    "Das Vertrauen wurde ausdrücklich für diesen Arbeitsbereich widerrufen.",
  "workspaceTrust.reason.identityChanged":
    "Das Vertrauen ist abgelaufen, weil sich die Arbeitsbereichsidentität geändert hat.",
  "workspaceTrust.reason.manifestChanged":
    "Das Vertrauen ist abgelaufen, weil sich das Arbeitsbereichsmanifest geändert hat.",
  "workspaceTrust.reason.trustBasisChanged":
    "Das Vertrauen ist abgelaufen, weil sich das Arbeitsbereichsmanifest geändert hat.",
  "workspaceTrust.reason.policy":
    "Die Bereitstellungsrichtlinie verlangt, dass dieser Arbeitsbereich eingeschränkt bleibt.",
  "workspaceTrust.reason.stateUnavailable":
    "Für diesen Arbeitsbereich ist keine aktuelle servervalidierte Vertrauensfreigabe verfügbar.",
  "workspaceTrust.dialog.grantTitle": "Diesem Arbeitsbereich vertrauen?",
  "workspaceTrust.dialog.grantBody":
    "Vertrauen erlaubt Arbeitsbereichsskripte, Sprachserver und Agentenausführung für diese Wurzel. Vom Repository definierter Code kann mit der von der Richtlinie erlaubten Berechtigung ausgeführt werden.",
  "workspaceTrust.dialog.revokeTitle": "Vertrauen für diesen Arbeitsbereich widerrufen?",
  "workspaceTrust.dialog.revokeBody":
    "Der Widerruf stoppt oder deaktiviert Arbeitsbereichsskripte, Sprachserver und Agentenausführung für diese Wurzel.",
  "workspaceTrust.dialog.serverConfirmed":
    "Keiko ändert Funktionen erst, nachdem der Server die Entscheidung bestätigt hat.",
  "workspaceTrust.dialog.cancel": "Abbrechen",
  "workspaceTrust.dialog.trust": "Arbeitsbereich vertrauen",
  "workspaceTrust.dialog.revoke": "Vertrauen widerrufen",
  "workspaceTrust.dialog.waiting": "Auf Server warten…",
  "workspaceTrust.action.trust": "Vertrauen",
  "workspaceTrust.action.revoke": "Widerrufen",
  "workspaceTrust.management.description":
    "Prüfen Sie jede registrierte Wurzel und treffen Sie eine ausdrückliche Vertrauensentscheidung. Vertrauensentscheidungen werden vom lokalen Server gespeichert und durchgesetzt.",
  "workspaceTrust.management.digestHelp":
    "Eine Freigabe ist an die aktuelle Arbeitsbereichsidentität und das Manifest gebunden. Keiko kehrt in den eingeschränkten Modus zurück, wenn sich eines davon ändert.",
  "workspaceTrust.management.empty": "Keine registrierten Arbeitsbereichswurzeln verfügbar.",
  "workspaceTrust.settings.description":
    "Prüfen oder widerrufen Sie das Ausführungsvertrauen registrierter Arbeitsbereichswurzeln.",
  "workspaceTrust.settings.open": "Arbeitsbereichsvertrauen öffnen",
  "rail.figma": "Figma-Snapshot",
  "rail.lightMode": "Heller Modus",
  "rail.darkMode": "Dunkler Modus",
  "rail.settings": "Einstellungen",
  "common.optional": "optional",
  "common.loading": "Lädt…",
  "window.chunkStalled": "Dieses Fenster wurde nicht fertig geladen.",
  "common.cancel": "Abbrechen",
  "common.retry": "Erneut versuchen",
  "common.dismissError": "Fehler ausblenden",
  "common.status": "Status",
  "common.duration": "Dauer",
  "common.confidence": "Konfidenz",
  "common.save": "Speichern",
  "common.saving": "Speichere…",
  "common.delete": "Löschen",
  "common.continue": "Weiter",
  "common.browse": "Durchsuchen",
  "common.working": "Wird ausgeführt…",
  "common.tryAgain": "Erneut versuchen",
  "common.dismiss": "Ausblenden",
  "common.on": "an",
  "common.off": "aus",
  "common.close": "Schließen",
  "common.advanced": "erweitert",
  "gatewaySetup.loading.title": "Modell-Gateway-Einrichtung wird vorbereitet",
  "gatewaySetup.loading.description":
    "Die lokalen Einrichtungsfelder werden geladen. Es wurde noch keine Anbieteranfrage gestartet.",
  "gatewaySetup.loading.error": "Die Einrichtungsfelder konnten nicht geladen werden.",
  "gatewaySetup.workflowEligibleModels": "Für Coding-Workflows freigegebene Modelle",
  "gatewaySetup.workflowEligibleModelsPlaceholder":
    "Ausdrücklich freigegebene Coding-Modellnamen einfügen, einen pro Zeile",
  "gatewaySetup.unusable.unsupported":
    " Nicht verwendet (vom Gateway deklarierter Modus): {models}.",
  "gatewaySetup.unusable.dropped":
    " Embedding-Prüfung fehlgeschlagen, nicht gespeichert: {models}.",
  "gatewaySetup.unusable.unverified":
    " Übernommen, aber als Embedding-Modell nicht verifiziert: {models}.",
  "gatewaySetup.unusable.unverifiedChat":
    " Übernommen, aber als Chat-Modell nicht verifiziert: {models}.",
  // Der Undo-Stapel der Shell zeichnet ausschließlich Panel-Umschaltungen auf — kein Verschieben,
  // Skalieren, Maximieren oder Schließen von Fenstern erreicht ihn.
  "shell.command.undo.target": "Rückgängig: {target}",
  "shell.command.undo.panelOnly": "Rückgängig (nur Panel-Änderungen)",
  "shell.command.redo.target": "Wiederherstellen: {target}",
  "shell.command.redo.panelOnly": "Wiederherstellen (nur Panel-Änderungen)",
  "workspace.selection.none": "Keine Arbeitsbereichsfenster ausgewählt",
  "workspace.binding.restoreVerificationFailed":
    "Der aktive Task-Workspace hat die erneute Verifizierung nicht bestanden. Binden Sie ihn neu, bevor Sie einen Coding-Lauf starten.",
  "workspace.binding.provisionFailed":
    "Der Task Workspace konnte nicht verifiziert und aktiviert werden. Prüfe das Repository und versuche es erneut.",
  "workspace.binding.repairOperatorRequired":
    "Diese Wiederherstellung braucht zuerst einen Operator. Prüfe den verwalteten Worktree und wiederhole dann die Reparatur.",
  "workspace.selection.one": "1 Arbeitsbereichsfenster ausgewählt",
  "workspace.selection.many": "{count} Arbeitsbereichsfenster ausgewählt",
  "workspace.clipboard.copied.one": "1 Fenster kopiert",
  "workspace.clipboard.copied.many": "{count} Fenster kopiert",
  "workspace.clipboard.cut.one": "1 Fenster ausgeschnitten",
  "workspace.clipboard.cut.many": "{count} Fenster ausgeschnitten",
  "workspace.clipboard.pasted.one": "1 Fenster eingefügt",
  "workspace.clipboard.pasted.many": "{count} Fenster eingefügt",
  "workspace.clipboard.skipped.one": "1 ausgewähltes Fenster übersprungen (nicht duplizierbar)",
  "workspace.clipboard.skipped.many":
    "{count} ausgewählte Fenster übersprungen (nicht duplizierbar)",
  "workspace.clipboard.overflow.one": "1 weiteres Fenster passte nicht in diese Kopie",
  "workspace.clipboard.overflow.many": "{count} weitere Fenster passten nicht in diese Kopie",
  "workspace.clipboard.noSelection": "Wählen Sie zuerst ein oder mehrere Fenster aus",
  "workspace.clipboard.nothingToPaste":
    "Nichts zum Einfügen — kopieren oder schneiden Sie zuerst Fenster aus",
  "workspace.clipboard.workspaceFull": "Der Arbeitsbereich hat keinen Platz für weitere Fenster",
  "workspace.clipboard.noneEligible":
    "Die ausgewählten Fenster können nicht dupliziert werden — Chat- und Einzelinstanz-Fenster sind ausgenommen",
  "workspace.window.selectedLabel": "{label} — ausgewählt",
  "workspace.surface": "Arbeitsbereich",
  "workspace.connectHint": "Klicke ein hervorgehobenes Fenster an - Esc bricht ab",
  "workspace.zoomOut": "Herauszoomen",
  "workspace.zoomIn": "Hineinzoomen",
  "workspace.fitToWindows": "Arbeitsbereich an Fenster anpassen",
  "workspace.zoomReset": "{percent}% - zurücksetzen",
  "workspace.reset": "Zurücksetzen",
  "workspace.newWindow": "Neues Fenster",
  "shell.error.title": "Keiko konnte den Arbeitsbereich nicht öffnen",
  "shell.error.body":
    "Der Desktop ist beim Rendern fehlgeschlagen, daher konnte nichts angezeigt werden. Deine Projekte, Chats und Dateien sind unverändert.",
  "shell.error.hint":
    "Meist liegt es an einer gespeicherten Tastenkürzel-Anpassung, die bei jedem Start erneut angewendet wird. Setze die gespeicherten Tastenkürzel zurück, um sie zu entfernen, oder lade neu, wenn der Fehler einmalig war.",
  "shell.error.resetShortcuts": "Gespeicherte Tastenkürzel zurücksetzen und neu laden",
  "shell.error.reload": "Keiko neu laden",
  "shell.error.resetFailed":
    "Die gespeicherten Tastenkürzel konnten nicht zurückgesetzt werden. Lade neu, um es erneut zu versuchen, oder bearbeite die gespeicherten Einstellungen außerhalb von Keiko.",
  "window.error.title": "Fenster konnte nicht geladen werden.",
  "window.error.body": "Bitte erneut versuchen.",
  "window.tooSmall.title": "Zu klein für {label}",
  "window.tooSmall.body": "Vergrößere das Fenster oder zoome den Inhalt heraus",
  "window.connectPort.title": "Mit einem anderen Fenster verbinden",
  "window.connectPort.aria": "{title} über die {edge}-Kante verbinden",
  "window.edge.top": "obere",
  "window.edge.right": "rechte",
  "window.edge.bottom": "untere",
  "window.edge.left": "linke",
  // Issue: German locale coverage. Window-type display copy lives HERE, not as literals in
  // WindowsRegistry.ts — the launcher grid, the New Window dialog, the workspace command list
  // and the window chrome all resolve it through `localizedWindowTitle`/`localizedWindowDesc`, so
  // one locale switch moves every surface instead of leaving an English name behind.
  "window.type.chat.title": "Chat",
  "window.type.chat.desc": "Mit Keiko sprechen",
  "window.type.chatHistory.title": "Chatverlauf",
  "window.type.chatHistory.desc": "Konversationen verwalten",
  "window.type.memoria.title": "MemoriaViva",
  "window.type.memoria.desc": "Kontrollierten Speicher prüfen",
  "window.type.files.title": "Dateien",
  "window.type.files.desc": "Ordner durchsuchen",
  "window.type.editor.title": "Editor",
  "window.type.editor.desc": "Ordner oder Datei öffnen",
  "window.type.browser.title": "Browser",
  "window.type.browser.desc": "URL öffnen",
  "window.type.docbrowser.title": "Dokumentations-Browser",
  "window.type.docbrowser.desc": "Lokales oder Intranet-HTML-Handbuch ansehen",
  "window.type.terminal.title": "Terminal",
  "window.type.terminal.desc": "Befehle ausführen",
  "window.type.commands.title": "Aufgaben",
  "window.type.commands.desc": "Test-, Build- und Run-Aufgaben ausführen",
  "window.type.runtime.title": "Laufzeit",
  "window.type.runtime.desc": "Laufzeit, Git, Aufgaben und Audit",
  "window.type.coding.title": "Coding Workbench",
  "window.type.coding.desc": "Coding-Agenten steuern",
  "window.type.containerStatus.title": "Container",
  "window.type.containerStatus.desc": "Status und Diagnose der Container-Engine",
  "window.type.review.title": "Review",
  "window.type.review.desc": "Vorgeschlagenes Diff prüfen",
  "window.type.agents.title": "Agenten",
  "window.type.agents.desc": "Coding-Agent auswählen",
  "window.type.integ.title": "Connector-Verwaltung",
  "window.type.integ.desc": "Serververwaltete Connectoren, Bereiche, Sync und Freigaben verwalten",
  "window.type.settings.title": "Einstellungen",
  "window.type.settings.desc": "Voreinstellungen",
  "window.type.workspaceTrust.title": "Workspace Trust",
  "window.type.workspaceTrust.desc": "Restricted Mode pro Arbeitsbereich verwalten",
  "window.type.updates.title": "Updates",
  "window.type.updates.desc": "Verfügbare Updates prüfen",
  "window.type.project.title": "Projekt",
  "window.type.project.desc": "Projektbaum",
  "window.type.search.title": "Suche",
  "window.type.search.desc": "Arbeitsbereich durchsuchen",
  "window.type.plugins.title": "Plug-ins",
  "window.type.plugins.desc": "Plug-ins und Werkzeuge",
  "window.type.automations.title": "Automatisierungen",
  "window.type.automations.desc": "Workflow-Automatisierungen",
  "window.type.mobile.title": "Keiko Mobile",
  "window.type.mobile.desc": "Mobiler Begleiter",
  "mobile.previewNotice": "Vorschau — Kopplung noch nicht verdrahtet",
  "mobile.subtitle": "Mobiler Begleiter — noch nicht verfügbar.",

  "window.type.inspector.title": "Inspektor",
  "window.type.inspector.desc": "Arbeitsbereich inspizieren",
  "window.type.activity.title": "Aktivität",
  "window.type.activity.desc": "Aktivitätsverlauf",
  "activity.timeline.label": "Aktivitätsverlauf",
  "activity.empty.title": "Noch keine Aktivität.",
  "activity.empty.description":
    "Starte eine Coding-Aufgabe, um ihre Runtime-Ereignisse hier zu sehen.",
  "activity.actor.workspace": "Arbeitsbereich",
  "activity.event.unknown": "Runtime-Aktivität",
  "activity.event.runtimeStarted": "Runtime gestartet",
  "activity.event.runtimeStopped": "Runtime angehalten",
  "activity.event.runtimeHealth": "Runtime-Zustand geändert",
  "activity.event.taskSubmitted": "Aufgabe übermittelt",
  "activity.event.observationStreamed": "Runtime-Beobachtung empfangen",
  "activity.event.permissionRequested": "Freigabe angefordert",
  "activity.event.diffSummarized": "Diff-Zusammenfassung erfasst",
  "activity.event.verificationSummarized": "Verifizierungszusammenfassung erfasst",
  "activity.event.artifactProduced": "Auslieferungsartefakt erstellt",
  "activity.event.researchPerformed": "Kontrollierte Recherche abgeschlossen",
  "activity.event.skillInvoked": "Skill-Aufruf abgeschlossen",
  "activity.event.childRunStarted": "Untergeordneter Lauf gestartet",
  "activity.event.childRunCompleted": "Untergeordneter Lauf abgeschlossen",
  "activity.event.operatorDecision": "Deine Entscheidung nötig",
  "activity.event.operatorDecisionAccepted": "Deine Entscheidung wurde übernommen",
  "activity.event.operatorDecisionDenied": "Deine Entscheidung hat die Anfrage abgelehnt",
  "activity.event.operatorDecisionUnavailable": "Die Entscheidung konnte nicht getroffen werden",
  "activity.event.operatorDecisionExpired": "Das Entscheidungsfenster ist abgelaufen",
  "activity.event.operatorDecisionStopped": "Die Entscheidung endete mit dem Lauf",
  "activity.event.failureRedacted": "Runtime-Fehler erfasst",
  "activity.event.modelGatewayRetrying": "Modell-Gateway nicht erreichbar, neuer Versuch",
  "activity.event.modelGatewayRecovered": "Modell-Gateway antwortet wieder",
  "activity.event.modelGatewayRetryStopped": "Wiederholung beim Modell-Gateway beendet",
  "activity.kind.step": "Schritt",
  "activity.kind.approval": "Freigabe angefordert",
  "activity.kind.approved": "Freigegeben",
  "activity.kind.rejected": "Abgelehnt",
  "activity.kind.stopped": "Angehalten",
  "activity.kind.open": "Geöffnet",
  "activity.kind.run": "Lauf",
  "activity.kind.delivery": "Auslieferung",
  "window.type.notifications.title": "Benachrichtigungen",
  "window.type.notifications.desc": "Hinweise und Updates prüfen",
  "notifications.empty": "Noch keine Benachrichtigungen.",
  "notifications.previewNotice": "Vorschau — noch keine Benachrichtigungsquelle verdrahtet",
  "automations.status.preview": "Vorschau",
  "plugins.mcp.previewHeader": "Vorschau — kein Server verbunden",
  "plugins.mcp.rowStatusPreview": "Vorschau",
  "voiceDialog.interrupt.action": "Unterbrechen",
  "voiceDialog.interrupt.ariaLabel": "Assistenten unterbrechen",
  "voiceDialog.interrupt.unavailableHint": "Nur verfügbar, während der Assistent spricht",

  "window.type.resources.title": "Ressourcen",
  "window.type.resources.desc": "Geteilte Assets & Referenzen — bald verfügbar.",
  "window.type.connector.title": "Knowledge Pod",
  "window.type.connector.desc": "Knowledge-Pod-Quelle auswählen",
  "window.type.localKnowledge.title": "Lokales Wissen",
  "window.type.localKnowledge.desc": "Knowledge Pods verwalten",
  "window.type.problems.title": "Probleme",
  "window.type.problems.desc": "Diagnosen und fehlgeschlagene Verifizierungen",
  "window.type.debug.title": "Debug",
  "window.type.debug.desc": "Zustand der kontrollierten Debug-Sitzung",
  "window.type.quality.title": "Quality Intelligence",
  "window.type.quality.desc": "Testfälle entwerfen und prüfen",
  "window.type.promptEnhancer.title": "Prompt Enhancer",
  "window.type.promptEnhancer.desc":
    "Einen rohen Prompt in einen kontrollierten, prüfbaren Enhanced Prompt überführen",
  "window.type.qiRun.title": "QI-Lauf",
  "window.type.qiRun.desc": "Generierte Testfälle",
  "window.type.relationships.title": "Beziehungen",
  "window.type.relationships.desc": "Beziehungsgraph inspizieren",
  "window.type.figma.title": "Figma-Snapshot",
  "window.type.figma.desc": "Figma-Snapshots verwalten",
  "window.type.figmaView.title": "Figma-Ansicht",
  "window.type.figmaView.desc": "Eingegrenzte Figma-Screen-Ansicht prüfen",
  "window.type.figmaJson.title": "Figma-JSON",
  "window.type.figmaJson.desc": "Eingegrenztes Figma-Screen-IR-JSON prüfen",
  "window.type.figmaImage.title": "Figma-Bild",
  "window.type.figmaImage.desc": "Eingegrenztes Figma-Screen-Rendering prüfen",
  "window.type.pdfCitationPreview.title": "PDF-Vorschau",
  "window.type.pdfCitationPreview.desc": "Geprüfte PDF-Vorschau in Keiko lesen",
  "window.type.governedGit.title": "Git",
  "window.type.governedGit.desc": "Branch anlegen, stagen, committen und veröffentlichen",
  "window.type.governedPullRequest.title": "Pull Request",
  "window.type.governedPullRequest.desc": "Review-fähigen PR nach Richtlinie öffnen",
  "window.type.governedMerge.title": "Merge",
  "window.type.governedMerge.desc": "Review-fähigen PR nach Richtlinie mergen",
  "window.type.agents.cta": "Agent starten",
  "window.field.title": "Titel",
  "window.field.folder": "Ordner",
  "window.field.filePath": "Dateipfad",
  "window.field.url": "URL",
  "window.field.documentationAddress": "Dokumentationsadresse",
  "window.field.projectPath": "Projektpfad",
  "window.field.workingDirectory": "Arbeitsverzeichnis",
  "window.field.previewState": "Vorschauzustand",
  "window.field.runId": "Lauf-ID",
  "window.field.provider": "Anbieter",
  "window.field.headBranch": "Quell-Branch",
  "window.placeholder.chatTitle": "Konversation benennen",
  "window.placeholder.folderPath": "/absoluter/ordner/pfad",
  "window.placeholder.relativeFilePath": "optionaler relativer Dateipfad",
  "window.placeholder.url": "https://…",
  "window.placeholder.documentationAddress": "https://intranet/handbuch oder file:///…",
  "window.placeholder.runId": "z. B. r-2026-06-01-…",
  "window.default.chatTitle": "Neuer Chat",
  "window.zoomOut": "Inhalt von {label} herauszoomen",
  "window.zoomReset": "{percent}% — Zoom des Inhalts von {label} zurücksetzen",
  "window.zoomIn": "Inhalt von {label} hineinzoomen",
  "window.controls": "Fenstersteuerung für {label}",
  "window.minimize": "{label}-Fenster minimieren",
  "window.restore": "{label}-Fenster wiederherstellen",
  "window.fullscreen": "{label}-Fenster im Vollbild",
  "window.close": "{label}-Fenster schließen",
  "workspace.connect.fallbackTitle": "Fenster",
  "workspace.connect.start":
    "Verbindung ausgehend von {title}. Wechsle mit Tab zu einem hervorgehobenen Fenster und bestätige mit Enter auf dem Fenster oder einem seiner Verbindungspunkte. Escape bricht ab.",
  "workspace.connect.cancelled": "Verbindung abgebrochen",
  "workspace.connect.notConnected": "Verbindung konnte nicht hergestellt werden.",
  "workspace.connect.connected": "Verbunden",
  "workspace.connect.connectedWith": "Verbunden: {label}",
  "palette.description": "Wähle eine Karte für deinen Arbeitsbereich",
  "palette.placeholder": "Vorschau",
  "palette.placeholderLabel": "Vorschauoberfläche — noch nicht funktionsfähig",
  "newWindow.title": "Neues {label}-Fenster",
  "newWindow.open": "{label} öffnen",
  "newWindow.empty": "Füge deinem Arbeitsbereich ein neues {label}-Fenster hinzu.",
  "newWindow.unexpectedError": "Etwas ist schiefgelaufen.",
  "nativeDialog.busy": "Ein nativer Dialog ist bereits geöffnet. Schließe ihn zuerst.",
  "nativeDialog.unsupported":
    "Native Dialoge sind auf dieser Plattform nicht verfügbar. Gib den Pfad manuell ein.",
  "nativeDialog.selectFolder": "Ordner auswählen",
  "nativeDialog.selectRepository": "Repository-Ordner auswählen",
  "nativeDialog.selectSourceFile": "Quelldatei auswählen",
  "command.group.create": "Erstellen",
  "command.group.tools": "Werkzeuge",
  "command.group.layout": "Layout",
  "command.group.view": "Ansicht",
  "command.group.edit": "Bearbeiten",
  "command.group.commands": "Befehle",
  "command.group.editor": "Editor",
  "command.new": "{label} erstellen",
  "command.open": "{label} öffnen",
  "command.openEditorSettings": "Editor-Einstellungen öffnen",
  "command.toggleTheme": "Hellen / dunklen Modus umschalten",
  "command.undo": "Rückgängig (nur Fenster- und Panel-Änderungen)",
  "command.undoLabelled": "Rückgängig: {label}",
  "command.redo": "Wiederherstellen (nur Fenster- und Panel-Änderungen)",
  "command.redoLabelled": "Wiederherstellen: {label}",

  // #3591: Gateway-Fehler auf den Desktop-Chat-Oberflächen (format-error.ts). Ein langsames Gateway
  // ist kein defektes Gateway, und keiner der Texte macht die Größe der Anfrage verantwortlich.
  "chat.error.scopeChanged.title": "Verbundene Quellen wurden geändert",
  "chat.error.scopeChanged.message":
    "Die verbundenen Quellen haben sich zwischenzeitlich geändert. Die Anfrage wurde nicht mit einer veralteten Quellenliste ausgeführt.",
  "chat.error.scopeChanged.remediation":
    "Prüfe die aktuellen Quellen des Chats und sende deine Anfrage anschließend erneut.",
  "chat.error.gatewayTimeout.title": "Das Modell-Gateway hat nicht rechtzeitig geantwortet",
  "chat.error.gatewayTimeout.message":
    "Das Modell-Gateway hat die Anfrage nicht innerhalb von Keikos Wartezeit abgeschlossen. Keiko wartet bei einem langsamen Gateway minutenlang; das bedeutet in der Regel, dass das Gateway oder das Modell hängt – nicht, dass die Anfrage zu groß war.",
  "chat.error.gatewayTimeout.remediation":
    "Versuche es erneut oder prüfe in den Einstellungen Gateway-URL, Proxy und Deployment, wenn es wiederholt auftritt.",
  "chat.error.gatewayOutputExhausted.title": "Das Modell hat sein Ausgabebudget aufgebraucht",
  "chat.error.gatewayOutputExhausted.message":
    "Das Modell hat sein gesamtes Ausgabebudget verbraucht, bevor eine Antwort entstand – meist durch Reasoning. Lass das Gateway ein größeres max_output_tokens für dieses Modell melden oder wähle ein Modell mit geringerem Reasoning-Anteil, und versuche es erneut.",
  "chat.error.gatewayOutputExhausted.remediation":
    "Erhöhe in den Einstellungen die maximalen Ausgabe-Tokens des Modells oder wechsle zu einem Modell mit geringerem Reasoning-Anteil, und versuche es erneut.",
  "chat.error.streamStalled.title": "Verbindung zur Antwort unterbrochen",
  "chat.error.streamStalled.message":
    "Die Verbindung zu Keiko hat eine Minute lang nichts mehr geliefert. Die Antwort wurde abgebrochen.",
  "chat.error.streamStalled.remediation":
    "Sende die Nachricht erneut. Tritt es wiederholt auf, prüfe Netzwerk, Proxy oder ob Keiko neu gestartet wurde.",
  "chat.error.contextOverflow.title": "Anfrage größer als das Kontextfenster",
  "chat.error.contextOverflow.message":
    "Die Anfrage überschreitet das Kontextfenster des Modells. Meldet der Anbieter sein Fenster, übernimmt Keiko es.",
  "chat.error.contextOverflow.remediation":
    "Kürze die Nachricht oder wähle ein Modell mit größerem Kontextfenster.",
  "chat.error.attachmentOversized.message":
    "Angehängte Inhalte sind zu groß. Kürze oder entferne sie.",

  // Editor-agent surface messages live in the lazy `editor-agent-i18n.ts` namespace so opening the
  // workspace shell does not preload editor-only translations. Issue #2120 added the localized
  // agent-presence-indicator labels to that lazy namespace (EN/DE) rather than this shell catalog.
  // M7 editor personalization messages likewise live in the lazy `settings-i18n.ts` namespace;
  // this catalog touch records the required German-copy review without preloading editor settings.
  // The Epic #2092 audit follow-up (verification-target scoping in EditorRuntimeWidget.tsx, tab-
  // eviction correctness in ProblemsPanel.tsx) is purely behavioral and introduces no new strings;
  // Problems-panel text lives in the lazy `problems-i18n.ts` namespace, also unaffected.
  // Governed-debug panel, gutter, prompt, command, status, and accessibility text lives in the
  // existing lazy `debugging-i18n.ts` EN/DE catalog so dormant debugging stays out of the shell.
  // The Epic #2096 audit follow-up added the accessible breakpoint-text dialog, the keyboard-
  // reachable breakpoint inventory, the current-execution-line gutter marker, the exception-pause
  // announcement, and the setVariable side-effect disclosure to that same lazy `debugging-i18n.ts`
  // namespace, so no new shell-catalog keys are introduced here either.
  // The Epic #2093 audit follow-up (unavailable-repository contract-shape fix in gitRoutes.ts,
  // wiring the previously-dead EditorAgentSessionSnapshot.gitContextSummary producer in
  // EditorRuntimeWidget.tsx) is likewise purely behavioral and introduces no new strings; the
  // source-control labels it touches live in the lazy `editor-source-control-i18n.ts` namespace.
  // The Epic #2095 audit follow-up added the AI-assist activation confirm dialog's
  // confirmTitle/confirmAccept/confirmDecline keys to the lazy `settings-i18n.ts` namespace
  // (replacing a window.confirm() call) rather than this shell catalog.

  "chat.hero.title": "Was sollen wir bauen?",
  "chat.hero.loadingWorkspace": "Lokaler Arbeitsbereich wird geladen…",
  "chat.hero.placeholder": "Beschreibe eine Aufgabe, füge einen Link ein oder frag etwas…",
  "chat.workLocally": "Lokal arbeiten",

  "chat.composer.loading": "Lädt…",

  "chat.model.title": "Modell",

  "chat.model.noneConfiguredTitle":
    "Kein dialogfähiges Modell ist konfiguriert - verbinde ein Gateway in den Einstellungen",

  "chat.voice": "Spracheingabe",
  "chat.voice.interrupt": "Assistenz unterbrechen",
  "chat.voice.interruptShort": "Unterbrechen",
  "chat.voice.interruptAvailable": "Verfügbar, während Keiko spricht.",

  "chat.error.load": "Chat konnte nicht geladen werden.",

  "chat.error.supportId": "Support-ID: {correlationId}",

  "chat.grounding.sourceLimit":
    "Quellenlimit erreicht — dieser Chat hat bereits {connectedCount} von {cap} verbundenen Quellen. Trenne eine Quelle, bevor du eine weitere verbindest.",
  "chat.grounding.readyChatRequired":
    "Öffne ein bereites Chatfenster, bevor du eine Quelle verbindest.",
  "chat.grounding.localFolderRequired":
    "Wähle einen lokalen Ordner aus, bevor du ihn mit dem Chat verbindest.",
  "chat.grounding.scopeOwnershipMissing":
    "Diese Quellenverbindung lässt sich nicht eindeutig wiederherstellen. Du kannst die Verbindung entfernen und die Quellen des Chats behalten.",
  "chat.grounding.forgetConnection": "Nur Verbindung entfernen; Chatquellen behalten",
  "chat.grounding.recoveryRequired":
    "Die Wiederherstellung des Chat-Groundings ist fehlgeschlagen. Lade den Chat neu, bevor du eine weitere Quelle verbindest.",
  "chat.grounding.timeoutBlocked":
    "Das Chat-Grounding ist nach einer Zeitüberschreitung blockiert. Lade den Chat neu, bevor du es erneut versuchst.",
  "chat.grounding.connectSourceFailed":
    "Keiko konnte diese Quelle nicht verbinden. Prüfe, ob sie noch verfügbar ist, und versuche es erneut.",
  "chat.grounding.connectKnowledgeFailed":
    "Keiko konnte diese Wissensquelle nicht verbinden. Prüfe, ob sie noch verfügbar ist, und versuche es erneut.",
  "chat.grounding.gitChangeSavedRefreshUnavailable":
    "Git-Änderung gespeichert. Die Chat-Ansicht konnte nicht vollständig aktualisiert werden.",
  "chat.grounding.connectGitChangeFailed":
    "Keiko konnte diese Git-Änderung nicht verbinden. Prüfe, ob Repository und Branches noch verfügbar sind, und versuche es erneut.",

  "memoria.memoryLabel": "Erinnerung",

  "memoria.settings.enabled": "Für Chat aktiviert",
  "memoria.settings.disabled": "Für Chat deaktiviert",
  "memoria.settings.useInChat": "Im Chat verwenden",
  "memoria.settings.useInChatHelp":
    "Relevante Erinnerungen anhängen, wenn die nächste Anfrage gesendet wird.",
  "memoria.settings.useInChatLabel": "MemoriaViva in Chat-Anfragen verwenden",

  "memoria.settings.mode.hydrateError":
    "Der Erinnerungsautonomiemodus konnte nicht geladen werden. Um Freigabe bitten bleibt aktiv.",
  "memoria.settings.mode.persistError":
    "Der Erinnerungsautonomiemodus konnte nicht gespeichert werden. Der vorherige Modus bleibt aktiv.",

  "attachment.notSupported": "Anhänge nicht unterstützt",

  "footer.status": "Arbeitsbereich-Status",
  "footer.version": "Keiko-Version {version}",
  "footer.versionLoading": "Version wird geladen",
  "footer.versionUnavailable": "Version nicht verfügbar",
  "footer.windowSingular": "{count} Fenster",
  "footer.windowPlural": "{count} Fenster",
  "footer.openWindows": "Offene Fenster",
  "footer.minimized": "Minimiert",
  "footer.fullscreen": "Vollbild",
  "footer.visible": "Sichtbar",
  "footer.restore": "Wiederherstellen",
  "footer.focus": "Fokussieren",
  "footer.windowAction": "{action} {title}-Fenster{suffix}",
  "scope.pressure.low": "Niedrig",
  "scope.pressure.moderate": "Moderat",
  "scope.pressure.high": "Hoch",
  "scope.pressure.exceeded": "Überschritten",
  "scope.connectedFolder": "Verbundener Ordner",
  "scope.folder": "Ordner: {name}",
  "scope.repository": "Repository-Bereich",
  "scope.connectedFile": "Verbundene Datei",
  "scope.file": "Datei: {name}",
  "scope.filesConnected": "{count} Dateien verbunden",
  "scope.boundary.repository":
    "Keiko darf nur das verbundene Repository prüfen; Safe-Read-Ausschlüsse und Kontextbudget-Limits gelten vor jeder Antwort.",
  "scope.boundary.folder":
    "Keiko darf nur den verbundenen Ordner prüfen; Safe-Read-Ausschlüsse und Kontextbudget-Limits gelten vor jeder Antwort.",
  "scope.boundary.file":
    "Keiko darf nur den verbundenen Dateibereich prüfen; Safe-Read-Ausschlüsse und Kontextbudget-Limits gelten vor jeder Antwort.",
  "scope.disconnectError": "Bereich konnte nicht getrennt werden.",
  "settings.title": "Einstellungen",
  "settings.language.compactLabel": "Sprache",
  "updates.notice.aria": "Keiko-Update-Hinweis",
  "updates.notice.title": "Update verfügbar",
  "updates.notice.criticalTitle": "Kritisches Update verfügbar",
  "updates.notice.releaseUnavailableTitle": "Update-Prüfung nicht verfügbar",
  "updates.notice.body":
    "Version {version} kann geprüft werden. Keiko installiert sie nicht automatisch.",
  "updates.notice.releaseUnavailableBody":
    "Keiko konnte die Update-Download-Informationen gerade nicht prüfen. Es wird nichts installiert.",
  "updates.notice.portableBody":
    "Version {version} ist bereit. Öffne Updates und klicke auf Update, wenn du bereit bist.",
  "updates.notice.portableSetupBody":
    "Portable Setup ist erforderlich, bevor Keiko App-interne Updates nutzen kann.",
  "updates.notice.portableExternallyManagedBody":
    "Diese Keiko-Installation wird außerhalb der App verwaltet. Öffne Updates für Details.",
  "updates.notice.review": "Update prüfen",
  "updates.notice.notNow": "Nicht jetzt",
  "updates.versionUnknown": "unbekannt",

  "updates.status.current": "Keiko ist aktuell",
  "updates.status.available": "Update verfügbar",
  "updates.status.critical": "Kritisches Update verfügbar",
  "updates.status.degraded": "Update-Status eingeschränkt",
  "updates.status.unavailable": "Update-Status nicht verfügbar",
  "updates.status.releaseUnavailable": "Update-Prüfung nicht verfügbar",
  "updates.status.installing": "Update wird installiert",
  "updates.status.restart": "Neustart erforderlich",
  "updates.status.success": "Update installiert",
  "updates.status.failed": "Update fehlgeschlagen",

  "updates.impact.required": "Erforderliche Aktion: {remediation}",

  "updates.remediation.none": "Keine Aktion erforderlich",
  "updates.remediation.restart": "Neustart erforderlich",
  "updates.remediation.repair": "Lokale Statusreparatur",
  "updates.remediation.reindex": "Lokales Wissen neu indexieren",
  "updates.remediation.migration": "Migration erforderlich",
  "updates.remediation.manualReview": "Prüfung erforderlich",

  "updates.manual.copySelected": "Text ausgewählt. Nutze deinen System-Kopierbefehl.",

  "updates.manual.copyFailed":
    "Kopieren fehlgeschlagen. Wähle den Text aus und kopiere ihn manuell.",

  "updates.actionStatus.notNeeded": "Nicht erforderlich",
  "updates.actionStatus.pending": "Ausstehend",
  "updates.actionStatus.running": "Läuft",
  "updates.actionStatus.completed": "Abgeschlossen",
  "updates.actionStatus.failed": "Fehlgeschlagen",
  "updates.actionStatus.deferred": "Aufgeschoben",
  "updates.actionStatus.manualReview": "Prüfung erforderlich",
  "updates.featureState.ready": "Bereit",
  "updates.featureState.degraded": "Eingeschränkt",
  "updates.featureState.unavailable": "Nicht verfügbar",
  "updates.featureState.manualReview": "Prüfung erforderlich",
  "updates.phase.preparing": "Update wird vorbereitet",
  "updates.phase.running": "Update wird installiert",
  "updates.phase.restartRequired": "Neustart erforderlich",
  "updates.phase.succeeded": "Update installiert",
  "updates.phase.failed": "Update fehlgeschlagen",
  "updates.phase.cancelled": "Update abgebrochen",
  "select.placeholder": "Option auswählen",
  "workspace.empty.openWindow": "Neues Fenster öffnen",
  "workspace.notice.dismiss": "Arbeitsbereichshinweis schließen",
  "workspace.windowLimitReached":
    "Im Arbeitsbereich sind bereits {limit} Fenster geöffnet. Schließe ein Fenster und versuche es erneut.",
  "workspace.empty.description": "Der Workspace ist leer. Öffne ein Fenster, um zu beginnen.",
  "workspace.empty.title": "Leerer Workspace",
  "workspace.empty.subtitle": "Fenster öffnen und loslegen",
  "scope.pill.connectedFolder": "Verbundener Ordner",
  "scope.pill.folder": "Ordner: {name}",
  "scope.pill.repositoryScope": "Verbundener Stammordner",
  "scope.pill.connectedFile": "Verbundene Datei",
  "scope.pill.file": "Datei: {name}",
  "scope.pill.filesConnected": "{count} Dateien verbunden",
  "scope.pill.accessibleWithPath": "{label} ({path})",
  "scope.boundary.noun.repository": "den verbundenen Stammordner",
  "scope.boundary.noun.folder": "den verbundenen Ordner",
  "scope.boundary.noun.fileScope": "den verbundenen Datei-Scope",
  "scope.boundary.description":
    "Keiko darf nur {noun} auswerten; Safe-Read-Ausschlüsse und Kontextbudgets greifen vor jeder Antwort.",
  "scope.disconnect.error": "Scope konnte nicht getrennt werden.",
  "scope.disconnect.aria": "{label} vom Chat trennen",
  "scope.disconnect.title": "{label} vom Chat trennen",
  "scope.disconnect.titleWithPath": "{label} vom Chat trennen ({path})",
  "scope.announcement.removed": "Verbundener Scope wurde entfernt.",
  "scope.announcement.updated.one": "Verbundener Scope aktualisiert: 1 Quelle.",
  "scope.announcement.updated.many": "Verbundener Scope aktualisiert: {count} Quellen.",
  // Issue #3400 (epic #3384) — git-change scope pill (GitChangeScopePill.tsx).

  "scope.budget.pressure.low": "Niedrig",
  "scope.budget.pressure.moderate": "Mittel",
  "scope.budget.pressure.high": "Hoch",
  "scope.budget.pressure.exceeded": "Überschritten",
  "scope.budget.summary": "Letzter Grounding-Lauf: {tokens} Tokens, {files} Dateien",
  "scope.connect.update": "Verbundenen Scope aktualisieren",
  "scope.connect.repository": "Repository verbinden",
  "scope.connect.folder": "Ordner verbinden",
  "scope.connect.chat": "Mit Chat verbinden",
  "scope.connect.error": "Scope konnte nicht verbunden werden.",
  "scope.connect.limitReached":
    "Quellenlimit erreicht ({connected}/{cap}). Trenne zuerst eine Quelle.",
  "scope.connect.targetAria": "{label}: {target}",
  "scope.connect.selectFirst": "Wähle zuerst einen Ordner oder eine Datei aus",
  "scope.connect.selectFirstSentence": "Wähle zuerst einen Ordner oder eine Datei aus.",
  "scope.connect.noSelectionAria": "Mit Chat verbinden (keine Auswahl)",
  "scope.connect.connecting": "Wird verbunden…",

  "taskWorkspace.lifecycleState": "Lebenszyklusstatus",
  "taskWorkspace.health": "Workspace-Zustand",
  "taskWorkspace.dirty.uncommitted": "ungesichert",
  "taskWorkspace.dirty.uncommittedTitle": "Der Worktree enthält uncommittete Änderungen",
  "taskWorkspace.dirty.clean": "sauber",
  "taskWorkspace.dirty.cleanTitle": "Der Worktree ist sauber",

  "taskWorkspace.locked": "gesperrt: {reason}",
  "taskWorkspace.lockedTitle": "Gehalten von {owner}",
  "taskWorkspace.updatedAt": "Aktualisiert: {value}",
  "taskWorkspace.recoveryHints": "Hinweise zur Wiederherstellung ({count})",
  "taskWorkspace.operatorActionRequired": " (Aktion durch Operator erforderlich)",
  "taskWorkspace.marker.worktree-missing": "Worktree fehlt",
  "taskWorkspace.marker.gitdir-mismatch": "Git-Zeiger-Abweichung",
  "taskWorkspace.marker.pointer-stale": "Git-Zeiger fehlt",
  "taskWorkspace.marker.identity-schema-retired": "Identitätsschema veraltet",
  "taskWorkspace.marker.identity-unsupported": "Erstellungszeit nicht unterstützt",
  "taskWorkspace.marker.head-moved": "HEAD verschoben",
  "taskWorkspace.marker.branch-deleted": "Branch gelöscht",
  "taskWorkspace.marker.uncommitted-changes": "Uncommittete Änderungen",
  "taskWorkspace.marker.lock-stale": "Veraltete Sperre",
  "taskWorkspace.marker.path-escape": "Pfad verlässt verwalteten Bereich",

  "taskWorkspace.noWorkspaceBound": "Kein Workspace gebunden",

  "taskWorkspace.empty.title": "Kein aktiver Task Workspace",
  "taskWorkspace.empty.openProject":
    "Öffne zuerst ein Projekt, bevor du einen verwalteten Task Workspace erstellst.",
  "taskWorkspace.empty.switchOrCreate":
    "Wechsle zu einem vorhandenen Workspace oder erstelle einen für dieses Repository.",
  "taskWorkspace.available": "Verfügbare Workspaces",

  "taskWorkspace.create.title": "Workspace erstellen",
  "taskWorkspace.create.taskId": "Task-ID",
  "taskWorkspace.create.taskIdPlaceholder": "z. B. 446-binding",
  "taskWorkspace.create.baseBranch": "Basis-Branch",
  "taskWorkspace.create.baseBranchPlaceholder": "z. B. dev",
  "taskWorkspace.create.submit": "Task Workspace erstellen",
  "workspaceContext.trigger.aria": "Arbeitskontext: {name}",
  "workspaceContext.trigger.choose": "Ordner auswählen",
  "workspaceContext.status.none": "Kein Ordner oder Repository ausgewählt",
  "workspaceContext.status.project": "Arbeitskontext: {name}",
  "workspaceContext.folder.title": "Ordner oder Repository",
  "workspaceContext.choose": "Ordner auswählen",
  "workspaceContext.chooseDialogTitle": "Ordner oder Repository auswählen",
  "workspaceContext.dialogBusy": "Ein anderer Dateidialog ist bereits geöffnet.",
  "workspaceContext.dialogUnsupported":
    "Der native Ordnerdialog ist nicht verfügbar. Gib den Pfad unten ein.",
  "workspaceContext.selectionFailed":
    "Der Ordner konnte nicht ausgewählt werden. Prüfe den Pfad und versuche es erneut.",
  "workspaceContext.overrideClearFailed":
    "Der aktive Task Workspace konnte nicht gelöst werden, daher wurde der Ordner nicht gewechselt. Prüfe den Task Workspace und versuche es erneut.",
  "workspaceContext.supportId": "Support-ID: {correlationId}",
  "workspaceContext.selecting": "Wird ausgewählt…",
  "workspaceContext.manual.label": "Oder lokalen Pfad eingeben",
  "workspaceContext.manual.placeholder": "/pfad/zum/ordner",
  "workspaceContext.open": "Öffnen",

  // Graph-Health-Panel (#542): Ein begrenzter Scan darf niemals Fehlerfreiheit bescheinigen —
  // deshalb trennt der Text „fehlerfrei“ von „unvollständig – nicht aussagekräftig“, und jede
  // Zahl aus einer abgeschnittenen Kategorie ist als Untergrenze formuliert.

  // Wiederherstellung der Relationship-Liste (error-and-denial-ux.md §„Bounded-query-exceeded UX“:
  // Das Banner einer abgelehnten Abfrage bietet einen Reset, damit ein vergifteter Ansichtszustand
  // keine Sackgasse ist).

  // Begrenzte Impact-Analyse (#542): Ein fehlgeschlagener Walk muss das sagen, statt einen
  // Gedankenstrich und ein dauerhaftes „Loading…“ zu zeigen.

  "relationships.impact.forward": "Abhängigkeiten vorwärts",
  "relationships.impact.reverse": "Abhängigkeiten rückwärts",
  // Epic #2093 source-control copy is intentionally feature-local so the editor remains lazy.
  // Issue #2150: Workspace.tsx/WindowFrame.tsx changed but added no new
  // user-facing strings — check:ui-i18n flags any edit to a file that uses
  // useTranslate() regardless of the diff, so this file is touched to
  // satisfy that fail-closed gate with no new keys.

  // Issue #2245 (Epic #2238) — Atlassian-Connector-Oberflächen (Einrichtung, Sync, Freigaben).

  "atlassianConnectors.add.title": "Connector hinzufügen",

  "atlassianConnectors.scope.title": "Bereich",

  "atlassianConnectors.sync.title": "Sync",

  // The voice-dialogue composer motion update adds no user-facing copy; this
  // catalog touch records the required German-copy review for ChatWindow.tsx.
  // The SonarCloud cognitive-complexity refactor (S3776) reflows JSX in
  // ChatWindow.tsx, GatewaySetupDialog.tsx, UpdateWindow.tsx, EditorDiffSurface.tsx,
  // GitClientWindow.tsx, FigmaSnapshotWindow.tsx, QiRunCard.tsx, RunLauncher.tsx, and
  // HealthScanFindings.tsx without changing any user-facing copy; this catalog touch
  // records the required German-copy review.
  // Neue i18n-Schlüssel für das Quality-Widgets-Retrofit: AgentRunWidget, FilePreview,
  // FilesWidget, PdfCitationPreviewWindow, ReviewWidget, FigmaSnapshotWindow.
  "filePreview.showSource": "Quellenvorschau anzeigen",
  "filePreview.linesAdded": "{count} Zeilen hinzugefügt.",
  "filePreview.revealedLine": "Quellenzeile {line}.",
  "filePreview.revealedPartialRange":
    "Quellenzeilen {start}–{end} angezeigt. Weitere referenzierte Zeilen liegen außerhalb dieses Ausschnitts.",
  "filePreview.revealedRange": "Quellenzeilen {start}–{end}.",
  "filePreview.revealOutsideContent":
    "Die referenzierte Zeile {line} liegt außerhalb dieser Datei ({count} Zeilen).",
  "filePreview.deniedMessage":
    "Diese Datei ist aus Sicherheitsgründen von der Leseoberfläche ausgeschlossen (entspricht einem Sperrmuster wie .env, *.pem, node_modules, .git, …).",
  "filePreview.searchableDocument":
    "{format}-Dateien bis 2 MB sind in der Repository-Suche über eine begrenzte Textextraktion durchsuchbar, wenn sie explizit mit einem Chat verbunden sind. Verschlüsselte, gescannte oder größere Dokumente werden nicht extrahiert – nutzen Sie dafür Local Knowledge. Für dieses Format ist hier keine Inline-Vorschau verfügbar.",
  "filePreview.error.loadFailed": "Die Datei konnte nicht geladen werden. Versuchen Sie es erneut.",
  "filePreview.error.unreadable": "Diese Datei kann nicht gelesen werden.",
  "filePreview.binary.tooLarge": "Vorschau deaktiviert, da diese Datei {maxBytes} überschreitet.",
  "filePreview.binary.unsupported":
    "Für diesen Dateityp ist keine sichere Text- oder Bildvorschau verfügbar.",
  "filePreview.metadata.type": "Typ",
  "filePreview.metadata.size": "Größe",
  "filePreview.metadata.modified": "Geändert",
  "filePreview.metadata.extension": "Erweiterung",
  "filePreview.metadata.extensionNone": "keine",
  "filePreview.backToFiles": "Zurück zu den Dateien",
  "filePreview.copyFileName": "Dateiname kopieren",
  "filePreview.copyFilePath": "Dateipfad kopieren",
  "filePreview.copyStatus.nameCopied": "Dateiname kopiert",
  "filePreview.copyStatus.pathCopied": "Dateipfad kopiert",
  "filePreview.copyStatus.clipboardFailed": "Zugriff auf die Zwischenablage fehlgeschlagen.",
  "filePreview.refresh": "Vorschau aktualisieren",
  "filePreview.refreshing": "Vorschau wird aktualisiert",
  "filePreview.refreshStatus.refreshing": "Wird aktualisiert …",
  "filePreview.refreshStatus.reloaded": "Neu geladen",
  "filePreview.refreshStatus.failed": "Aktualisierung fehlgeschlagen",
  "filePreview.openInEditor": "Im Editor öffnen",
  "filePreview.closePreview": "Vorschau schließen",
  "filePreview.loadingState": "Vorschau wird geladen…",
  "filePreview.retry": "Erneut versuchen",
  "filePreview.truncatedBanner":
    "Vorschau bei {maxBytes} abgeschnitten. Größere Dateien können hier nicht vollständig angezeigt werden.",
  "filePreview.syntaxHighlightDisabled": "Syntaxhervorhebung für große Vorschauen deaktiviert.",
  "filePreview.previewRegionLabel": "Dateivorschau: {name}",
  "filePreview.showMoreLines": "{count} weitere Zeilen anzeigen",
  "filePreview.showPreviousLines": "{count} vorherige Zeilen anzeigen",
  "filePreview.readOnlyBanner":
    "Schreibgeschützte Quellenvorschau. Diese Datei kann hier nicht bearbeitet werden.",
  "filePreview.hiddenFile": "Verborgene Datei",
  "filePreview.previewUnavailable": "Vorschau nicht verfügbar",
  "filePreview.headerLoading": "Vorschau wird geladen",
  "filePreview.lang.denied": "verweigert",
  "filePreview.lang.error": "fehler",
  "filePreview.lang.loading": "lädt",
  "filePreview.lang.text": "text",
  "filePreview.lang.binary": "binär",

  // Abgeschlossene Fetch-/Pull- und Push-Ergebnisse. Satzfragmente: Sie werden als {status} in
  // "gitClientWindow.sync.operationStatus" eingesetzt. Ein fehlgeschlagenes Ergebnis wird zusätzlich
  // als Fehler dargestellt und angesagt — siehe git-client/sync-outcome.ts.

  // Zugängliche Namen der benannten <section>-Landmarks aus Welle #2721. Sie standen als
  // fest verdrahtetes Englisch auf den role="region"-Elementen, die diese Sections ersetzen;
  // ein Screenreader liest sie vor, also gehören sie wie jeder andere Nutzertext in den Katalog.
  "runtimeHubWidget.auditMetadataAria": "Laufzeit-Audit-Metadaten",
  "installBanner.regionAria": "Keiko installieren",
  "markdown.codeBlock.regionAria": "Codeblock: {language}",
  "markdown.codeBlock.languageText": "Text",
  "connectorPicker.sets.notReadyNotice":
    "{count} Knowledge Pod Sets sind nicht bereit für Antwort-Grounding und werden nicht aufgeführt.",
  // "abgerufen", nicht "indexiert": diese Zahl zählt die vom Crawler akzeptierten Seiten, nicht die
  // im Index gelandeten — dafür ist `manualPod.progress.index` zuständig (0.3.0-Audit).
  "manualPod.progress.crawl": "{accepted} Seiten abgerufen, {denied} Links übersprungen",
  "manualPod.progress.index": "{processed} von {total} Seiten indexiert",
  "manualPod.progress.gaps": "{failed} Seiten fehlgeschlagen, {skipped} Seiten übersprungen",
  "manualPod.progress.gapsTitle": "Was ausgelassen wurde",
  "manualPodCreate.button": "HTML-Handbuch hinzufügen",
  "manualPodCreate.form.title": "HTML-Handbuch hinzufügen",
  "manualPodCreate.form.nameLabel": "Anzeigename",
  "manualPodCreate.form.namePlaceholder": "Hersteller-Produkthandbuch",
  "manualPodCreate.form.originLabel": "Ursprung der Handbuch-Website",
  "manualPodCreate.form.originPlaceholder": "https://docs.example.com",
  "manualPodCreate.form.prefixLabel": "Pfad-Präfix (optional)",
  "manualPodCreate.form.prefixPlaceholder": "/guide",
  "manualPodCreate.form.submit": "Handbuch-Pod erstellen",
  "manualPodCreate.form.cancel": "Abbrechen",
  "manualPodCreate.form.validation": "Anzeigename und einen http(s)-Website-Ursprung eingeben.",
  "manualPodCreate.progress.running": "Handbuch-Pod wird erstellt…",
  "manualPodCreate.state.succeeded": "Handbuch-Pod erstellt",
  "manualPodCreate.state.partial": "Handbuch-Pod mit Lücken erstellt; einige Seiten fehlen",
  "manualPodCreate.state.failed":
    "Erstellung fehlgeschlagen; es wurde kein Handbuch-Pod hinzugefügt",
  "manualPodRefresh.button": "Handbuch aktualisieren",
  "manualPodRefresh.confirm.body": "Dieses HTML-Handbuch neu crawlen und neu indexieren?",
  "manualPodRefresh.confirm.cancel": "Abbrechen",
  "manualPodRefresh.confirm.confirm": "Handbuch aktualisieren",
  "manualPodRefresh.progress.running": "Handbuch wird aktualisiert…",
  "manualPodRefresh.state.succeeded": "Handbuch aktualisiert",
  "manualPodRefresh.state.partial": "Handbuch mit Lücken aktualisiert; einige Seiten fehlen",
  "manualPodRefresh.state.failed":
    "Aktualisierung fehlgeschlagen; das vorherige Handbuch bleibt unverändert",
  // GovernedPullRequestCard's Description panel (preview -> approve -> apply, epic #3384 #3399).

  "repositoryBranchSwitcher.setUpGit": "Git einrichten",
  "repositoryBranchSwitcher.initializeDescription":
    "Initialisiert das ausgewählte Projekt als lokales Git-Repository mit dem Startbranch main.",
  "repositoryBranchSwitcher.cancel": "Abbrechen",
  "repositoryBranchSwitcher.initializing": "Initialisieren…",
  "repositoryBranchSwitcher.initializeRepository": "Repository initialisieren",
  "attachment.notice.readFailed":
    "„{name}“ konnte nicht gelesen werden — die Datei wird übersprungen. Deine Nachricht wird ohne sie gesendet.",
  "attachment.notice.budgetExhausted":
    "„{name}“ wird nicht gesendet — das Anhang-Limit von {limit} war bereits durch frühere Dateien aufgebraucht.",
  "attachment.notice.countExceeded":
    "„{name}“ wird nicht gesendet — nur die ersten {max} Dokumente werden übernommen.",
  "attachment.notice.nonTextDocument":
    "Aus „{name}“ konnte kein Text extrahiert werden — deine Nachricht wird ohne Dokumenttext gesendet, und das Modell erhält die Datei selbst nicht.",
  "attachment.notice.imageUndeliverable":
    "„{name}“ wird nicht gesendet — das Modell erhält in dieser Unterhaltung keine Bildanhänge. Beschreibe stattdessen in deiner Nachricht, worauf es ankommt.",
  "settings.models.retrievalEmbeddingUnavailable":
    "Retrieval-Embedding: bestanden (Modellidentität in diesem Bericht nicht verfügbar)",
  "settings.models.retrievalEmbeddingIdentity": "Retrieval-Embedding-Modell: {modelId}{shape}",
  "settings.models.retrievalEmbeddingDimensions": " ({dimensions} Dimensionen)",
} satisfies MessageCatalog;
