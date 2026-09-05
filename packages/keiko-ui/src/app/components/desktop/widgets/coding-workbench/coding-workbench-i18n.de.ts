import type { CodingWorkbenchMessageCatalog } from "./coding-workbench-i18n.en";

export const DE_CODING_WORKBENCH_MESSAGES = {
  "codingWorkbench.journey.title": "Issue-Übergabe",
  "codingWorkbench.journey.state.awaiting-ready-approval":
    "Freigabe für Review-Bereitschaft erforderlich",
  "codingWorkbench.journey.state.keiko-technical-ready": "Technische Keiko-Arbeit bereit",
  "codingWorkbench.journey.state.ready-for-human-review": "Bereit für menschliches Review",
  "codingWorkbench.journey.state.awaiting-human-requirements":
    "Menschliche Review-Anforderungen sind noch offen",
  "codingWorkbench.journey.state.merged-awaiting-issue-closure":
    "Zusammengeführt; Issue-Abschluss ausstehend",
  "codingWorkbench.journey.state.completed": "Issue-Ablauf abgeschlossen",
  "codingWorkbench.journey.state.blocked": "Übergabe blockiert",
  "codingWorkbench.journey.state.cancelled": "Übergabe abgebrochen",
  "codingWorkbench.journey.state.recovery-required": "Abgleich der Übergabe erforderlich",
  "codingWorkbench.journey.state.stale": "Übergabe-Beobachtung ist veraltet",
  "codingWorkbench.journey.staleHelp":
    "Dies sind datierte Beobachtungen. Aktualisiere den Status, bevor du dich auf aktuelle Bereitschaft oder Issue-Abschluss verlässt.",
  "codingWorkbench.journey.refresh": "Beobachteten Status aktualisieren",
  "codingWorkbench.journey.proposeReady": "Anfrage zur Review-Bereitschaft prüfen",
  "codingWorkbench.journey.readyHelp":
    "Prüfe den Wechsel vom Entwurf zur Review-Bereitschaft, bevor du ihn einmalig freigibst.",
  "codingWorkbench.journey.proposeReadyPending":
    "Der Freigabepfad für die Review-Bereitschaft ist noch nicht verfügbar.",
  "codingWorkbench.journey.changedFiles": "{count} geänderte Dateien",
  "codingWorkbench.journey.changedFilesTruncated": "(Liste gekürzt)",
  "codingWorkbench.journey.busy": "Übergabestatus wird aktualisiert…",
  "codingWorkbench.journey.actionError.refresh":
    "Statusaktualisierung fehlgeschlagen ({reason}). Die gespeicherten Beobachtungen bleiben sichtbar.",
  "codingWorkbench.journey.actionError.propose-ready":
    "Die Anfrage zur Review-Bereitschaft ist fehlgeschlagen ({reason}). Aktualisiere den beobachteten Status vor einem neuen Versuch.",
  "codingWorkbench.journey.issueLink": "Issue #{number}",
  "codingWorkbench.journey.prLink": "Pull Request #{number}",
  "codingWorkbench.journey.ci": "Technische Prüfungen",
  "codingWorkbench.journey.checkCounts":
    "{passed} von {total} erforderlichen Prüfungen bestanden · {failed} beratende Fehler",
  "codingWorkbench.journey.description": "Keiko-PR-Beschreibung",
  "codingWorkbench.journey.description.current": "Beschreibung ist aktuell",
  "codingWorkbench.journey.description.partial": "Teilweise Beschreibung angewendet",
  "codingWorkbench.journey.description.fallback": "Ersatzbeschreibung angewendet",
  "codingWorkbench.journey.description.stale": "Bestätigung der Beschreibung ist veraltet",
  "codingWorkbench.journey.description.blocked": "Anwendung der Beschreibung blockiert",
  "codingWorkbench.journey.description.failed": "Anwendung der Beschreibung fehlgeschlagen",
  "codingWorkbench.journey.description.unavailable": "Beschreibungsstatus nicht verfügbar",
  "codingWorkbench.journey.descriptionApplied": "Beschreibung auf den beobachteten PR angewendet",
  "codingWorkbench.journey.descriptionUnconfirmed":
    "Aktuelle Anwendung der Beschreibung ist nicht bestätigt",
  "codingWorkbench.journey.completeness.complete": "Vollständigkeit: vollständig",
  "codingWorkbench.journey.completeness.partial":
    "Vollständigkeit: teilweise. Einige Änderungsdetails konnten nicht beschrieben werden.",
  "codingWorkbench.journey.completeness.fallback":
    "Vollständigkeit: Ersatz. Die Beschreibung verwendet eine eingeschränkte Ersatzzusammenfassung.",
  "codingWorkbench.journey.remoteUnknown":
    "Aktuelle PR-, Review- und Issue-Fakten konnten nicht beobachtet werden.",
  "codingWorkbench.journey.review.approved": "Menschliches Review freigegeben",
  "codingWorkbench.journey.review.changes-requested": "Reviewer haben Änderungen angefordert",
  "codingWorkbench.journey.review.review-required": "Menschliches Review erforderlich",
  "codingWorkbench.journey.review.unknown": "Menschlicher Review-Status unbekannt",
  "codingWorkbench.journey.conversations": "Review-Unterhaltungen",
  "codingWorkbench.journey.conversationCounts":
    "{unresolved} ungelöst · {resolved} gelöst · {total} insgesamt",
  "codingWorkbench.journey.merge": "Beobachteter Merge-Zeitpunkt",
  "codingWorkbench.journey.notMerged": "Merge nicht beobachtet",
  "codingWorkbench.journey.issueState": "Beobachteter Issue-Status",
  "codingWorkbench.journey.issue.open": "Issue offen",
  "codingWorkbench.journey.issue.closed": "Issue geschlossen",
  "codingWorkbench.journey.closedAt": "Beobachteter Issue-Abschlusszeitpunkt",
  "codingWorkbench.journey.reason.ready-approval-required":
    "Die beobachtete Revision kann zur einmaligen Freigabe der Review-Bereitschaft vorgeschlagen werden.",
  "codingWorkbench.journey.reason.technical-ready":
    "Die technische Arbeit ist bereit; Review- und Merge-Anforderungen bleiben getrennt.",
  "codingWorkbench.journey.reason.human-review-ready":
    "Der beobachtete PR ist bereit für menschliches Review.",
  "codingWorkbench.journey.reason.required-reviews-missing":
    "Erforderliche menschliche Freigaben fehlen noch.",
  "codingWorkbench.journey.reason.changes-requested":
    "Angeforderte Review-Änderungen sind noch offen.",
  "codingWorkbench.journey.reason.unresolved-conversations":
    "Die verbleibenden Review-Unterhaltungen müssen geklärt werden.",
  "codingWorkbench.journey.reason.review-visibility-unknown":
    "Die Review-Sichtbarkeit ist unvollständig; die Review-Bereitschaft ist daher unbekannt.",
  "codingWorkbench.journey.reason.issue-closure-pending":
    "Der Merge wurde beobachtet, aber das gebundene Issue ist noch offen.",
  "codingWorkbench.journey.reason.merge-and-closure-observed":
    "Sowohl der PR-Merge als auch der Abschluss des gebundenen Issues wurden beobachtet.",
  "codingWorkbench.journey.reason.closed-unmerged":
    "Der PR wurde ohne beobachteten Merge geschlossen.",
  "codingWorkbench.journey.reason.issue-closed-without-merge":
    "Das Issue wurde ohne beobachteten PR-Merge geschlossen.",
  "codingWorkbench.journey.reason.retargeted":
    "Das PR-Ziel entspricht nicht mehr dem akzeptierten Standardbranch.",
  "codingWorkbench.journey.reason.head-changed":
    "Der PR-Stand hat sich seit der akzeptierten Lieferung geändert.",
  "codingWorkbench.journey.reason.readiness-unavailable":
    "Die CI-Bereitschaft wurde nicht bestätigt.",
  "codingWorkbench.journey.reason.readiness-stale": "Aktualisiere die veraltete CI-Beobachtung.",
  "codingWorkbench.journey.reason.checks-not-ready":
    "Erforderliche technische Prüfungen sind noch nicht bereit.",
  "codingWorkbench.journey.reason.description-unavailable":
    "Die angewendete PR-Beschreibung wurde nicht beobachtet.",
  "codingWorkbench.journey.reason.description-stale":
    "Die Beschreibung hat keine aktuelle Revisionsbestätigung mehr.",
  "codingWorkbench.journey.reason.description-not-applied":
    "Die ausgewählte Beschreibung wurde im PR-Text noch nicht bestätigt.",
  "codingWorkbench.journey.reason.provider-unavailable":
    "Provider-Fakten konnten nicht bestätigt werden.",
  "codingWorkbench.journey.reason.authority-denied":
    "Die aktuelle Berechtigung erlaubt diesen Übergabeschritt nicht.",
  "codingWorkbench.journey.reason.observation-superseded":
    "Eine neuere Beobachtung hat diese Statusabfrage ersetzt.",
  "codingWorkbench.journey.reason.cancelled": "Der Übergabeschritt wurde abgebrochen.",
  "codingWorkbench.journey.reason.ready-effect-uncertain":
    "Der Bereitschaftswechsel konnte nicht bestätigt werden. Aktualisiere den Status zum Abgleich mit dem tatsächlichen PR-Zustand.",
  "codingWorkbench.ci.title": "CI-Status",
  "codingWorkbench.ci.state.technical-ready": "Technische Prüfungen bestanden",
  "codingWorkbench.ci.state.pending": "CI-Prüfungen ausstehend",
  "codingWorkbench.ci.state.failed": "CI-Prüfungen fehlgeschlagen",
  "codingWorkbench.ci.state.blocked": "CI-Beobachtung blockiert",
  "codingWorkbench.ci.state.unknown": "CI-Status unbekannt",
  "codingWorkbench.ci.state.stale": "CI-Beobachtung ist veraltet",
  "codingWorkbench.ci.state.unobserved": "Noch keine CI-Beobachtung",
  "codingWorkbench.ci.help":
    "Technische Prüfungen, Entwurfsstatus und menschliches Review sind getrennt. Diese Beobachtung erlaubt keinen Merge.",
  "codingWorkbench.ci.staleHelp":
    "Historische Beobachtung. Eine neue Beobachtung in einem aktiven Lauf muss die aktuellen Prüfungen bestätigen.",
  "codingWorkbench.ci.required": "Erforderliche Prüfungen",
  "codingWorkbench.ci.advisory": "Informative Prüfungen",
  "codingWorkbench.ci.count.total": "Gesamt",
  "codingWorkbench.ci.count.passed": "Bestanden",
  "codingWorkbench.ci.count.failed": "Fehlgeschlagen",
  "codingWorkbench.ci.count.pending": "Ausstehend",
  "codingWorkbench.ci.count.blocked": "Blockiert",
  "codingWorkbench.ci.count.unknown": "Unbekannt",
  "codingWorkbench.ci.head": "Beobachteter Commit",
  "codingWorkbench.ci.observedAt": "Beobachtet am",
  "codingWorkbench.ci.expiresAt": "Gültig bis",
  "codingWorkbench.ci.completeness": "Beobachtungsumfang",
  "codingWorkbench.ci.complete": "Vollständig",
  "codingWorkbench.ci.incomplete": "Unvollständig — CI-Status kann nicht bestätigt werden",
  "codingWorkbench.ci.pullRequest": "Pull Request",
  "codingWorkbench.ci.draft": "Entwurfsstatus",
  "codingWorkbench.ci.isDraft": "Pull-Request-Entwurf",
  "codingWorkbench.ci.notDraft": "Kein Entwurf",
  "codingWorkbench.ci.humanReview": "Menschliches Review",
  "codingWorkbench.ci.reviewUnknown": "Review-Sichtbarkeit ist unbekannt",
  "codingWorkbench.ci.reviewCounts":
    "{approved} genehmigt · {required} erforderlich · {changes} Änderungswünsche",
  "codingWorkbench.ci.pr.open": "Offen",
  "codingWorkbench.ci.pr.closed": "Geschlossen",
  "codingWorkbench.ci.pr.merged": "Zusammengeführt",
  "codingWorkbench.ci.conflict": "Merge-Konflikte",
  "codingWorkbench.ci.conflict.clear": "Kein beobachteter Konflikt",
  "codingWorkbench.ci.conflict.conflicting": "Konflikte müssen behoben werden",
  "codingWorkbench.ci.conflict.unknown": "Konfliktstatus unbekannt",
  "codingWorkbench.ci.baseCurrency": "Basisrevision",
  "codingWorkbench.ci.base.current": "Aktuell",
  "codingWorkbench.ci.base.behind": "Hinter dem Basisbranch",
  "codingWorkbench.ci.base.unknown": "Aktualität der Basis unbekannt",
  "codingWorkbench.ci.reason.required-checks-passed":
    "Die beobachteten erforderlichen Prüfungen wurden bestanden.",
  "codingWorkbench.ci.reason.required-checks-pending":
    "Erforderliche Prüfungen sind noch nicht abgeschlossen.",
  "codingWorkbench.ci.reason.required-checks-failed":
    "Erforderliche Prüfungen haben Fehler gemeldet.",
  "codingWorkbench.ci.reason.required-checks-blocked":
    "Erforderliche Prüfungen können nicht fortgesetzt werden.",
  "codingWorkbench.ci.reason.required-checks-unknown":
    "Ergebnisse erforderlicher Prüfungen sind unvollständig oder unbekannt.",
  "codingWorkbench.ci.reason.pull-request-closed": "Der Pull Request ist nicht mehr offen.",
  "codingWorkbench.ci.reason.merge-conflict": "Die beobachtete Revision hat Merge-Konflikte.",
  "codingWorkbench.ci.reason.base-outdated": "Der Basisbranch hat sich geändert.",
  "codingWorkbench.ci.reason.merge-context-unknown":
    "Der aktuelle Merge-Kontext konnte nicht bestätigt werden.",
  "codingWorkbench.ci.reason.repair-budget-exhausted":
    "Das Budget zur CI-Reparatur ist ausgeschöpft.",
  "codingWorkbench.ci.reason.authority-denied":
    "Die aktuelle Berechtigung erlaubt diese Beobachtung nicht.",
  "codingWorkbench.ci.reason.auth-required": "Eine GitHub-Authentifizierung ist erforderlich.",
  "codingWorkbench.ci.reason.invalid-binding":
    "Die akzeptierte Pull-Request-Bindung konnte nicht bestätigt werden.",
  "codingWorkbench.ci.reason.cancelled": "Die Beobachtung wurde abgebrochen.",
  "codingWorkbench.ci.reason.provider-forbidden":
    "Der Anbieter hat das Lesen dieser Prüfungen nicht erlaubt.",
  "codingWorkbench.ci.reason.provider-not-found":
    "Der Anbieter konnte den angeforderten Prüfungskontext nicht bereitstellen.",
  "codingWorkbench.ci.reason.rate-limited": "Der Anbieter hat Anfragen vorübergehend begrenzt.",
  "codingWorkbench.ci.reason.provider-unavailable":
    "Der Anbieter ist vorübergehend nicht verfügbar.",
  "codingWorkbench.ci.reason.timeout": "Das Zeitlimit der Beobachtung wurde erreicht.",
  "codingWorkbench.ci.reason.pagination-exhausted": "Die Beobachtung hat ihr Seitenlimit erreicht.",
  "codingWorkbench.ci.reason.output-truncated": "Die Beobachtung hat ihr Ausgabelimit erreicht.",
  "codingWorkbench.ci.reason.malformed-response":
    "Die Antwort des Anbieters konnte nicht validiert werden.",
  "codingWorkbench.ci.reason.visibility-unknown":
    "Die Sichtbarkeit erforderlicher Prüfungen konnte nicht bestätigt werden.",
  "codingWorkbench.ci.reason.requirements-ambiguous":
    "Die erforderlichen Prüfungen konnten nicht eindeutig bestimmt werden.",
  "codingWorkbench.ci.reason.revision-changed":
    "Die Pull-Request-Revision hat sich während der Beobachtung geändert.",

  "codingWorkbench.status.checking": "Prüfe",
  "codingWorkbench.header.eyebrow": "Coding",
  "codingWorkbench.header.summary":
    "Starte und beaufsichtige einen gesteuerten Coding-Lauf. Autorität und Ergebnisse bleiben serverseitig.",
  "codingWorkbench.mode.eyebrow": "Autonomie",
  "codingWorkbench.mode.unconfirmed": "Warten auf Serverbestätigung",
  "codingWorkbench.mode.governed-assist.label": "Um Genehmigung bitten",
  "codingWorkbench.mode.governed-assist.description":
    "Lese- und Planungsvorgänge werden ausgeführt; Bearbeitungen im Arbeitsbereich, Befehle, der Zugriff auf externe Dateien und die Internetnutzung erfordern eine Genehmigung. Die Auslieferung bleibt separat menschlich genehmigt.",
  "codingWorkbench.mode.supervised-coding.label": "Überwachter Workspace",
  "codingWorkbench.mode.supervised-coding.description":
    "Routinemäßige Bearbeitungen im Arbeitsbereich mit niedrigem und mittlerem Risiko, geprüfte Befehle und Verifizierungen werden ausgeführt; der Zugriff auf externe Dateien und die Internetnutzung erfordern eine Genehmigung. Die Auslieferung bleibt separat menschlich genehmigt.",
  "codingWorkbench.mode.autonomous-delivery.label": "Vollzugriff",
  "codingWorkbench.mode.autonomous-delivery.description":
    "Datei- und Internetvorgänge innerhalb des validierten Authority Envelope werden ohne Genehmigung pro Aktion ausgeführt. Die Auslieferung bleibt separat menschlich genehmigt.",
  "codingWorkbench.task.eyebrow": "Aufgabe",
  "codingWorkbench.task.title": "Begrenzte Coding-Aufgabe beschreiben",
  "codingWorkbench.task.instructions": "Aufgabenanweisungen",
  "codingWorkbench.task.placeholder":
    "Bitte Keiko, etwas in diesem Repository zu prüfen, zu erklären, umzusetzen, zu testen oder zu reparieren…",
  "codingWorkbench.task.help":
    "Aufgabentext ist eine flüchtige Absicht. Start wird erst freigeschaltet, wenn alle Bereitschaftsprüfungen bestätigt sind.",
  "codingWorkbench.task.starting": "Wird gestartet…",
  "codingWorkbench.task.start": "Coding-Lauf starten",
  "codingWorkbench.composer.pause": "Lauf pausieren",
  "codingWorkbench.composer.resume": "Lauf fortsetzen",
  "codingWorkbench.composer.send": "Rückfrage senden",
  "codingWorkbench.composer.model.label": "Coding-Modell",
  "codingWorkbench.composer.model.menu": "Coding-Modell auswählen",
  "codingWorkbench.composer.model.none": "Kein Coding-Modell verfügbar",
  "codingWorkbench.composer.source.label": "Modellquelle",
  "codingWorkbench.composer.source.menu": "Modellquelle auswählen",
  "codingWorkbench.composer.effort.label": "Reasoning-Stufe",
  "codingWorkbench.composer.effort.menu": "Reasoning-Stufe auswählen",
  "codingWorkbench.composer.effort.minimal": "Minimal",
  "codingWorkbench.composer.effort.low": "Niedrig",
  "codingWorkbench.composer.effort.medium": "Mittel",
  "codingWorkbench.composer.effort.high": "Hoch",
  "codingWorkbench.composer.effort.xhigh": "Extra hoch",
  "codingWorkbench.composer.authority.label": "Rechte für diesen Lauf",
  "codingWorkbench.composer.authority.menu": "Rechte auswählen",
  "codingWorkbench.composer.authority.error.hydrate":
    "Die Rechte konnten nicht geladen werden. „Um Genehmigung bitten“ bleibt ausgewählt.",
  "codingWorkbench.composer.authority.error.persist":
    "Die Rechte konnten nicht gespeichert werden. Die vorherige Auswahl bleibt aktiv.",
  "codingWorkbench.composer.context.label": "Coding-Kontext",
  "codingWorkbench.composer.repository.open": "Repository {repository} in Git verwalten",
  "codingWorkbench.composer.branch.open": "Branch {branch} in Git verwalten",
  "codingWorkbench.composer.projectMemory.label": "MemoriaViva",
  "codingWorkbench.composer.projectMemory.help":
    "MemoriaViva verwendet in der Coding Workbench ausschließlich das aktive Projekt-Memory.",
  "codingWorkbench.composer.help":
    "Pausieren Sie den aktiven Lauf, um eine Rückfrage zu senden. Ein entworfener Follow-up wird nur im pausierten Zustand zugelassen und niemals in eine Warteschlange gestellt.",
  "codingWorkbench.composer.workspaceMismatch":
    "Dieser Lauf behält die Autorität des Arbeitsbereichs, in dem er gestartet wurde; dieser ist nicht mehr der aktive. Chips, Git und die Änderungen des Laufs bleiben bei seinem Arbeitsbereich. Wechseln Sie zurück, um diese Dateien zu prüfen oder zu bearbeiten.",
  "codingWorkbench.editorBridge.reconnecting":
    "Bearbeitungen sind pausiert: Die Editor-Bridge wird neu verbunden.",
  "codingWorkbench.questions.sectionLabel": "Laufzeitfragen",
  "codingWorkbench.questions.eyebrow": "Eingabe erforderlich",
  "codingWorkbench.questions.title": "Laufzeitfragen",
  "codingWorkbench.questions.help":
    "Der Lauf bleibt pausiert, bis Sie antworten oder ablehnen. Fragetext ist flüchtig und wird niemals gespeichert.",
  "codingWorkbench.questions.ready": "{count} Fragesatz wartet auf Ihre Eingabe.",
  "codingWorkbench.questions.loading": "Suche nach Laufzeitfragen…",
  "codingWorkbench.questions.empty": "Keine ausstehenden Laufzeitfragen.",
  "codingWorkbench.questions.offline": "Der Fragedienst ist offline.",
  "codingWorkbench.questions.error": "Fragen konnten nicht aktualisiert werden.",
  "codingWorkbench.questions.stale": "Fragestatus geändert. Erneut prüfen, um fortzufahren.",
  "codingWorkbench.questions.submitting": "Ihre Antwort wird übermittelt…",
  "codingWorkbench.questions.terminal": "Der Coding-Lauf ist beendet.",
  "codingWorkbench.questions.unpaired":
    "Dieses Fenster ist nicht für Frageinhalte gekoppelt. Starten Sie Keiko über den Launcher neu, um eine neue App-Sitzung zu koppeln.",
  "codingWorkbench.pairing.unpaired": "Workbench nicht gekoppelt. Keiko über den Launcher öffnen.",
  "codingWorkbench.questions.answerFailed":
    "Ihre Antwort wurde nicht angenommen ({code}). Die Frage ist weiterhin offen — senden Sie sie erneut.",
  "codingWorkbench.questions.answerRejected":
    "Wählen Sie für jede Frage eine der aufgeführten Optionen. Geben Sie freien Text nur ein, wenn eine eigene Antwort angeboten wird. Die Frage ist weiterhin offen ({code}).",
  "codingWorkbench.questions.rejectFailed":
    "Das Ablehnen der Frage wurde nicht angenommen ({code}). Die Frage ist weiterhin offen — versuchen Sie es erneut.",
  "codingWorkbench.questions.retry": "Erneut prüfen",
  "codingWorkbench.questions.requestTitle": "Die Laufzeit benötigt Ihre Eingabe",
  "codingWorkbench.questions.required": "Beantworten Sie jede Frage vor dem Senden.",
  "codingWorkbench.questions.answer": "Antwort senden",
  "codingWorkbench.questions.reject": "Frage ablehnen",
  "codingWorkbench.questions.multipleHint": "Alle zutreffenden auswählen.",
  "codingWorkbench.questions.customLabel": "Eigene Antwort für {header}",
  "codingWorkbench.setup.eyebrow": "Workspace",
  "codingWorkbench.setup.title": "Code-Einrichtung",
  "codingWorkbench.setup.help":
    "Binde einen vorhandenen lokalen Git-Checkout, damit der Coding-Lauf in einem gesteuerten Aufgabenarbeitsbereich startet.",
  "codingWorkbench.setup.repositoryPath": "Repository-Pfad",
  "codingWorkbench.setup.repositoryPathPlaceholder": "/absoluter/pfad/zum/repository",
  "codingWorkbench.setup.targetBranch": "Zielbranch",
  "codingWorkbench.setup.targetBranchPlaceholder": "main",
  "codingWorkbench.setup.submit": "Workspace binden",
  "codingWorkbench.setup.binding": "Wird gebunden…",
  "codingWorkbench.setup.verifying": "Wird verifiziert…",
  "codingWorkbench.setup.reconcileFailed":
    "Der Workspace konnte nicht verifiziert werden. Die Reconciliation hat keinen sauberen, passenden Checkout bestätigt, daher bleibt der Lauf nicht verfügbar. Prüfe das Repository und versuche es erneut.",
  "codingWorkbench.setup.branchConflict":
    "Der Aufgabenbranch für diesen Coding-Lauf existiert bereits. Entferne den früheren Branch oder den zugehörigen verwalteten Arbeitsbereich. Alternativ kannst du einen anderen Zielbranch wählen.",
  "codingWorkbench.setup.invalidBaseBranch":
    "Der Zielbranch existiert in diesem Repository nicht. Gib einen lokal auflösbaren Branch an, zum Beispiel den ausgecheckten Branch.",
  "codingWorkbench.setup.missingRepository":
    "Der Repository-Pfad liegt in keinem lokalen Git-Repository. Gib den Pfad eines vorhandenen Checkouts an.",
  "codingWorkbench.setup.unsafePath":
    "Der Repository-Pfad liegt außerhalb der Ordner, die diese Installation binden darf. Wähle einen Ordner innerhalb eines erlaubten Workspace-Roots.",
  "codingWorkbench.setup.lockContention":
    "Eine andere Aktion hält diesen Task Workspace gerade. Warte einen Moment und versuche es dann erneut.",
  "codingWorkbench.setup.provisioningUnavailable":
    "Verwaltete Task Workspaces sind auf dieser Installation nicht konfiguriert, daher kann kein Workspace gebunden werden.",
  "codingWorkbench.setup.repairRequired":
    "Für dieses Repository und diesen Branch existiert bereits ein verwalteter Workspace, den Keiko nicht erneut verifizieren konnte: {finding}. Die Reparatur {effect}. Keiko kann den ursprünglichen Worktree nicht von einem Ersatz am selben Pfad unterscheiden; die Freigabe registriert also, was dort auf der Festplatte liegt — prüfe den Worktree zuerst unter „Task Workspaces“, wenn seine Herkunft unklar ist.",
  "codingWorkbench.setup.repairEffect.reconcilePointer":
    "registriert den vorhandenen Worktree an Ort und Stelle neu; nichts wird gelöscht",
  "codingWorkbench.setup.repairEffect.recreateWorktree":
    "entfernt die veraltete Worktree-Registrierung und baut den Worktree aus seinem Aufgabenbranch neu auf; committete Arbeit auf dem Branch bleibt erhalten",
  "codingWorkbench.setup.repairEffect.releaseStaleLock":
    "gibt die veraltete Sperre einer abgebrochenen Aktion frei; der Worktree bleibt unberührt",
  "codingWorkbench.setup.repairEffect.acceptMovedHead":
    "übernimmt den aktuellen Commit des Worktrees als verifizierten HEAD; HEAD wurde außerhalb von Keiko bewegt, und weder das Repository noch die Festplatte werden verändert",
  "codingWorkbench.setup.repairEffect.generic":
    "wendet die von Keiko für diesen Befund empfohlene Wiederherstellungsstrategie an",
  "codingWorkbench.setup.boundRefreshFailed":
    "Der Workspace wurde gebunden, aber diese Ansicht konnte nicht aktualisiert werden. Öffne „Task Workspaces“ und nutze „Aktualisieren“.",
  "codingWorkbench.setup.operatorRequired":
    "Für dieses Repository und diesen Branch existiert bereits ein verwalteter Workspace, den Keiko nicht automatisch reparieren kann: {finding}. Prüfe ihn im Task-Workspaces-Panel und versuche es dann erneut.",
  "codingWorkbench.setup.repairFailed":
    "Die Reparatur wurde nicht abgeschlossen. Aktualisiere die Task Workspaces und versuche es erneut.",
  "codingWorkbench.setup.findingUnknown": "sein Zustand konnte nicht erneut verifiziert werden",
  "codingWorkbench.setup.repairAndBind": "Reparieren und binden",
  "codingWorkbench.setup.repairing": "Wird repariert…",
  "codingWorkbench.setup.runtimeUnavailable":
    "Das Starten eines Coding-Laufs ist auf dieser Installation nicht verfügbar, bis die Coding-Runtime aktiv ist. Du kannst jetzt einen Workspace binden; der Lauf wird startbar, sobald die Runtime bestätigt ist.",
  "codingWorkbench.setup.runtimeEvaluation":
    "Diese Installation nutzt eine ungeprüfte Evaluations-Runtime. Sie trägt keine Apple- oder Microsoft-Codesignatur und läuft unter macOS ohne die Endpoint-Security-Eingrenzung eines Release-Builds. Die Integrität ihrer Nutzdaten wird bei jedem Start weiterhin Byte für Byte geprüft.",
  "codingWorkbench.readiness.modelSource.label": "Modellquelle",
  "codingWorkbench.readiness.modelSource.select": "Verfügbare Quelle auswählen",
  "codingWorkbench.readiness.workspace.label": "Aufgabenarbeitsbereich",
  "codingWorkbench.readiness.workspace.none": "Kein aktiver Aufgabenarbeitsbereich",
  "codingWorkbench.readiness.eventStream.label": "Ereignisstrom",
  "codingWorkbench.readiness.runtime.label": "Coding-Runtime",
  "codingWorkbench.readiness.runtime.pending": "Coding-Runtime wird geprüft…",
  "codingWorkbench.readiness.runtime.verified":
    "Plattformgeprüft — signierte und notarisierte Runtime",
  "codingWorkbench.readiness.runtime.evaluation":
    "Ungeprüfte Evaluations-Runtime — ohne Plattformsignatur",
  "codingWorkbench.readiness.runtime.unavailable": "Coding-Runtime nicht verfügbar",
  "codingWorkbench.timeline.eyebrow": "Verlauf",
  "codingWorkbench.timeline.title": "Aktivität",
  "codingWorkbench.timeline.empty": "Noch keine Aktivität.",
  "codingWorkbench.timeline.instructions":
    "Zeitleiste fokussieren und dann mit Pfeil- oder Bild-auf- und Bild-ab-Tasten scrollen.",
  "codingWorkbench.timeline.listLabel": "Coding-Lauf-Ereigniszeitleiste",
  "codingWorkbench.changes.eyebrow": "Dateien",
  "codingWorkbench.changes.title": "Änderungen",
  "codingWorkbench.changes.help": "Geänderte Dateien erscheinen hier.",
  "codingWorkbench.changes.idle": "Starte einen Lauf, um seine Workspace-Änderungen zu prüfen.",
  "codingWorkbench.changes.loading": "Neueste begrenzte Änderungen werden geladen…",
  "codingWorkbench.changes.bindingLost":
    "Die Aufgaben-Workspace-Bindung des Laufs ist nicht mehr verfügbar. Es wird kein Diff angezeigt.",
  "codingWorkbench.changes.unavailable":
    "Änderungen sind nicht verfügbar. Die App-Sitzung muss möglicherweise erneut gekoppelt werden; es wird kein veraltetes Diff angezeigt.",
  "codingWorkbench.changes.unpaired":
    "Browserfenster nicht gekoppelt — öffnen Sie Keiko über den Launcher, um den Aufgaben-Workspace dieses Laufs zu lesen. Es wird kein Diff angezeigt.",
  "codingWorkbench.changes.error":
    "Änderungen konnten nicht aktualisiert werden. Es wird kein veraltetes Diff angezeigt.",
  "codingWorkbench.changes.retry": "Änderungen aktualisieren",
  "codingWorkbench.changes.asOf": "Stand {head}",
  "codingWorkbench.changes.empty":
    "Dieser Lauf enthält in dieser Revision keine Workspace-Änderungen.",
  "codingWorkbench.changes.changedFiles": "Geänderte Dateien ({count})",
  "codingWorkbench.changes.virtualInstructions":
    "Liste der geänderten Dateien fokussieren und dann mit Pfeil- oder Bild-auf- und Bild-ab-Tasten scrollen.",
  "codingWorkbench.changes.filesTruncated":
    "Die Liste der geänderten Dateien hat das Serverlimit erreicht. Nur das begrenzte Präfix wird angezeigt.",
  "codingWorkbench.changes.fileState.conflicted": "Mit Konflikt",
  "codingWorkbench.changes.fileState.untracked": "Nicht versioniert",
  "codingWorkbench.changes.fileState.stagedAndUnstaged": "Vorgemerkt und nicht vorgemerkt",
  "codingWorkbench.changes.fileState.staged": "Vorgemerkt",
  "codingWorkbench.changes.fileState.unstaged": "Nicht vorgemerkt",
  "codingWorkbench.changes.diff.title": "Diff der ausgewählten Datei",
  "codingWorkbench.changes.diff.region": "Laufbezogenes Datei-Diff",
  "codingWorkbench.changes.diff.loading": "Diff der ausgewählten Datei wird geladen…",
  "codingWorkbench.changes.diff.empty": "Für diese geänderte Datei ist kein Text-Diff verfügbar.",
  "codingWorkbench.changes.diff.error":
    "Das Diff der ausgewählten Datei ist nicht verfügbar. Es wird kein veraltetes Diff angezeigt.",
  "codingWorkbench.changes.diff.truncated":
    "Dieses begrenzte Datei-Diff ist unvollständig, weil es das Serverlimit erreicht hat.",
  "codingWorkbench.changes.diff.addedLine": "Hinzugefügte Zeile",
  "codingWorkbench.changes.diff.deletedLine": "Gelöschte Zeile",
  "codingWorkbench.changes.diff.contextLine": "Kontextzeile",
  "codingWorkbench.changes.diff.metadataLine": "Diff-Metadaten",
  "codingWorkbench.changes.diff.hunkHeader": "Hunk-Kopfzeile",
  "codingWorkbench.changes.diff.hunkTruncated":
    "Dieser Hunk ist unvollständig, weil das begrenzte Diff gekürzt wurde.",
  "codingWorkbench.changes.diff.fileTruncated":
    "Dieses Datei-Diff ist unvollständig, weil das begrenzte Diff gekürzt wurde.",
  "codingWorkbench.changes.diff.binaryFile": "Binärdatei — kein Text-Diff verfügbar.",
  "codingWorkbench.changes.diff.previousPath": " (zuvor {path})",
  "codingWorkbench.changes.diff.elevatedReview": "Erweiterte Prüfung",
  "codingWorkbench.activity.reasoningBoundary":
    "Diese Zeitleiste zeigt beobachtbare Konversation und Arbeitsaktivität. Private Gedankengänge werden niemals offengelegt.",
  "codingWorkbench.activity.status.idle": "Noch kein Lauf gestartet.",
  "codingWorkbench.activity.status.loading": "Aktivität wird verbunden…",
  "codingWorkbench.activity.status.live": "Live.",
  "codingWorkbench.activity.status.paused": "Pausiert.",
  "codingWorkbench.activity.status.recovery": "Eingriff erforderlich.",
  "codingWorkbench.activity.status.ended": "Lauf beendet.",
  "codingWorkbench.activity.status.unavailable": "Aktivität nicht verbunden.",
  "codingWorkbench.activity.status.disconnected": "Verbindung getrennt.",
  "codingWorkbench.activity.status.offline": "Aktivität offline.",
  "codingWorkbench.activity.status.error": "Aktivität nicht verfügbar.",
  "codingWorkbench.activity.retry": "Aktivität erneut verbinden",
  "codingWorkbench.activity.truncated": "Aktivität gekürzt.",
  "codingWorkbench.activity.dropped": "{count} Aktualisierung(en) ausgelassen.",
  "codingWorkbench.activity.truncationMark": "Ausgabe gekürzt",
  "codingWorkbench.activity.role.user": "Du",
  "codingWorkbench.activity.role.assistant": "Coding-Agent",
  "codingWorkbench.activity.tool": "Tool-Aktivität: {tool}",
  "codingWorkbench.activity.toolState.pending": "Ausstehend",
  "codingWorkbench.activity.toolState.running": "Wird ausgeführt",
  "codingWorkbench.activity.toolState.succeeded": "Erfolgreich",
  "codingWorkbench.activity.toolState.failed": "Fehlgeschlagen",
  "codingWorkbench.activity.toolState.denied": "Abgelehnt",
  "codingWorkbench.activity.toolState.cancelled": "Abgebrochen",
  "codingWorkbench.activity.plan.title": "Aktueller Plan",
  "codingWorkbench.activity.plan.truncated": "Ein Teil dieses Plans wurde ausgelassen.",
  "codingWorkbench.activity.planState.pending": "Ausstehend",
  "codingWorkbench.activity.planState.active": "In Bearbeitung",
  "codingWorkbench.activity.planState.completed": "Abgeschlossen",
  "codingWorkbench.activity.planState.cancelled": "Abgebrochen",
  "codingWorkbench.source.gateway.label": "Keiko Gateway",
  "codingWorkbench.source.codex.label": "ChatGPT/Codex-Abonnement",
  "codingWorkbench.source.unavailableReason.missing-config":
    "Es ist kein Gateway konfiguriert. Konfiguriere das Keiko Gateway unter Einstellungen → Modelle.",
  "codingWorkbench.source.unavailableReason.missing-provider":
    "Die Gateway-Konfiguration nennt keinen Modellanbieter. Ergänze einen unter Einstellungen → Modelle.",
  "codingWorkbench.source.unavailableReason.missing-credentials":
    "Der konfigurierte Anbieter hat keine Zugangsdaten. Aktualisiere sie unter Einstellungen → Modelle.",
  "codingWorkbench.source.unavailableReason.non-chat":
    "Kein konfiguriertes Modell ist ein Chat-Modell. Ergänze ein chatfähiges Modell unter Einstellungen → Modelle.",
  "codingWorkbench.source.unavailableReason.no-tool-calling":
    "Für kein Chat-Modell ist Tool-Calling verifiziert. Führe den Readiness-Check unter Einstellungen → Modelle aus und übernimm die verifizierten Werte.",
  "codingWorkbench.source.unavailableReason.non-workflow-eligible":
    "Das Chat-Modell mit Tool-Calling ist nicht workflow-fähig. Aktiviere die Workflow-Eignung unter Einstellungen → Modelle.",
  "codingWorkbench.source.unavailableReason.non-coding-capable":
    "Das konfigurierte Chat-Modell ist nicht codingfähig.",
  "codingWorkbench.source.unavailableReason.deployment-policy-disabled":
    "Die Bereitstellungsrichtlinie deaktiviert die Gateway-Quelle der Coding-Runtime.",
  "codingWorkbench.source.unavailableReason.subscription-source":
    "Die Abo-Quelle ist ausgewählt; das Gateway wird nicht verwendet.",
  "codingWorkbench.source.unavailableReason.model-context-window-insufficient":
    "Das Kontextfenster des konfigurierten Modells ist für einen Coding-Lauf zu klein (mindestens 32.000 Tokens). Vergrößere das Kontextfenster des Modells oder wähle unter Einstellungen → Modelle ein größeres Modell.",
  "codingWorkbench.modelSource.gateway": "Keiko Gateway",
  "codingWorkbench.modelSource.openaiGateway": "OpenAI über Gateway",
  "codingWorkbench.modelSource.codexSubscription": "ChatGPT/Codex-Abonnement",
  "codingWorkbench.auth.label": "Abonnementauthentifizierung",
  "codingWorkbench.auth.cardTitle": "Beim Codex-Abonnement anmelden",
  "codingWorkbench.auth.cardHelp":
    "Ein Coding-Lauf über das ChatGPT/Codex-Abonnement kann erst starten, wenn diese Installation angemeldet ist. Aktualisiere den Status nach der Anmeldung oder bereite unten eine serverseitig freigegebene Einrichtungsmethode vor.",
  "codingWorkbench.auth.refresh": "Authentifizierung aktualisieren",
  "codingWorkbench.auth.setupMethods": "Servergenehmigte Einrichtungsmethoden",
  "codingWorkbench.auth.setupMethodsGroup": "Codex-Authentifizierungseinrichtungsmethoden",
  "codingWorkbench.auth.preparing": "Wird vorbereitet…",
  "codingWorkbench.auth.prepare": "{method} vorbereiten",
  "codingWorkbench.auth.noMethod": "Für diese Umgebung ist keine Einrichtungsmethode genehmigt.",
  "codingWorkbench.auth.setupUnavailable":
    "Der Einrichtungsplan ist nicht verfügbar. Wähle eine genehmigte Methode zum erneuten Versuch.",
  "codingWorkbench.auth.planReady": "Einrichtungsplan bereit",
  "codingWorkbench.auth.planDetail": "{method} · Befehl: {command} · Geheimeingabe: {secretInput}.",
  "codingWorkbench.auth.secretRequired": "über verwaltete Standardeingabe erforderlich",
  "codingWorkbench.auth.secretNotRequired": "nicht erforderlich",
  "codingWorkbench.auth.planHelp":
    "Die verwaltete Runtime-Anmeldefähigkeit ist in diesem Build nicht verfügbar. Dieser Browser bereitet nur den inhaltsfreien Einrichtungsplan vor und startet niemals den Befehl.",
  "codingWorkbench.auth.method.browser": "Browser-Anmeldung",
  "codingWorkbench.auth.method.deviceCode": "Gerätecode-Anmeldung",
  "codingWorkbench.auth.method.accessToken": "Zugriffstoken-Anmeldung",
  "codingWorkbench.auth.status.connected": "Verbunden",
  "codingWorkbench.auth.status.required": "Anmeldung erforderlich",
  "codingWorkbench.auth.status.expired": "Sitzung abgelaufen",
  "codingWorkbench.auth.status.revoked": "Sitzung widerrufen",
  "codingWorkbench.auth.status.failedLogin": "Vorherige Anmeldung fehlgeschlagen",
  "codingWorkbench.auth.status.disabledDeployment": "Durch Bereitstellung deaktiviert",
  "codingWorkbench.auth.status.unavailableEnvironment": "In dieser Umgebung nicht verfügbar",
  "codingWorkbench.auth.status.unavailableRelease": "In dieser Version nicht verfügbar",
  "codingWorkbench.auth.status.unavailable": "Authentifizierung nicht verfügbar",
  "codingWorkbench.controls.eyebrow": "Operatorsteuerung",
  "codingWorkbench.controls.title": "Anhalten oder übernehmen",
  "codingWorkbench.controls.stop": "Lauf anhalten",
  "codingWorkbench.controls.takeover": "Manuell übernehmen",
  "codingWorkbench.controls.help": "Auslieferungsaktionen bleiben separat menschlich genehmigt.",
  "codingWorkbench.controls.resumeMode.label": "Autonomie beim Fortsetzen",
  "codingWorkbench.controls.resumeMode.help":
    "Setze den Lauf mit dem serverbestätigten aktuellen oder einem strengeren Modus fort. Eine Erweiterung ist nicht verfügbar.",
  "codingWorkbench.approval.eyebrow": "Genehmigung erforderlich",
  "codingWorkbench.approval.title": "Begrenzte Aktion prüfen",
  "codingWorkbench.approval.facts": "Genehmigungsdetails",
  "codingWorkbench.approval.permissionKind": "Berechtigungsart",
  "codingWorkbench.approval.actionClass": "Aktionsklasse",
  "codingWorkbench.approval.action": "Aktion",
  "codingWorkbench.approval.scope": "Geltungsbereich",
  "codingWorkbench.approval.commandClass": "Befehlsklasse",
  "codingWorkbench.approval.connectorScopes": "Connector-Bereiche",
  "codingWorkbench.approval.risk": "Risiko",
  "codingWorkbench.approval.policyReason": "Richtliniengrund",
  "codingWorkbench.approval.reasonCode": "Grundcode",
  "codingWorkbench.approval.expires": "Läuft ab",
  "codingWorkbench.approval.notSpecified": "Nicht angegeben",
  "codingWorkbench.approval.notApplicable": "Nicht anwendbar",
  "codingWorkbench.approval.noneRequested": "Nicht angefordert",
  "codingWorkbench.approval.unspecified": "Nicht spezifiziert",
  "codingWorkbench.approval.kind.workspace-write": "Workspace-Schreibzugriff",
  "codingWorkbench.approval.kind.command-execution": "Befehlsausführung",
  "codingWorkbench.approval.kind.network-egress": "Ausgehender Netzwerkzugriff",
  "codingWorkbench.approval.kind.connector-access": "Connector-Zugriff",
  "codingWorkbench.approval.kind.delivery-substrate": "Auslieferung",
  "codingWorkbench.approval.actionClass.workspace-read": "Workspace-Lesezugriff",
  "codingWorkbench.approval.actionClass.workspace-write": "Workspace-Schreibzugriff",
  "codingWorkbench.approval.actionClass.command-execution": "Befehlsausführung",
  "codingWorkbench.approval.actionClass.verification": "Verifizierung",
  "codingWorkbench.approval.actionClass.connector-access": "Connector-Zugriff",
  "codingWorkbench.approval.actionClass.network-egress": "Ausgehender Netzwerkzugriff",
  "codingWorkbench.approval.actionClass.delivery-substrate": "Auslieferung",
  "codingWorkbench.approval.risk.low": "Niedrig",
  "codingWorkbench.approval.risk.medium": "Mittel",
  "codingWorkbench.approval.risk.high": "Hoch",
  "codingWorkbench.approval.risk.critical": "Kritisch",
  "codingWorkbench.approval.actionKind.file-edit": "Dateibearbeitung",
  "codingWorkbench.approval.actionKind.git-stage": "Änderungen vormerken",
  "codingWorkbench.approval.actionKind.verification-command": "Verifikationsbefehl",
  "codingWorkbench.approval.actionKind.research": "Recherche",
  "codingWorkbench.approval.actionKind.commit": "Commit",
  "codingWorkbench.approval.actionKind.push": "Push",
  "codingWorkbench.approval.actionKind.pull-request": "Pull Request",
  "codingWorkbench.approval.actionKind.merge": "Merge",
  "codingWorkbench.approval.actionKind.connector-write": "Schreibzugriff über Connector",
  "codingWorkbench.approval.actionKind.external-write": "Externer Schreibzugriff",
  "codingWorkbench.approval.actionKind.system-mutation": "Systemänderung",
  "codingWorkbench.approval.policyReason.scoped-file-edit":
    "Dateibearbeitung innerhalb des Aufgabenumfangs",
  "codingWorkbench.approval.policyReason.out-of-scope-file-edit":
    "Dateibearbeitung außerhalb des Aufgabenumfangs",
  "codingWorkbench.approval.policyReason.allowlisted-verification-command":
    "Freigegebener Verifikationsbefehl",
  "codingWorkbench.approval.policyReason.unknown-command-denied": "Unbekannter Befehl abgelehnt",
  "codingWorkbench.approval.policyReason.mutating-command-denied": "Verändernder Befehl abgelehnt",
  "codingWorkbench.approval.policyReason.approval-required": "Freigabe erforderlich",
  "codingWorkbench.approval.policyReason.approval-proof-missing": "Freigabenachweis fehlt",
  "codingWorkbench.approval.policyReason.approval-proof-stale": "Freigabenachweis veraltet",
  "codingWorkbench.approval.policyReason.approval-proof-accepted": "Freigabenachweis akzeptiert",
  "codingWorkbench.approval.policyReason.operator-denied": "Vom Operator abgelehnt",
  "codingWorkbench.approval.policyReason.operator-stopped": "Vom Operator gestoppt",
  "codingWorkbench.approval.policyReason.redacted-failure": "Fehler (Details redigiert)",
  "codingWorkbench.approval.connectorScope.source-control.read": "Quellcodeverwaltung (lesen)",
  "codingWorkbench.approval.connectorScope.source-control.write": "Quellcodeverwaltung (schreiben)",
  "codingWorkbench.approval.connectorScope.issue-tracker.read": "Issue-Tracker (lesen)",
  "codingWorkbench.approval.connectorScope.issue-tracker.write": "Issue-Tracker (schreiben)",
  "codingWorkbench.approval.connectorScope.knowledge-base.read": "Wissensbasis (lesen)",
  "codingWorkbench.approval.connectorScope.knowledge-base.write": "Wissensbasis (schreiben)",
  "codingWorkbench.approval.research.title": "Ziel der Recherche",
  "codingWorkbench.approval.research.host": "Öffentliche Domain",
  "codingWorkbench.approval.research.requestLine": "Angefragter Pfad und Suchtext",
  "codingWorkbench.approval.research.loading": "Ziel wird geladen …",
  "codingWorkbench.approval.research.unavailable":
    "Ziel nicht abrufbar. Fenster erneut koppeln, um es vor der Entscheidung zu sehen.",
  "codingWorkbench.approval.research.retry": "Ziel erneut laden",
  "codingWorkbench.draftDelivery.title": "Repository-Übermittlung",
  "codingWorkbench.draftDelivery.phase.push-proposed": "Push wartet auf Freigabe",
  "codingWorkbench.draftDelivery.phase.pushing": "Push läuft",
  "codingWorkbench.draftDelivery.phase.pushed": "Commit übertragen",
  "codingWorkbench.draftDelivery.phase.pr-proposed": "Pull-Request-Entwurf wartet auf Freigabe",
  "codingWorkbench.draftDelivery.phase.creating-pr": "Pull-Request-Entwurf wird erstellt",
  "codingWorkbench.draftDelivery.phase.draft-created": "Pull-Request-Entwurf erstellt",
  "codingWorkbench.draftDelivery.phase.recovery-required": "Übermittlung muss abgeglichen werden",
  "codingWorkbench.draftDelivery.reason.approval-required":
    "Die gespeicherte Vorlage benötigt vor der Übermittlung die passende Freigabe.",
  "codingWorkbench.draftDelivery.reason.in-flight":
    "Der Vorgang wurde gestartet. Sein Ergebnis auf dem Server ist noch nicht bestätigt.",
  "codingWorkbench.draftDelivery.reason.completed":
    "Das Ergebnis auf dem Server wurde für diesen gespeicherten Übermittlungsschritt bestätigt.",
  "codingWorkbench.draftDelivery.reason.authority-denied":
    "Die akzeptierte Berechtigung erlaubt diese Übermittlung nicht mehr.",
  "codingWorkbench.draftDelivery.reason.remote-drift":
    "Der Zustand auf dem Server weicht vom freigegebenen Ziel ab und muss geprüft werden.",
  "codingWorkbench.draftDelivery.reason.issue-drift":
    "Die akzeptierte Issue-Bindung hat sich geändert. Die Übermittlung muss geprüft werden.",
  "codingWorkbench.draftDelivery.reason.provider-failed":
    "Der Anbieter hat den Vorgang nicht bestätigt. Vor einem erneuten Versuch muss der Zustand auf dem Server geprüft werden.",
  "codingWorkbench.draftDelivery.reason.ambiguous-remote":
    "Das Ergebnis auf dem Server konnte dieser Aufgabe nicht eindeutig zugeordnet werden.",
  "codingWorkbench.draftDelivery.reason.approval-invalid":
    "Die Freigabe fehlt, ist abgelaufen oder passt nicht zu dieser Vorlage.",
  "codingWorkbench.draftDelivery.reason.payload-changed":
    "Die vorgesehene Übermittlung hat sich seit der Prüfung geändert.",
  "codingWorkbench.draftDelivery.reason.restart-reconciliation":
    "Die Übermittlung wurde unterbrochen. Vor dem Fortsetzen muss der Zustand auf dem Server geprüft werden.",
  "codingWorkbench.draftDelivery.reason.preflight-failed":
    "Die Voraussetzungen für die Übermittlung waren nicht erfüllt.",
  "codingWorkbench.draftDelivery.pendingApprovalHint":
    "Reagieren Sie auf die ausstehende Berechtigungsanfrage, um diese Übermittlung freizugeben oder abzulehnen.",
  "codingWorkbench.draftDelivery.pullRequest": "Pull Request #{number}",
  "codingWorkbench.draftDelivery.remoteState": "Zuletzt beobachteter PR-Status",
  "codingWorkbench.draftDelivery.remoteHead": "Zuletzt beobachteter PR-Commit",
  "codingWorkbench.draftDelivery.remoteBase": "Zuletzt beobachteter PR-Basis-Commit",
  "codingWorkbench.draftDelivery.remote.open": "Offen",
  "codingWorkbench.draftDelivery.remote.closed": "Geschlossen",
  "codingWorkbench.draftDelivery.remote.draft": "Entwurf",
  "codingWorkbench.draftDelivery.remote.notDraft": "Kein Entwurf",
  "codingWorkbench.draftDelivery.details": "Gespeichertes Übermittlungsziel",
  "codingWorkbench.draftDelivery.repository": "Repository",
  "codingWorkbench.draftDelivery.issue": "Akzeptiertes Issue",
  "codingWorkbench.draftDelivery.headRef": "Feature-Branch",
  "codingWorkbench.draftDelivery.headSha": "Freigegebener Commit",
  "codingWorkbench.draftDelivery.baseRef": "Ziel-Branch",
  "codingWorkbench.draftDelivery.baseSha": "Freigegebener Basis-Commit",
  "codingWorkbench.draftDelivery.proposal": "Vorlage",
  "codingWorkbench.draftDelivery.recordedAt": "Erfasst am",
  "codingWorkbench.descriptionStatus.title": "Entwurf der Pull-Request-Beschreibung",
  "codingWorkbench.descriptionStatus.state.current": "Entwurf bereit",
  "codingWorkbench.descriptionStatus.state.stale": "Entwurf veraltet",
  "codingWorkbench.descriptionStatus.state.partial": "Entwurf teilweise erstellt",
  "codingWorkbench.descriptionStatus.state.fallback": "Entwurf ohne Modell erstellt",
  "codingWorkbench.descriptionStatus.state.blocked": "Entwurf blockiert",
  "codingWorkbench.descriptionStatus.state.failed": "Entwurfserstellung fehlgeschlagen",
  "codingWorkbench.descriptionStatus.reason.generated":
    "Aus dem zuletzt verifizierten Commit erstellt.",
  "codingWorkbench.descriptionStatus.reason.partial-generated":
    "Mit teilweise ausgelassenen Belegen erstellt.",
  "codingWorkbench.descriptionStatus.reason.fallback-generated":
    "Deterministisch erstellt; das Modell war nicht verfügbar.",
  "codingWorkbench.descriptionStatus.reason.stale-snapshot":
    "Die Änderung hat sich seit der Entwurfserstellung weiterentwickelt.",
  "codingWorkbench.descriptionStatus.reason.authority-expired":
    "Die Berechtigung ist vor Beginn der Erstellung abgelaufen.",
  "codingWorkbench.descriptionStatus.reason.model-egress-denied":
    "Das Modell war für diesen Versuch nicht autorisiert.",
  "codingWorkbench.descriptionStatus.reason.budget-exhausted":
    "Derzeit laufen zu viele Entwurfserstellungen gleichzeitig.",
  "codingWorkbench.descriptionStatus.reason.generation-unavailable":
    "Die automatische Entwurfserstellung ist noch nicht verfügbar.",
  "codingWorkbench.descriptionStatus.reason.interrupted":
    "Die Erstellung wurde unterbrochen und muss bei der nächsten Änderung wiederholt werden.",
  "codingWorkbench.descriptionStatus.reason.provider-failed":
    "Der Beschreibungsdienst ist bei der Erstellung dieses Entwurfs fehlgeschlagen.",
  "codingWorkbench.descriptionStatus.head": "Head-Commit",
  "codingWorkbench.descriptionStatus.generation": "Generation",
  "codingWorkbench.descriptionStatus.review": "Exakten Entwurf prüfen",
  "codingWorkbench.descriptionStatus.unavailable":
    "Dieser gespeicherte Entwurf ist nicht mehr verfügbar. Aktualisieren Sie den Laufstatus.",
  "codingWorkbench.commitResult.title": "Commit-Ergebnis",
  "codingWorkbench.commitResult.head": "Erstellter Commit",
  "codingWorkbench.commitResult.findings": "Git-Prüfungen",
  "codingWorkbench.commitResult.status.succeeded": "Commit erstellt",
  "codingWorkbench.commitResult.status.approval-required": "Commit wartet auf Freigabe",
  "codingWorkbench.commitResult.status.blocked": "Commit blockiert",
  "codingWorkbench.commitResult.status.failed": "Commit fehlgeschlagen",
  "codingWorkbench.commitResult.status.recovery-required": "Commit erfordert Wiederherstellung",
  "codingWorkbench.commitResult.status.verification-failed": "Commit-Verifizierung fehlgeschlagen",
  "codingWorkbench.commitResult.status.drift": "Commit-Vorschlag hat sich geändert",
  "codingWorkbench.commitResult.reason.approval-required":
    "Prüfe den vorgeschlagenen Commit vor der Entscheidung.",
  "codingWorkbench.commitResult.reason.approval-invalid":
    "Die Freigabe passt nicht mehr zu diesem Vorschlag. Fordere eine neue Prüfung an.",
  "codingWorkbench.commitResult.reason.authority-denied":
    "Die aktuelle Berechtigung erlaubt diesen Commit nicht.",
  "codingWorkbench.commitResult.reason.verification-missing":
    "Führe die erforderliche Verifizierung aus, bevor du diesen Commit vorschlägst.",
  "codingWorkbench.commitResult.reason.verification-failed":
    "Die erforderliche Verifizierung war nicht erfolgreich.",
  "codingWorkbench.commitResult.reason.verification-stale":
    "Die Verifizierung passt nicht mehr zur vorgemerkten Änderung. Verifiziere sie erneut.",
  "codingWorkbench.commitResult.reason.candidate-drift":
    "Die vorgemerkte Änderung passt nicht mehr zu diesem Vorschlag. Fordere eine neue Prüfung an.",
  "codingWorkbench.commitResult.reason.repository-drift":
    "Das Repository hat sich seit der Prüfung geändert. Prüfe seinen aktuellen Zustand.",
  "codingWorkbench.commitResult.reason.message-policy":
    "Die Commit-Nachricht erfüllt die Nachrichtenrichtlinie nicht.",
  "codingWorkbench.commitResult.reason.review-incomplete":
    "Die vorgemerkte Änderung konnte nicht vollständig geprüft werden.",
  "codingWorkbench.commitResult.reason.issue-directive":
    "Die Commit-Nachricht enthält eine nicht unterstützte Anweisung zum Schließen eines Issues.",
  "codingWorkbench.commitResult.reason.conflict-markers":
    "Die vorgemerkte Änderung enthält ungelöste Konfliktmarkierungen.",
  "codingWorkbench.commitResult.reason.policy-block":
    "Die Git-Richtlinie hat diesen Commit verhindert. Prüfe den folgenden Befund.",
  "codingWorkbench.commitResult.reason.preflight-block":
    "Eine Git-Prüfung hat diesen Commit verhindert. Prüfe die folgenden Befunde.",
  "codingWorkbench.commitResult.reason.execution-failed":
    "Git konnte diesen Commit nicht erstellen.",
  "codingWorkbench.commitResult.reason.execution-uncertain":
    "Das Commit-Ergebnis ist unklar. Gleiche den Repository-Zustand vor einem weiteren Versuch ab.",
  "codingWorkbench.commitResult.reason.restart-reconciliation":
    "Dieser Commit muss nach einem Neustart abgeglichen werden.",
  "codingWorkbench.commitResult.reason.completed":
    "Der erstellte Commit entspricht dem geprüften vorgemerkten Baum.",
  "codingWorkbench.commitResult.preflight.detached-head": "Kein Branch ist ausgecheckt",
  "codingWorkbench.commitResult.preflight.branch-already-exists": "Der Branch existiert bereits",
  "codingWorkbench.commitResult.preflight.base-branch-missing": "Der Basis-Branch fehlt",
  "codingWorkbench.commitResult.preflight.switch-target-missing": "Der Ziel-Branch fehlt",
  "codingWorkbench.commitResult.preflight.no-changes-to-stage":
    "Keine Änderungen zum Vormerken vorhanden",
  "codingWorkbench.commitResult.preflight.nothing-staged-to-unstage":
    "Keine vorgemerkten Änderungen zum Zurücknehmen vorhanden",
  "codingWorkbench.commitResult.preflight.nothing-staged-to-commit":
    "Für diesen Commit sind keine Änderungen vorgemerkt",
  "codingWorkbench.commitResult.preflight.untracked-files-impacted":
    "Nicht verfolgte Dateien wären betroffen",
  "codingWorkbench.commitResult.preflight.no-upstream-configured":
    "Kein Upstream-Branch ist konfiguriert",
  "codingWorkbench.commitResult.preflight.nothing-to-push": "Keine Commits zum Pushen vorhanden",
  "codingWorkbench.commitResult.preflight.non-fast-forward": "Der Remote-Verlauf ist abgewichen",
  "codingWorkbench.commitResult.preflight.remote-alias-missing": "Der Remote-Alias fehlt",
  "codingWorkbench.commitResult.preflight.remote-unreachable": "Das Remote ist nicht erreichbar",
  "codingWorkbench.commitResult.preflight.operation-in-progress":
    "Eine Git-Operation läuft bereits",
  "codingWorkbench.commitResult.preflight.no-operation-to-abort":
    "Keine Git-Operation kann abgebrochen werden",
  "codingWorkbench.commitResult.preflight.recovery-target-unset":
    "Kein Wiederherstellungsziel ist festgelegt",
  "codingWorkbench.commitResult.preflight.dirty-worktree-impacts-recovery":
    "Workspace-Änderungen verhindern eine sichere Wiederherstellung",
  "codingWorkbench.commitResult.messageViolation.empty-subject": "Die Commit-Betreffzeile ist leer",
  "codingWorkbench.commitResult.messageViolation.missing-conventional-prefix":
    'Der Betreffzeile fehlt ein Conventional-Commit-Präfix (zum Beispiel "feat: ")',
  "codingWorkbench.commitResult.messageViolation.disallowed-type":
    "Der Conventional-Commit-Typ gehört nicht zu den erlaubten Typen",
  "codingWorkbench.commitResult.messageViolation.subject-too-long":
    "Die Betreffzeile überschreitet die maximale Länge",
  "codingWorkbench.commitResult.messageViolation.missing-issue-key":
    "Der Nachricht fehlt ein erforderlicher Issue-Schlüssel",
  "codingWorkbench.commitResult.messageViolation.missing-signoff":
    "Der Nachricht fehlt ein erforderlicher Signed-off-by-Trailer",
  "codingWorkbench.approval.commit.message": "Geprüfte Commit-Nachricht",
  "codingWorkbench.approval.commit.binding": "Exakte Commit-Bindung",
  "codingWorkbench.approval.commit.proposal": "Vorschlag",
  "codingWorkbench.approval.commit.verification": "Verifizierungsnachweis",
  "codingWorkbench.approval.commit.base": "Basis-Commit",
  "codingWorkbench.approval.commit.parent": "Übergeordneter Commit",
  "codingWorkbench.approval.commit.tree": "Digest des vorgemerkten Baums",
  "codingWorkbench.approval.commit.messageDigest": "Nachrichten-Digest",
  "codingWorkbench.approval.commit.files": "Vorgemerkte Dateien für diesen Commit",
  "codingWorkbench.approval.delivery.target": "Geprüftes Übermittlungsziel",
  "codingWorkbench.approval.delivery.loading": "Übermittlungsprüfung wird geladen…",
  "codingWorkbench.approval.delivery.unavailable":
    "Die Übermittlungsprüfung ist nicht verfügbar. Erneut laden oder diese Anfrage ablehnen.",
  "codingWorkbench.approval.delivery.retry": "Übermittlungsprüfung erneut laden",
  "codingWorkbench.approval.delivery.title": "Geprüfter Pull-Request-Titel",
  "codingWorkbench.approval.delivery.body": "Geprüfte Pull-Request-Beschreibung",
  "codingWorkbench.approval.delivery.pushHelp":
    "Diesen exakten Commit und Branch für einen Push in das angezeigte Repository freigeben. Das Erstellen eines Pull Requests erfordert eine eigene Freigabe.",
  "codingWorkbench.approval.delivery.prHelp":
    "Einen Draft Pull Request mit diesem exakten Titel, dieser Beschreibung und diesem Ziel freigeben. Diese Freigabe führt den Pull Request nicht zusammen.",
  "codingWorkbench.approval.commit.help":
    "Die Freigabe gilt einmalig für diese geprüfte Nachricht und vorgemerkte Änderung. Ein geänderter Vorschlag erfordert eine erneute Prüfung.",
  "codingWorkbench.approval.changes.title": "Dateien, die diese Änderung schreiben würde",
  "codingWorkbench.approval.changes.files": "Dateien",
  "codingWorkbench.approval.changes.lines": "Zeilen",
  "codingWorkbench.approval.changes.lineCounts": "+{added} / -{deleted}",
  "codingWorkbench.approval.changes.truncated":
    "Es werden nur die ersten {shown} von {total} Dateien aufgeführt.",
  "codingWorkbench.approval.changes.loading": "Geänderte Dateien werden geladen …",
  "codingWorkbench.approval.changes.unavailable":
    "Geänderte Dateien nicht abrufbar. Fenster erneut koppeln, um sie vor der Entscheidung zu sehen.",
  "codingWorkbench.approval.changes.retry": "Geänderte Dateien erneut laden",
  "codingWorkbench.approval.help":
    "Unverarbeitete Befehle, Prompts, Diffs und Dateiinhalte bleiben verborgen.",
  "codingWorkbench.approval.evidenceRequired":
    "Die Genehmigung bleibt gesperrt, bis geladen ist, was diese Anfrage berühren würde. Wiederholen Sie diesen Abruf oder lehnen Sie die Anfrage ab.",
  "codingWorkbench.approval.approve": "Einmal genehmigen",
  "codingWorkbench.approval.deny": "Ablehnen",
  "codingWorkbench.changesetReview.eyebrow": "Änderungsprüfung",
  "codingWorkbench.changesetReview.title": "Vorgeschlagene Dateiänderung prüfen",
  "codingWorkbench.changesetReview.help":
    "Der Task ist pausiert, damit Sie diese genaue Änderung vor dem Schreiben bestätigen können.",
  "codingWorkbench.changesetReview.empty": "Es wurde keine überprüfbare Änderung erzeugt.",
  "codingWorkbench.changesetReview.approve": "Änderung übernehmen",
  "codingWorkbench.changesetReview.deny": "Änderung ablehnen",
  "codingWorkbench.changesetReview.retry": "Erneut versuchen",
  "codingWorkbench.changesetReview.deliveryFailed":
    "Diese Entscheidung konnte dem Task nicht bestätigt werden. Bitte erneut versuchen.",
  "codingWorkbench.changesetReview.deliveryFailedCode":
    "Diese Entscheidung konnte dem Task nicht bestätigt werden ({code}). Die Änderung wurde nicht geschrieben — bitte erneut versuchen.",
  "codingWorkbench.recovery.eyebrow": "Wiederherstellung erforderlich",
  "codingWorkbench.recovery.title": "Vor erneutem Versuch abgleichen",
  "codingWorkbench.recovery.summary":
    "Keiko startet einen neuen Lauf. Vorherige Änderungen werden nicht wiederholt.",
  "codingWorkbench.recovery.retry": "Als neuen Lauf wiederholen",
  "codingWorkbench.recovery.acknowledge": "Wiederherstellung bestätigen",
  "codingWorkbench.header.notReady": "Nicht startbereit",
  "codingWorkbench.header.readyEvaluation": "Start — ungeprüfte Evaluations-Runtime",
  "codingWorkbench.runState.idle": "Bereit zum Starten",
  "codingWorkbench.runState.unavailable": "Runtime nicht verfügbar",
  "codingWorkbench.runState.starting": "Wird gestartet",
  "codingWorkbench.runState.ready": "Runtime bereit",
  "codingWorkbench.runState.running": "Wird ausgeführt",
  "codingWorkbench.runState.paused": "Pausiert",
  "codingWorkbench.runState.awaiting-approval": "Genehmigung erforderlich",
  "codingWorkbench.runState.stopping": "Wird angehalten",
  "codingWorkbench.runState.succeeded": "Erfolgreich",
  "codingWorkbench.runState.failed": "Fehlgeschlagen",
  "codingWorkbench.runState.cancelled": "Angehalten",
  "codingWorkbench.runState.taken-over": "Übernommen",
  "codingWorkbench.runState.recovery-required": "Wiederherstellung erforderlich",
  "codingWorkbench.resourceStatus.unavailable": "Nicht verfügbar",
  "codingWorkbench.announcement.runChecking": "Laufstatus wird geprüft.",
  "codingWorkbench.announcement.noActiveRun": "Kein aktiver Coding-Lauf.",
  "codingWorkbench.announcement.runRevision": "{state}. Revision {revision}.",
  "codingWorkbench.announcement.recoveryComplete": "Wiederherstellungsbestätigung abgeschlossen.",
  "codingWorkbench.announcement.setupReady": "Authentifizierungseinrichtungsplan bereit.",
  "codingWorkbench.announcement.setupChecking": "Authentifizierungseinrichtungsplan wird geprüft.",
  "codingWorkbench.announcement.setupUnavailable":
    "Authentifizierungseinrichtungsplan nicht verfügbar.",
  "codingWorkbench.announcement.modelSource.checking": "Modellquelle wird geprüft.",
  "codingWorkbench.announcement.modelSource.refreshFailed":
    "Aktualisierung der Modellquelle fehlgeschlagen.",
  "codingWorkbench.announcement.modelSource.unavailable": "Modellquelle nicht verfügbar.",
  "codingWorkbench.announcement.modelSource.ready": "Modellquelle bereit.",
  "codingWorkbench.announcement.modelSource.notSelected": "Modellquelle nicht ausgewählt.",
  "codingWorkbench.announcement.modelSource.notChecked": "Modellquelle nicht geprüft.",
  "codingWorkbench.announcement.workspace.checking": "Arbeitsbereich wird geprüft.",
  "codingWorkbench.announcement.workspace.refreshFailed":
    "Aktualisierung des Arbeitsbereichs fehlgeschlagen.",
  "codingWorkbench.announcement.workspace.unavailable": "Arbeitsbereich nicht verfügbar.",
  "codingWorkbench.announcement.workspace.ready": "Arbeitsbereich bereit.",
  "codingWorkbench.announcement.workspace.notSelected": "Arbeitsbereich nicht ausgewählt.",
  "codingWorkbench.announcement.workspace.notChecked": "Arbeitsbereich nicht geprüft.",
  "codingWorkbench.announcement.runtime.checking": "Runtime wird geprüft.",
  "codingWorkbench.announcement.runtime.refreshFailed":
    "Aktualisierung der Runtime fehlgeschlagen.",
  "codingWorkbench.announcement.runtime.unavailable": "Runtime nicht verfügbar.",
  "codingWorkbench.announcement.runtime.ready": "Runtime bereit.",
  "codingWorkbench.announcement.runtime.notSelected": "Runtime nicht ausgewählt.",
  "codingWorkbench.announcement.runtime.notChecked": "Runtime nicht geprüft.",
  "codingWorkbench.announcement.runtime.evaluation":
    "Runtime verfügbar als ungeprüfte Evaluations-Runtime. Sie trägt keine Plattformsignatur.",
  "codingWorkbench.announcement.authenticationNotSelected":
    "Abonnementauthentifizierung nicht ausgewählt.",
  "codingWorkbench.announcement.authenticationChecking": "Authentifizierung wird geprüft.",
  "codingWorkbench.announcement.authenticationUnavailable": "Authentifizierung nicht verfügbar.",
  "codingWorkbench.announcement.authenticationReady": "Authentifizierung bereit.",
  "codingWorkbench.announcement.authenticationRequired": "Authentifizierung erforderlich.",
  "codingWorkbench.announcement.authenticationNotChecked": "Authentifizierung nicht geprüft.",
  "codingWorkbench.event.runtime-started": "Runtime gestartet",
  "codingWorkbench.event.runtime-stopped": "Runtime angehalten",
  "codingWorkbench.event.runtime-health": "Runtime-Zustand geändert",
  "codingWorkbench.event.task-submitted": "Aufgabe übermittelt",
  "codingWorkbench.event.observation-streamed": "Runtime-Beobachtung",
  "codingWorkbench.event.permission-requested": "Berechtigung angefordert",
  "codingWorkbench.event.diff-summarized": "Diff zusammengefasst",
  "codingWorkbench.event.verification-summarized": "Verifizierung zusammengefasst",
  "codingWorkbench.event.artifact-produced": "Artefakt erstellt",
  "codingWorkbench.event.research-performed": "Recherche durchgeführt",
  "codingWorkbench.event.skill-invoked": "Skill aufgerufen",
  "codingWorkbench.event.child-run-started": "Unteragent gestartet",
  "codingWorkbench.event.child-run-completed": "Unteragent abgeschlossen",
  "codingWorkbench.event.failure-redacted": "Fehler gemeldet",
  "codingWorkbench.event.detail": "Sequenz {sequence}. Revision {revision}.",
  "codingWorkbench.event.detailFailure":
    "Sequenz {sequence}. Revision {revision}. Fehler: {failure}.",
  "codingWorkbench.event.detailOutcome": "Ergebnis: {outcome}.",
  "codingWorkbench.event.detailUntrustedContent":
    "Nicht vertrauenswürdiger Inhalt: Die abgerufene Seite wurde als Daten isoliert, nicht als Anweisungen.",
  "codingWorkbench.outcomeLabel.accepted": "Angenommen",
  "codingWorkbench.outcomeLabel.denied": "Abgelehnt",
  "codingWorkbench.outcomeLabel.unavailable": "Nicht verfügbar",
  "codingWorkbench.outcomeLabel.limit-reached": "Limit erreicht",
  "codingWorkbench.outcomeLabel.stopped": "Gestoppt",
  "codingWorkbench.research.chipLabel": "Internet · Nur Recherche",
  "codingWorkbench.research.facts": "Fakten zur Recherche-Berechtigung",
  "codingWorkbench.research.scope": "Geltungsbereich",
  "codingWorkbench.research.scopeValue": "Nur öffentliche Recherche",
  "codingWorkbench.research.domains": "Erlaubte Domains",
  "codingWorkbench.research.expiry": "Läuft ab",
  "codingWorkbench.research.revoke": "Widerrufen",
  "codingWorkbench.research.revoking": "Wird widerrufen…",
  "codingWorkbench.research.revokeLabel":
    "Internet-Recherche-Berechtigung für diesen Lauf und seine Unteragenten widerrufen",
  "codingWorkbench.announcement.researchActive": "Internet-Recherche-Berechtigung aktiv.",
  "codingWorkbench.alert.actionFailedCode":
    "Die angeforderte Runtime-Aktion ist fehlgeschlagen ({code}). Prüfe den Live-Zustand und versuche es erneut.",
  "codingWorkbench.alert.actionFailedSupportId": "Support-ID: {correlationId}.",
  "codingWorkbench.alert.authenticationRefreshFailed":
    "Authentifizierung konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.authenticationSetupRefreshFailed":
    "Authentifizierungseinrichtung konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.modelSourceRefreshFailed":
    "Modellquelle konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.runtimeRefreshFailed": "Runtime konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.runtimeUnqualified":
    "Das Starten eines Coding-Laufs bleibt nicht verfügbar, bis die Coding-Runtime dieser Installation als aktiv bestätigt ist.",
  "codingWorkbench.alert.workspaceRefreshFailed":
    "Arbeitsbereich konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.workspaceBindFailed":
    "Der Workspace konnte nicht gebunden werden. Prüfe Repository-Pfad und Zielbranch.",
  "codingWorkbench.alert.runRefreshFailed": "Lauf konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.eventStreamRefreshFailed":
    "Ereignisstrom konnte nicht aktualisiert werden.",
  "codingWorkbench.issue.eyebrow": "GitHub-Issue",
  "codingWorkbench.issue.title": "Aus einem GitHub-Issue starten",
  "codingWorkbench.issue.help":
    "Optional. Füge eine Issue-URL oder #Nummer aus diesem Repository ein. Keiko zeigt das Issue als nicht vertrauenswürdigen Text an und bindet den Lauf an das serverseitig aufgelöste Issue, Repository, Remote und den Standardbranch.",
  "codingWorkbench.issue.reference": "Issue-URL oder #Nummer",
  "codingWorkbench.issue.referencePlaceholder":
    "https://github.com/owner/repo/issues/123 oder #123",
  "codingWorkbench.issue.preview": "Issue-Vorschau",
  "codingWorkbench.issue.previewing": "Vorschau wird geladen…",
  "codingWorkbench.issue.cancel": "Abbrechen",
  "codingWorkbench.issue.confirm": "Dieses Issue verwenden",
  "codingWorkbench.issue.discard": "Vorschau verwerfen",
  "codingWorkbench.issue.remove": "Issue entfernen",
  "codingWorkbench.issue.retry": "Erneut versuchen",
  "codingWorkbench.issue.changeRepository": "Repository-Pfad ändern",
  "codingWorkbench.issue.openGit": "Git-Client öffnen, um zu klonen oder zu wechseln",
  "codingWorkbench.issue.previewRegion": "Issue-Vorschau",
  "codingWorkbench.issue.untrustedNote":
    "Issue-Text wird als reiner Text angezeigt und niemals als Anweisung oder Freigabe behandelt.",
  "codingWorkbench.issue.commentLabel": "Kommentar {index}",
  "codingWorkbench.issue.commentsLabel": "Auszüge aus Issue-Kommentaren",
  "codingWorkbench.issue.commentsTruncated":
    "Weitere Kommentare oder Textteile wurden in dieser begrenzten Vorschau ausgelassen.",
  "codingWorkbench.issue.bodyTruncated": "Der Issue-Text wurde in dieser Vorschau gekürzt.",
  "codingWorkbench.issue.fact.state": "Status",
  "codingWorkbench.issue.fact.comments": "Kommentare",
  "codingWorkbench.issue.fact.provenance": "Quelle",
  "codingWorkbench.issue.fact.url": "URL",
  "codingWorkbench.issue.fact.baseRef": "Basisbranch",
  "codingWorkbench.issue.state.open": "Offen",
  "codingWorkbench.issue.state.closed": "Geschlossen",
  "codingWorkbench.issue.commentCount": "{count} begrenzte Kommentar(e) enthalten",
  "codingWorkbench.issue.excerptLabel": "Auszug aus dem Issue-Text",
  "codingWorkbench.issue.excerptEmpty": "Das Issue hat keinen Text.",
  "codingWorkbench.issue.baseRefServerChosen":
    "Der Basisbranch ist der serverseitig aufgelöste Standardbranch des Repositorys. Für einen issue-gebundenen Lauf kann er nicht geändert werden.",
  "codingWorkbench.issue.accepted": "Issue {issue} · Basis {baseRef}",
  "codingWorkbench.issue.acceptedHelp":
    "Der Arbeitsbereich wird von {baseRef} gebunden und der Lauf startet an dieses Issue gebunden. Entferne das Issue, um stattdessen einen generischen Lauf zu starten.",
  "codingWorkbench.issue.status.loading": "Issue-Vorschau wird geladen…",
  "codingWorkbench.issue.status.ready": "Issue-Vorschau bereit.",
  "codingWorkbench.issue.status.cancelled":
    "Issue-Vorschau abgebrochen. Es wurde kein Lauf gestartet.",
  "codingWorkbench.issue.status.failed": "Das Issue konnte nicht geladen werden.",
  "codingWorkbench.issue.status.empty":
    "Gib eine Issue-URL oder #Nummer ein, um eine Vorschau zu sehen.",
  "codingWorkbench.issue.error.invalid-reference":
    "Das ist keine GitHub-Issue-Referenz. Gib eine Issue-URL oder #Nummer aus diesem Repository ein; Pull-Request-URLs und andere Hosts werden abgelehnt.",
  "codingWorkbench.issue.error.repository-mismatch":
    "Das Issue gehört zu einem anderen Repository als dem unter diesem Pfad. Ändere den Repository-Pfad oder öffne den Git-Client, um zu diesem Repository zu wechseln oder es zu klonen. Keiko leitet niemals stillschweigend um.",
  "codingWorkbench.issue.error.auth-required":
    "Der GitHub-Issue-Zugriff ist für dieses Repository nicht aktiviert. Aktiviere ihn unter Einstellungen → Sicherheit → GitHub-Issue-Zugriff und lade die Vorschau erneut.",
  "codingWorkbench.issue.error.issue-unavailable":
    "Das Issue konnte nicht gelesen werden. Es ist möglicherweise geschlossen, übertragen, gelöscht, ein Pull Request oder außerhalb des Zugriffs dieser Installation.",
  "codingWorkbench.issue.error.read-transient-failure":
    "GitHub war gerade nicht erreichbar (ein Rate-Limit oder ein vorübergehender Fehler). Das liegt nicht am Issue selbst — versuche es gleich noch einmal.",
  "codingWorkbench.issue.error.clone-failed":
    "Das Repository konnte nicht geklont werden. Es wurde kein Lauf gestartet und kein Ziel überschrieben. Prüfe den Git-Client und versuche es erneut.",
  "codingWorkbench.issue.error.authority-denied":
    "Die aktuelle Autorität erlaubt es nicht, einen Lauf an dieses Issue zu binden. Prüfe den Autonomiemodus und versuche es erneut.",
  "codingWorkbench.issue.error.cancelled":
    "Die Issue-Aufnahme wurde abgebrochen. Es wurde kein Lauf gestartet.",
  "codingWorkbench.issue.error.unavailable-runtime":
    "Die Coding-Runtime ist auf dieser Installation nicht verfügbar, daher kann kein issue-gebundener Lauf starten. Die Vorschau bleibt zur Ansicht; bestätige, sobald die Runtime aktiv ist.",
  "codingWorkbench.issue.error.unknown":
    "Die Issue-Vorschau ist fehlgeschlagen. Prüfe den Live-Zustand und versuche es erneut.",
  "codingWorkbench.issue.supportId": "Support-ID: {correlationId}.",
  "codingWorkbench.composer.issue.label": "Issue {issue}",
  "codingWorkbench.composer.issue.remove": "Issue {issue} aus diesem Lauf entfernen",
  "codingWorkbench.githubAccess.title": "GitHub-Issue-Zugriff",
  "codingWorkbench.githubAccess.description":
    "Erlaubt der Coding Workbench, GitHub-Issues und Kommentare des ausgewählten Repositorys über die lokale gh-CLI zu lesen. Die Freigabe wird pro lokalem Checkout gespeichert; Zugangsdaten gelangen nie in Keiko.",
  "codingWorkbench.githubAccess.toggle": "Lesen von GitHub-Issues für dieses Repository erlauben",
  "codingWorkbench.githubAccess.repositoryId": "Repository-ID",
  "codingWorkbench.githubAccess.noRepository":
    "Öffne ein Repository als Projekt, um seinen GitHub-Issue-Zugriff zu verwalten.",
  "codingWorkbench.githubAccess.loading": "GitHub-Issue-Zugriff wird geladen…",
  "codingWorkbench.githubAccess.enabled": "Aktiviert",
  "codingWorkbench.githubAccess.disabled": "Deaktiviert",
  "codingWorkbench.githubAccess.error.hydrate":
    "Der GitHub-Issue-Zugriff konnte nicht geladen werden. Das Lesen bleibt deaktiviert, bis er bestätigt ist.",
  "codingWorkbench.githubAccess.error.persist":
    "Der GitHub-Issue-Zugriff konnte nicht gespeichert werden. Die zuvor serverseitig bestätigte Einstellung bleibt aktiv.",
  "codingWorkbench.githubAccess.error.conflict":
    "Der GitHub-Issue-Zugriff wurde an anderer Stelle geändert. Der aktuelle Serverzustand wurde neu geladen; prüfe ihn und versuche es erneut.",
  "codingWorkbench.githubAccess.error.unknown-repository":
    "Dieser Pfad ist kein geöffnetes Projekt. Öffne das Repository als Projekt, bevor du seinen GitHub-Issue-Zugriff änderst.",
  "codingWorkbench.trust.restrictedNotice":
    "Die Verifizierung muss die Paket-Skripte dieses Repositorys ausführen, sie sind aber noch nicht freigegeben.",
  "codingWorkbench.trust.allow": "Paket-Skripte für die Verifizierung zulassen",
  "codingWorkbench.trust.allowing": "Wird zugelassen…",
} satisfies CodingWorkbenchMessageCatalog;
