import { DE_AUTONOMY_MODE_LABELS } from "@/lib/autonomy-mode-labels";
import type { CodingWorkbenchMessageCatalog } from "./coding-workbench-i18n.en";

export const DE_CODING_WORKBENCH_MESSAGES = {
  ...DE_AUTONOMY_MODE_LABELS,
  "codingWorkbench.progress.working": "Arbeitet",
  "codingWorkbench.progress.approval": "Wartet auf deine Freigabe",
  "codingWorkbench.progress.question": "Deine Antwort wird benötigt",
  "codingWorkbench.progress.paused": "Pausiert",
  "codingWorkbench.progress.review": "Jetzt prüfen",
  "codingWorkbench.progress.answer": "Frage beantworten",
  "codingWorkbench.schedules.title": "Geplante Fortsetzungen",
  "codingWorkbench.schedules.unnamed": "Geplante Fortsetzung",
  "codingWorkbench.schedules.next": "{label} · nächste {time}",
  "codingWorkbench.schedules.paused": "{label} · pausiert",
  "codingWorkbench.schedules.done": "{label} · erledigt",
  "codingWorkbench.schedules.removed": "{label} · durch das Laufzeit-Update entfernt",
  "codingWorkbench.schedules.wait.run-active": "{label} · fällig, wartet auf den laufenden Lauf",
  "codingWorkbench.schedules.wait.workspace-inactive":
    "{label} · fällig, wartet auf den Workspace dieser Aufgabe",
  "codingWorkbench.schedules.wait.retrying": "{label} · fällig, versucht es gleich erneut",
  "codingWorkbench.schedules.pause": "Pausieren",
  "codingWorkbench.schedules.resume": "Fortsetzen",
  "codingWorkbench.schedules.delete": "Löschen",
  "codingWorkbench.schedules.error":
    "Die Zeitpläne konnten nicht gelesen oder geändert werden. Bitte erneut versuchen.",
  "codingWorkbench.history.scheduled": "Geplante Fortsetzung",
  "codingWorkbench.history.title": "Coding History",
  "codingWorkbench.history.new": "Neue Aufgabe",
  "codingWorkbench.history.retry": "Erneut versuchen",
  "codingWorkbench.history.noBranch": "Ordner",
  "codingWorkbench.history.search": "Coding-Aufgaben suchen",
  "codingWorkbench.history.filter": "Aufgabenstatus",
  "codingWorkbench.history.active": "Aktiv",
  "codingWorkbench.history.completed": "Abgeschlossen",
  "codingWorkbench.history.error":
    "Die Coding-Aufgabe konnte nicht geladen oder aktualisiert werden. Versuche es über die Coding History erneut.",
  "codingWorkbench.history.loading": "Aufgabe wird geladen…",
  "codingWorkbench.history.listError":
    "Die Aufgabenliste konnte nicht geladen werden. Versuche es mit Aktualisieren erneut.",
  "codingWorkbench.history.renameError":
    "Die Aufgabe konnte nicht umbenannt werden. Versuche es erneut.",
  "codingWorkbench.history.listLoading": "Aufgaben werden geladen…",
  "codingWorkbench.history.refresh": "Aktualisieren",
  "codingWorkbench.history.empty": "Keine passenden Aufgaben. Starte eine neue Aufgabe.",
  "codingWorkbench.history.taskTitle": "Aufgabentitel",
  "codingWorkbench.history.save": "Speichern",
  "codingWorkbench.history.cancel": "Abbrechen",
  "codingWorkbench.history.rename": "Umbenennen",
  "codingWorkbench.history.exportJson": "Als JSON exportieren",
  "codingWorkbench.history.exportMarkdown": "Als Markdown exportieren",
  "codingWorkbench.history.exportHint":
    "Speichert eine bereinigte Kopie dieser Aufgabe auf deinem Gerät. Es wird nichts hochgeladen.",
  "codingWorkbench.history.exporting": "Export wird vorbereitet…",
  "codingWorkbench.history.exportError":
    "Die Aufgabe konnte nicht exportiert werden. Bitte erneut versuchen.",
  "codingWorkbench.history.import": "Aufgabe importieren",
  "codingWorkbench.history.importFile": "Datei der Coding-Aufgabe",
  "codingWorkbench.history.importHint":
    "Importiert eine mit „Als JSON exportieren“ gespeicherte Aufgabe oder ein OpenCode-Sitzungsprotokoll von deinem Gerät in diesen Arbeitsbereich. Die Datei bleibt auf diesem Computer.",
  "codingWorkbench.history.importing": "Aufgabe wird importiert…",
  "codingWorkbench.history.importPartial":
    "Ältere Nachrichten wurden ausgelassen. Importiert wurden die {count} neuesten Nachrichten.",
  "codingWorkbench.history.importInvalid":
    "Diese Datei ist kein Export einer Coding-Aufgabe und kein OpenCode-Sitzungsprotokoll.",
  "codingWorkbench.history.importUnsupported":
    "Diese Datei wurde von einer neueren Keiko-Version exportiert.",
  "codingWorkbench.history.importTooLarge": "Diese Datei ist zu groß für den Import.",
  "codingWorkbench.history.importEmpty": "Diese Datei enthält keinen Verlauf zum Importieren.",
  "codingWorkbench.history.importNoWorkspace":
    "Öffne zuerst einen Arbeitsbereich. Die Aufgabe wird in den aktiven Arbeitsbereich importiert.",
  "codingWorkbench.history.importError":
    "Die Aufgabe konnte nicht importiert werden. Bitte erneut versuchen.",
  "codingWorkbench.history.completedNotice":
    "Diese Aufgabe ist abgeschlossen. Deine nächste Nachricht öffnet sie wieder und setzt diesen Verlauf fort.",
  "codingWorkbench.history.importedNotice":
    "„{title}“ wurde aus einer Datei importiert. Deine nächste Nachricht setzt sie als neue Aufgabe fort, die diesen Verlauf behält und „{title}“ nicht verändert.",
  "codingWorkbench.history.finish": "Aufgabe abschließen",
  "codingWorkbench.history.fork": "Aufgabe verzweigen",
  "codingWorkbench.history.showEarlier": "Frühere Nachrichten anzeigen ({count} ausgeblendet)",
  "codingWorkbench.history.forkFrom": "Ab hier verzweigen",
  "codingWorkbench.history.forkNotice":
    "Deine nächste Nachricht startet eine neue Aufgabe, die von „{title}“ abzweigt. Die neue Aufgabe behält diesen Verlauf bis zum Verzweigungspunkt und verändert „{title}“ nicht.",
  "codingWorkbench.history.forkNoticeBefore":
    "Deine nächste Nachricht startet eine neue Aufgabe, die von „{title}“ abzweigt, direkt vor der gewählten Nachricht. Die neue Aufgabe behält den Verlauf bis dahin und verändert „{title}“ nicht.",
  "codingWorkbench.history.forkNoticeWorkspace":
    "Deine nächste Nachricht startet eine neue Aufgabe im Arbeitsbereich „{workspace}“, fortgesetzt aus „{title}“. Die neue Aufgabe behält diesen Verlauf und verändert „{title}“ nicht.",
  "codingWorkbench.history.continueIn": "In „{workspace}“ fortsetzen",
  "codingWorkbench.history.forkCancel": "Verzweigung abbrechen",
  "codingWorkbench.history.location": "Speicherort des Aufgaben-Arbeitsbereichs",
  "codingWorkbench.history.transcript": "Bisheriger Verlauf",
  "codingWorkbench.history.truncated":
    "Es werden nur die zuletzt gespeicherten Nachrichten angezeigt.",
  "codingWorkbench.history.you": "Du",
  "codingWorkbench.history.agent": "Coding-Agent",
  "codingWorkbench.history.keiko": "Hinweis von Keiko",
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
  "codingWorkbench.journey.unavailable":
    "Der Übergabestatus dieses Pull Requests wurde noch nicht beobachtet.",
  "codingWorkbench.journey.proposeReady": "Anfrage zur Review-Bereitschaft prüfen",
  "codingWorkbench.journey.readyHelp":
    "Prüfe den Wechsel vom Entwurf zur Review-Bereitschaft, bevor du ihn einmalig freigibst.",
  "codingWorkbench.journey.proposeReadyPending":
    "Der Freigabepfad für die Review-Bereitschaft ist noch nicht verfügbar.",
  "codingWorkbench.journey.changedFiles": "{count} geänderte Dateien",
  "codingWorkbench.journey.changedFiles.one": "1 geänderte Datei",
  "codingWorkbench.journey.changedFilesTruncated":
    "(mehr Dateien geändert, als aufgelistet werden können)",
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
  "codingWorkbench.info.open": "Informationen zur Coding Workbench öffnen",
  "codingWorkbench.info.details": "Details",
  "codingWorkbench.info.label": "Informationen",
  "codingWorkbench.info.title": "Informationen zur Coding Workbench",
  "codingWorkbench.info.issue": "GitHub-Issue",
  "codingWorkbench.info.failure": "Fehler beim Lauf",
  "codingWorkbench.info.project": "Projekt",
  "codingWorkbench.info.repositoryStatus": "Repository-Status",
  "codingWorkbench.info.repository.git": "Git-Repository",
  "codingWorkbench.info.repository.notGit": "Kein Git-Repository",
  "codingWorkbench.info.repository.unavailable": "Nicht gemeldet",
  "codingWorkbench.info.repositoryBranch": "Repository-Branch",
  "codingWorkbench.info.targetBranch": "Ziel-Branch",
  "codingWorkbench.info.taskBranch": "Task-Branch",
  "codingWorkbench.info.runState": "Laufstatus",
  "codingWorkbench.info.model": "Modell",
  "codingWorkbench.info.agent": "Agent",
  "codingWorkbench.info.toolProfile": "Tool-Profil",
  "codingWorkbench.info.toolProfile.native": "Native OpenCode-Tools",
  "codingWorkbench.info.toolProfile.mapped":
    "Von Keiko abgebildete Tools, keine vollständige native Parität",
  "codingWorkbench.info.modelReadiness": "Modellbereitschaft",
  "codingWorkbench.info.runtime": "Runtime-Verifikation",
  "codingWorkbench.info.runtimeVersion": "OpenCode-Runtime",
  "codingWorkbench.info.runtimeVersion.value": "{version} · {origin}",
  "codingWorkbench.info.runtimeVersion.pinned":
    "{version} · {origin} · diese Keiko-Version erwartet {pinned}",
  "codingWorkbench.info.runtimeOrigin.portable-release": "Keiko-Release",
  "codingWorkbench.info.runtimeOrigin.npm-runtime-package": "npm-Runtime-Paket",
  "codingWorkbench.info.runtimeOrigin.dev-checkout": "Entwicklungs-Checkout",
  "codingWorkbench.info.latestRelease": "Neuestes Keiko-Release",
  "codingWorkbench.info.latestRelease.checking": "Wird geprüft…",
  "codingWorkbench.info.latestRelease.current": "{version} ist installiert und aktuell",
  "codingWorkbench.info.latestRelease.available":
    "{version} ist verfügbar. Installiere es unter Updates; es bringt seine eigene OpenCode-Runtime mit.",
  "codingWorkbench.info.latestRelease.unknown":
    "Unbekannt: Die Update-Prüfung hat die Release-Quelle nicht erreicht",
  "codingWorkbench.info.contextWindow": "Kontextfenster",
  "codingWorkbench.info.context.meter": "Kontextfenster zu {percent} % belegt",
  "codingWorkbench.info.context.used": "Belegter Input",
  "codingWorkbench.info.context.messages": "Konversationsnachrichten",
  "codingWorkbench.info.context.system": "System- und Entwicklerkontext",
  "codingWorkbench.info.context.tools": "Tool-Definitionen",
  "codingWorkbench.info.context.adjustment": "Provider-Abrechnungsanpassung",
  "codingWorkbench.info.context.reserve": "Output-Reserve",
  "codingWorkbench.info.context.free": "Freier Input-Bereich",
  "codingWorkbench.info.context.current": "Aktueller Kontext-Input",
  "codingWorkbench.info.context.cumulative": "Kumulativer Run-Input",
  "codingWorkbench.info.context.runBudget": "Run-Input-Budget",
  "codingWorkbench.info.context.compactions": "Gemeldete Kompaktierungen",
  "codingWorkbench.info.notReported": "Von der Runtime nicht gemeldet",
  "codingWorkbench.info.none": "Keine",
  "codingWorkbench.mode.eyebrow": "Autonomie",
  "codingWorkbench.mode.unconfirmed": "Warten auf Serverbestätigung",
  "codingWorkbench.mode.governed-assist.short":
    "Liest frei; fragt vor jeder Dateiänderung und jedem Befehl",
  "codingWorkbench.mode.governed-assist.description":
    "Lesen und Suchen laufen ohne Rückfrage; jede Dateiänderung und jeder Befehl erfordern eine Genehmigung, Internetzugriff gibt es nicht. Git-Commit, -Push und Pull Request übernimmt Keiko nach separater Genehmigung, nie die Shell des Agenten. Dateien außerhalb des Arbeitsbereichs und geheime Dateien wie .env und Schlüssel sind nie zugänglich.",
  "codingWorkbench.mode.supervised-coding.short":
    "Routinemäßige Änderungen und geprüfte Projektbefehle laufen; andere Befehle fragen",
  "codingWorkbench.mode.supervised-coding.description":
    "Routinemäßige Änderungen im Arbeitsbereich und geprüfte Projektbefehle laufen; andere Befehle erfordern eine Genehmigung, Internetzugriff gibt es nicht. Git-Commit, -Push und Pull Request übernimmt Keiko nach separater Genehmigung, nie die Shell des Agenten. Dateien außerhalb des Arbeitsbereichs und geheime Dateien wie .env und Schlüssel sind nie zugänglich.",
  "codingWorkbench.mode.autonomous-delivery.short":
    "Arbeitet ohne Rückfrage im Rahmen der Aufgabenbefugnis; Internet nur hier",
  "codingWorkbench.mode.autonomous-delivery.description":
    "Dateien, Befehle und Internet funktionieren ohne Rückfrage im Rahmen der Aufgabenbefugnis. Akzeptierte Code-Task-Vorgänge zum Committen, Pushen und Erstellen eines Draft-Pull-Requests übernimmt Keiko innerhalb des validierten Authority Envelope, nie die Shell des Agenten. Dateien außerhalb des Arbeitsbereichs und geheime Dateien wie .env und Schlüssel sind nie zugänglich. Merge bleibt separat genehmigungspflichtig.",
  "codingWorkbench.task.eyebrow": "Aufgabe",
  "codingWorkbench.task.title": "Begrenzte Coding-Aufgabe beschreiben",
  "codingWorkbench.task.instructions": "Aufgabenanweisungen",
  "codingWorkbench.task.placeholder":
    "Bitte Keiko, etwas in diesem Projekt zu prüfen, zu erklären, umzusetzen, zu testen oder zu reparieren…",
  "codingWorkbench.task.placeholder.followUp": "Antworte Keiko oder bitte um die nächste Änderung…",
  "codingWorkbench.task.help":
    "Aufgabentext ist eine flüchtige Absicht. Start wird erst freigeschaltet, wenn alle Bereitschaftsprüfungen bestätigt sind.",
  "codingWorkbench.task.starting": "Wird gestartet…",
  "codingWorkbench.task.start": "Coding-Lauf starten",
  "codingWorkbench.composer.pause": "Lauf pausieren",
  "codingWorkbench.composer.taskBranchMoved":
    "Diese Aufgabe arbeitet auf dem Branch {taskBranch}, der nächste Lauf würde aber {nextBranch} verwenden. Wähle {taskBranch} in der Branch-Auswahl, um hier weiterzuarbeiten, oder starte eine neue Aufgabe.",
  "codingWorkbench.composer.resume": "Lauf fortsetzen",
  "codingWorkbench.composer.send": "Rückfrage senden",
  "codingWorkbench.composer.sendNow": "Jetzt senden",
  "codingWorkbench.composer.sendNow.help":
    "Jetzt senden: Die Nachricht erreicht die laufende Aufgabe in ihrem nächsten Schritt (Enter)",
  "codingWorkbench.composer.queue": "Nachricht einreihen",
  "codingWorkbench.composer.queue.help":
    "Einreihen: Die Nachricht wird nach der aktuellen Arbeit der laufenden Aufgabe zugestellt (Strg oder Cmd+Enter)",
  "codingWorkbench.composer.blocked.emptyMessage": "Schreibe zuerst eine Nachricht.",
  "codingWorkbench.composer.delivery.steer":
    "Nachricht gesendet. Sie erreicht die laufende Aufgabe in ihrem nächsten Schritt.",
  "codingWorkbench.composer.delivery.queue":
    "Nachricht eingereiht. Sie wird nach der aktuellen Arbeit der laufenden Aufgabe zugestellt.",
  "codingWorkbench.composer.delivery.failed":
    "Die Nachricht wurde nicht gesendet; dein Text bleibt erhalten. Die Aufgabe ist möglicherweise gerade fertig geworden, eine referenzierte Datei ist nicht mehr verfügbar, oder diese Laufzeit nimmt während der Arbeit keine Nachrichten an.",
  "codingWorkbench.composer.references.label": "Referenzierte Dateien",
  "codingWorkbench.composer.references.remove": "Verweis auf {path} entfernen",
  "codingWorkbench.composer.references.picker.title": "Eine Aufgabendatei referenzieren",
  "codingWorkbench.composer.references.picker.results": "Passende Aufgabendateien",
  "codingWorkbench.composer.references.picker.option": "{path} referenzieren",
  "codingWorkbench.composer.references.picker.agent": "Agent {name} erwähnen",
  "codingWorkbench.composer.references.picker.agentKind": "Agent",
  "codingWorkbench.composer.skills.title": "Einen Skill verwenden",
  "codingWorkbench.composer.skills.results": "Skills dieser Aufgabe",
  "codingWorkbench.composer.skills.option": "Skill {name} verwenden",
  "codingWorkbench.composer.skills.found":
    "Verfügbare Skills: {count}. Wähle mit den Pfeiltasten und bestätige mit Enter.",
  "codingWorkbench.composer.skills.loading": "Skills werden geladen...",
  "codingWorkbench.composer.skills.empty": "Keine passenden Skills.",
  "codingWorkbench.composer.skills.none": "Diese Aufgabe bietet keine Skills an.",
  "codingWorkbench.composer.skills.error": "Skills konnten nicht geladen werden.",
  "codingWorkbench.composer.skills.retry": "Erneut versuchen",
  "codingWorkbench.composer.references.picker.active": "{name}, {position} von {total}",
  "codingWorkbench.composer.references.picker.hint":
    "Tippe, um die Dateien der Aufgabe zu durchsuchen.",
  "codingWorkbench.composer.references.picker.searching": "Dateien werden gesucht...",
  "codingWorkbench.composer.references.picker.found":
    "{count} Dateien gefunden. Wähle mit den Pfeiltasten und referenziere mit Enter.",
  "codingWorkbench.composer.references.picker.empty": "Keine passenden Dateien.",
  "codingWorkbench.composer.references.picker.error":
    "Die Dateisuche ist fehlgeschlagen. Tippe erneut, um es noch einmal zu versuchen.",
  "codingWorkbench.composer.references.picker.limit":
    "In einer Nachricht können höchstens {count} Dateien referenziert werden.",
  "codingWorkbench.composer.commands.title": "Einen Slash-Befehl ausführen",
  "codingWorkbench.composer.commands.results": "Passende Befehle",
  "codingWorkbench.composer.commands.option": "Befehl /{name} ausführen",
  "codingWorkbench.composer.commands.active": "/{name}, {position} von {total}",
  "codingWorkbench.composer.commands.loading": "Befehle werden geladen...",
  "codingWorkbench.composer.commands.found":
    "Verfügbare Befehle: {count}. Wähle mit den Pfeiltasten und bestätige mit Enter.",
  "codingWorkbench.composer.commands.empty": "Keine passenden Befehle.",
  "codingWorkbench.composer.commands.none": "Diese Aufgabe bietet keine Slash-Befehle an.",
  "codingWorkbench.composer.commands.error": "Die Befehle konnten nicht geladen werden.",
  "codingWorkbench.composer.commands.retry": "Erneut versuchen",
  "codingWorkbench.composer.commands.init.description":
    "Geführte Einrichtung der AGENTS.md für dieses Repository",
  "codingWorkbench.composer.commands.review.description":
    "Änderungen prüfen [commit|branch|pr]; standardmäßig die nicht committeten Änderungen",
  "codingWorkbench.composer.model.label": "Coding-Modell",
  "codingWorkbench.composer.model.selected": "Coding-Modell: {model}",
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
  "codingWorkbench.composer.authority.ceiling":
    "{requested} liegt über der Berechtigungsgrenze dieser Installation, daher starten Läufe mit {ceiling}.",
  "codingWorkbench.composer.authority.error.hydrate":
    "Die Rechte konnten nicht geladen werden. „Um Genehmigung bitten“ bleibt ausgewählt.",
  "codingWorkbench.composer.authority.error.persist":
    "Die Rechte konnten nicht gespeichert werden. Die vorherige Auswahl bleibt aktiv.",
  "codingWorkbench.composer.agent.label": "Agent",
  "codingWorkbench.composer.agent.build": "Bauen",
  "codingWorkbench.composer.agent.plan": "Planen",
  "codingWorkbench.composer.agent.build.description":
    "Der Agent ändert Dateien und führt Befehle im gewählten Modus aus.",
  "codingWorkbench.composer.agent.plan.description":
    "Der Agent analysiert und erstellt einen Plan, ohne Arbeitsbereichsdateien zu ändern.",
  "codingWorkbench.composer.agent.custom.description":
    "Ein Primär-Agent, den dieses Repository definiert; er arbeitet im gewählten Modus.",
  "codingWorkbench.composer.projectMemory.label": "MemoriaViva",
  "codingWorkbench.composer.projectMemory.help":
    "MemoriaViva verwendet in der Coding Workbench ausschließlich das aktive Projekt-Memory.",
  "codingWorkbench.composer.projectMemory.help.enabled":
    "Projekt-Memory ist für den nächsten Coding-Lauf aktiv.",
  "codingWorkbench.composer.projectMemory.help.disabled":
    "Projekt-Memory ist für den nächsten Coding-Lauf ausgeschaltet.",
  "codingWorkbench.composer.projectMemory.enable": "Projekt-Memory für diesen Lauf einschalten",
  "codingWorkbench.composer.projectMemory.disable": "Projekt-Memory für diesen Lauf ausschalten",
  "codingWorkbench.composer.help":
    "Pausiere den Lauf, um die Rückfrage zu senden. Für diesen Lauf ist keine Warteschlange verfügbar.",
  "codingWorkbench.composer.activeRunElsewhere":
    "In dieser Installation läuft bereits ein anderer Coding-Lauf, deshalb zeigt dieses Fenster ihn jetzt an. Dein Aufgabentext bleibt erhalten, damit du ihn starten kannst, sobald dieser Lauf beendet ist.",
  "codingWorkbench.composer.workspaceMismatch":
    "Dieser Lauf behält die Autorität des Arbeitsbereichs, in dem er gestartet wurde; dieser ist nicht mehr der aktive. Das Informationspanel und der Laufstatus beschreiben weiterhin diesen Lauf. Wechsle über die Workspace-Auswahl oben zurück, um seine Dateien zu prüfen oder zu bearbeiten.",
  "codingWorkbench.composer.blocked.busy": "Keiko verarbeitet gerade eine Runtime-Aktion.",
  "codingWorkbench.composer.blocked.emptyStart": "Beschreibe zuerst, was Keiko tun soll.",
  "codingWorkbench.composer.blocked.emptyFollowUp": "Schreibe zuerst eine Rückfrage.",
  "codingWorkbench.composer.blocked.commandsLoading":
    "Keiko lädt noch die Befehle dieser Aufgabe. Sende gleich noch einmal.",
  "codingWorkbench.composer.blocked.pauseDecision":
    "Dieser pausierte Lauf wartet auf eine erforderliche Entscheidung. Nutze die oben angezeigte Entscheidungsaktion.",
  "codingWorkbench.composer.blocked.notReady":
    "Keiko ist noch nicht startbereit. Prüfe die Workbench-Informationen oben.",
  "codingWorkbench.composer.blocked.pairing":
    "Keiko prüft noch, ob diese Browsersitzung gekoppelt ist.",
  "codingWorkbench.composer.blocked.unpaired":
    "Diese Browsersitzung ist nicht gekoppelt; Keiko kann hier keinen Coding-Lauf starten. Öffne Keiko über den Launcher und versuche es erneut.",
  "codingWorkbench.composer.blocked.modelSource": "Keiko prüft noch die Modellquelle.",
  "codingWorkbench.composer.blocked.workspace": "Keiko prüft noch den Task-Workspace.",
  "codingWorkbench.composer.blocked.runtime": "Keiko prüft noch die Coding-Runtime.",
  "codingWorkbench.composer.blocked.run": "Keiko prüft noch den aktuellen Laufstatus.",
  "codingWorkbench.editorBridge.reconnecting":
    "Bearbeitungen sind pausiert: Die Editor-Bridge wird neu verbunden.",
  "codingWorkbench.questions.sectionLabel": "Laufzeitfragen",
  "codingWorkbench.questions.eyebrow": "Eingabe erforderlich",
  "codingWorkbench.questions.title": "Laufzeitfragen",
  "codingWorkbench.questions.help":
    "Der Lauf bleibt pausiert, bis du antwortest oder ablehnst. Fragetext ist flüchtig und wird niemals gespeichert.",
  "codingWorkbench.questions.ready": "{count} Fragesatz wartet auf deine Eingabe.",
  "codingWorkbench.questions.loading": "Suche nach Laufzeitfragen…",
  "codingWorkbench.questions.empty": "Keine ausstehenden Laufzeitfragen.",
  "codingWorkbench.questions.offline": "Der Fragedienst ist offline.",
  "codingWorkbench.questions.error": "Fragen konnten nicht aktualisiert werden.",
  "codingWorkbench.questions.stale": "Fragestatus geändert. Erneut prüfen, um fortzufahren.",
  "codingWorkbench.questions.submitting": "Deine Antwort wird übermittelt…",
  "codingWorkbench.questions.terminal": "Der Coding-Lauf ist beendet.",
  "codingWorkbench.questions.unpaired":
    "Dieses Fenster ist nicht für Frageinhalte gekoppelt. Starte Keiko über den Launcher neu, um eine neue App-Sitzung zu koppeln.",
  "codingWorkbench.pairing.unpaired": "Workbench nicht gekoppelt. Keiko über den Launcher öffnen.",
  "codingWorkbench.questions.answerFailed":
    "Deine Antwort wurde nicht angenommen ({code}). Die Frage ist weiterhin offen — sende sie erneut.",
  "codingWorkbench.questions.answerRejected":
    "Wähle für jede Frage eine der aufgeführten Optionen. Gib freien Text nur ein, wenn eine eigene Antwort angeboten wird. Die Frage ist weiterhin offen ({code}).",
  "codingWorkbench.questions.rejectFailed":
    "Das Ablehnen der Frage wurde nicht angenommen ({code}). Die Frage ist weiterhin offen — versuche es erneut.",
  "codingWorkbench.questions.retry": "Erneut prüfen",
  "codingWorkbench.questions.requestTitle": "Die Laufzeit benötigt deine Eingabe",
  "codingWorkbench.questions.required": "Beantworte jede Frage vor dem Senden.",
  "codingWorkbench.questions.answer": "Antwort senden",
  "codingWorkbench.questions.reject": "Frage ablehnen",
  "codingWorkbench.questions.multipleHint": "Alle zutreffenden auswählen.",
  "codingWorkbench.questions.customLabel": "Eigene Antwort für {header}",
  "codingWorkbench.setup.eyebrow": "Workspace",
  "codingWorkbench.repository.choose": "Coding-Repository auswählen",
  "codingWorkbench.repository.chooseBranch": "Coding-Branch auswählen",
  "codingWorkbench.repository.label": "Repository",
  "codingWorkbench.repository.branchLabel": "Branch",
  "codingWorkbench.repository.locationLabel": "Arbeitsort",
  "codingWorkbench.repository.locationLocal": "Lokal",
  "codingWorkbench.repository.locationWorktree": "Neuer lokaler Worktree",
  "codingWorkbench.repository.locationBinding": "Gewählten Checkout vorbereiten…",
  "codingWorkbench.repository.locationError":
    "Der gewählte Checkout konnte nicht geöffnet werden. Wähle den Branch in Git und versuche es erneut.",
  "codingWorkbench.repository.locationUnregistered":
    "Keiko findet diesen Ordner nicht mehr unter den hinzugefügten Ordnern. Füge ihn erneut hinzu und versuche es dann noch einmal.",
  "codingWorkbench.repository.locationUnbound":
    "Verbinde dieses Repository in Git erneut und wähle dann „Erneut versuchen“.",
  "codingWorkbench.repository.locationGitUnreadable":
    "Git konnte diesen Checkout nicht öffnen. Prüfe, ob Git installiert ist und ob du den obersten Ordner des Repositorys gewählt hast, und versuche es dann erneut.",
  "codingWorkbench.repository.search": "Repositories suchen",
  "codingWorkbench.repository.searchBranch": "Branches suchen",
  "codingWorkbench.repository.noMatches": "Keine passenden Repositories.",
  "codingWorkbench.repository.noBranchMatches": "Keine passenden Branches.",
  "codingWorkbench.repository.noBranch": "Kein Branch",
  "codingWorkbench.repository.loading": "Repositories werden geladen…",
  "codingWorkbench.repository.none": "Repository auswählen",
  "codingWorkbench.repository.noProject": "Noch kein Projekt gewählt: Wähle einen Ordner.",
  "codingWorkbench.repository.chooseFolder": "Ordner wählen",
  "codingWorkbench.repository.unavailable": "nicht verfügbar",
  "codingWorkbench.repository.unavailableHelp":
    "Dieses Repository ist in Git nicht mehr verfügbar. Wähle ein anderes Repository oder verbinde es in Git erneut.",
  "codingWorkbench.repository.reconnect": "Repository erneut verbinden",
  "codingWorkbench.repository.reconnectFailed":
    "Keiko konnte dieses Repository nicht erneut verbinden. Öffne Git, verbinde es dort erneut und wähle es dann noch einmal.",
  "codingWorkbench.repository.reconnectChoiceFailed":
    "Dieser Ordner konnte nicht erneut verbunden werden. Prüfe ihn in Git.",
  "codingWorkbench.repository.changedReason":
    "Seit dem Hinzufügen geändert. Wenn du ihn auswählst, wird der Ordner erneut verbunden.",
  "codingWorkbench.repository.gitUnavailableHelp":
    "Der Git-Status dieses Ordners konnte nicht gelesen werden – möglicherweise ist er kein Git-Repository. Öffne Git, um das zu prüfen.",
  "codingWorkbench.repository.folderModeHint":
    "Kein Git-Repository: Der Agent bearbeitet, führt aus und prüft hier, ohne Commits oder Pushes.",
  "codingWorkbench.repository.folderModeUnsupported":
    "Auf dieser Installation führt Keiko eine Coding-Aufgabe nur in einem neuen Worktree eines Git-Repositorys aus und kann daher nicht in diesem Ordner arbeiten. Wähle ein Git-Repository.",
  "codingWorkbench.repository.deniedHelp":
    "Keiko darf diesen Ordner nicht lesen: Sein Ort ist aus Sicherheitsgründen von der Leseoberfläche ausgeschlossen, etwa weil er im eigenen Zustandsordner eines Werkzeugs liegt, oder der Zugriff wurde verweigert. Das ist eine Richtlinienentscheidung, kein fehlendes Git-Repository. Wähle ein Repository außerhalb dieses Orts oder öffne Git, um die Ablehnung zu sehen.",
  "codingWorkbench.repository.deniedBlocker":
    "Keiko darf diesen Ordner nicht lesen. Wähle ein Repository an einem anderen Ort.",
  "codingWorkbench.repository.loadError":
    "Repositories konnten nicht geladen werden. Aktualisiere die Liste und versuche es erneut.",
  "codingWorkbench.repository.retryLoad": "Erneut versuchen",
  "codingWorkbench.repository.manage": "Git öffnen",
  "codingWorkbench.setup.title": "Code-Einrichtung",
  "codingWorkbench.setup.help":
    "Bereite einen gesteuerten Aufgabenarbeitsbereich für das ausgewählte Repository vor.",
  "codingWorkbench.setup.folderHelp":
    "Öffne den ausgewählten Ordner für den Agenten. Ein Branch ist nicht nötig: Der Agent arbeitet direkt in diesem Ordner.",
  "codingWorkbench.setup.folderBindFailed":
    "Der Ordner konnte nicht für den Workbench geöffnet werden. Prüfe, ob er noch verfügbar ist, und versuche es erneut.",
  "codingWorkbench.setup.repositoryNotConnected":
    "Dieses Repository ist in Git nicht verfügbar. Verbinde es dort erneut und wähle es dann aus.",
  "codingWorkbench.setup.repositoryCatalogUnavailable":
    "Keiko konnte dieses Repository in Git nicht prüfen. Versuche es erneut.",
  "codingWorkbench.setup.submit": "Workspace binden",
  "codingWorkbench.setup.binding": "Wird gebunden…",
  "codingWorkbench.setup.verifying": "Wird verifiziert…",
  "codingWorkbench.setup.reconcileFailed":
    "Der Workspace konnte nicht verifiziert werden. Die Reconciliation hat keinen sauberen, passenden Checkout bestätigt, daher bleibt der Lauf nicht verfügbar. Prüfe das Repository und versuche es erneut.",
  "codingWorkbench.setup.branchConflict":
    "Der Aufgabenbranch für diesen Coding-Lauf existiert bereits. Entferne den früheren Branch oder den zugehörigen verwalteten Arbeitsbereich. Alternativ kannst du einen anderen Zielbranch wählen.",
  "codingWorkbench.setup.invalidBaseBranch":
    "Der Zielbranch existiert in diesem Repository nicht. Gib einen lokal auflösbaren Branch an, zum Beispiel den ausgecheckten Branch.",
  "codingWorkbench.setup.invalidRequest":
    "Keiko kann diesen Repository-Pfad oder Zielbranch so nicht verwenden. Branch-Namen dürfen nur Buchstaben, Ziffern und die Zeichen . _ - / ( ) + @ = , enthalten. Wähle einen anderen Branch oder benenne ihn um und binde dann erneut.",
  "codingWorkbench.setup.missingRepository":
    "Der Repository-Pfad liegt in keinem lokalen Git-Repository. Gib den Pfad eines vorhandenen Checkouts an.",
  "codingWorkbench.setup.unsafePath":
    "Der Repository-Pfad liegt außerhalb der Ordner, die diese Installation binden darf. Wähle einen Ordner innerhalb eines erlaubten Workspace-Roots.",
  "codingWorkbench.setup.lockContention":
    "Eine andere Aktion hält diesen Task Workspace gerade. Warte einen Moment und versuche es dann erneut.",
  "codingWorkbench.setup.provisioningFailed":
    "Keiko konnte den verwalteten Task Workspace für dieses Repository nicht anlegen. Repository-Pfad und Zielbranch wurden akzeptiert; das Aktivitätsprotokoll enthält die Ursache.",
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
  "codingWorkbench.gatewayService.unqualified":
    "Dieser Keiko-Build kann unter Windows keine Coding-Läufe starten. Diese brauchen das Windows-Runtime-Gateway, das nur ein freigegebenes Keiko-Paket nutzen kann. Ein anderes Repository zu wählen, ändert daran nichts.",
  "codingWorkbench.installVolume.notLocal":
    "Coding-Läufe können nicht starten, weil Keiko in einem Netzwerkordner oder einem umgeleiteten Ordner installiert ist. Installiere Keiko auf einem lokalen Laufwerk dieses Computers.",
  "codingWorkbench.installVolume.unverified":
    "Keiko konnte seinen Installationsordner gerade nicht prüfen, weil Windows zu langsam geantwortet hat. Versuch es gleich noch einmal; wenn es so bleibt, starte Keiko neu.",
  "codingWorkbench.runtime.outdated":
    "Coding-Läufe können nicht starten, weil die mit diesem Keiko installierte Coding-Engine eine ältere Version ist, die Keiko nicht mehr freigibt. Aktualisiere Keiko auf die neueste Version.",
  "codingWorkbench.runtime.disabled":
    "Coding-Läufe sind in der Konfiguration dieser Installation deaktiviert. Bitte den Betreiber, die Coding-Runtime zu aktivieren und Keiko neu zu starten.",
  "codingWorkbench.runtime.platformUnqualified":
    "Keiko hat für diese Installation keine unterstützte Coding-Runtime gefunden. Installiere das Keiko-Paket für diesen Computer mit der zugehörigen Runtime und starte Keiko neu.",
  "codingWorkbench.runtime.npmRuntimePackageMissing":
    "Dieses Keiko wurde mit npm installiert, und das Coding-Runtime-Paket für diesen Computer fehlt. Installiere stattdessen das Keiko-Desktop-Paket für diesen Computer (unter Windows: keiko-windows-x64-setup.exe von der Keiko-Release-Seite); es bringt die Coding-Runtime mit.",
  "codingWorkbench.runtime.managedRuntimePackageMissing":
    "Dieser Keiko-Ordner bringt keine Coding-Runtime für diesen Computer mit, deshalb läuft die Coding Workbench hier nicht. Chat und die anderen Fenster funktionieren wie gewohnt. Deine Administration kann ein Keiko-Paket bereitstellen, das die Coding-Runtime enthält.",
  "codingWorkbench.runtime.portableRuntimeUnverified":
    "Diese Keiko-Desktop-Installation konnte ihre mitgelieferte Coding-Runtime nicht prüfen. Aktualisiere Keiko über „Updates prüfen“ oder lade keiko-windows-x64-setup.exe erneut von der Keiko-Release-Seite.",
  "codingWorkbench.runtime.managedRuntimeUnverified":
    "Dieses Keiko konnte seine mitgelieferte Coding-Runtime nicht prüfen, deshalb läuft die Coding Workbench hier nicht. Möglicherweise fehlt eine Datei oder wurde verändert, zum Beispiel durch Sicherheitssoftware. Chat und die anderen Fenster funktionieren wie gewohnt. Deine Administration kann ein frisches Keiko-Paket bereitstellen.",
  "codingWorkbench.runtime.developmentRefused":
    "Die Entwicklungs-Runtime konnte für diesen Checkout nicht aktiviert werden. Prüfe das Dev-Setup und den Ablehnungsgrund im Aktivitätsprotokoll und starte Keiko danach neu.",
  "codingWorkbench.runtime.payloadMissing":
    "In dieser Installation fehlen Dateien, die die Coding-Runtime benötigt. Repariere oder installiere Keiko mit dem zugehörigen Runtime-Paket neu und starte Keiko danach neu.",
  "codingWorkbench.runtime.payloadUnapproved":
    "Die installierte Coding-Runtime ist für diese Keiko-Version nicht freigegeben. Aktualisiere oder installiere Keiko mit der für diese Version vorgesehenen Runtime neu und starte Keiko danach neu.",
  "codingWorkbench.runtime.payloadUnverified":
    "Keiko konnte die Integrität seiner Coding-Runtime-Dateien nicht bestätigen. Repariere oder installiere Keiko aus einem vertrauenswürdigen Paket neu und starte Keiko danach neu.",
  "codingWorkbench.runtime.secureReadUnavailable":
    "Die für Coding-Läufe erforderliche geschützte Dateilesefunktion ist nicht verfügbar. Repariere oder installiere Keiko mit dem zugehörigen Runtime-Paket neu und starte Keiko danach neu.",
  "codingWorkbench.runtime.loopbackUnavailable":
    "Die lokale Verbindung der Coding-Runtime ist nicht richtig konfiguriert. Bitte den Betreiber, den lokalen Server-Port von Keiko zu prüfen und Keiko neu zu starten.",
  "codingWorkbench.setup.repairAndBind": "Reparieren und binden",
  "codingWorkbench.setup.repairing": "Wird repariert…",
  "codingWorkbench.setup.runtimeUnavailable":
    "Auf dieser Installation kann kein Coding-Lauf gestartet werden. Du kannst weiterhin einen Workspace binden. Prüfe die Startdiagnose im Aktivitätsprotokoll, bevor du die Installation änderst.",
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
  "codingWorkbench.timeline.details": "Laufdetails",
  "codingWorkbench.activity.group.read": "{count} Dateien gelesen",
  "codingWorkbench.activity.group.read.one": "1 Datei gelesen",
  "codingWorkbench.activity.group.search": "{count} Suchen ausgeführt",
  "codingWorkbench.activity.group.search.one": "1 Suche ausgeführt",
  "codingWorkbench.activity.group.edit": "{count} Dateien bearbeitet",
  "codingWorkbench.activity.group.edit.one": "1 Datei bearbeitet",
  "codingWorkbench.activity.group.command": "{count} Befehle ausgeführt",
  "codingWorkbench.activity.group.command.one": "1 Befehl ausgeführt",
  "codingWorkbench.activity.group.git": "{count} Git-Schritte ausgeführt",
  "codingWorkbench.activity.group.git.one": "1 Git-Schritt ausgeführt",
  "codingWorkbench.activity.group.web": "{count} Seiten abgerufen",
  "codingWorkbench.activity.group.web.one": "1 Seite abgerufen",
  "codingWorkbench.activity.group.plan": "Aufgabenliste {count}-mal aktualisiert",
  "codingWorkbench.activity.group.plan.one": "Aufgabenliste aktualisiert",
  "codingWorkbench.activity.group.other": "{count} weitere Schritte",
  "codingWorkbench.activity.group.other.one": "1 weiterer Schritt",
  "codingWorkbench.timeline.title": "Aktivität",
  "codingWorkbench.timeline.instructions":
    "Zeitleiste fokussieren und dann mit Pfeil- oder Bild-auf- und Bild-ab-Tasten scrollen.",
  "codingWorkbench.timeline.listLabel": "Coding-Lauf-Ereigniszeitleiste",
  "codingWorkbench.timeline.tool.git_status": "Git-Status",
  "codingWorkbench.timeline.tool.repository_search": "Repository-Suche",
  "codingWorkbench.timeline.tool.workspace_discover": "Workspace-Erkennung",
  "codingWorkbench.timeline.tool.workspace_read": "Workspace-Zugriff",
  "codingWorkbench.timeline.tool.read": "Datei lesen",
  "codingWorkbench.timeline.tool.glob": "Dateien suchen",
  "codingWorkbench.timeline.tool.grep": "In Dateien suchen",
  "codingWorkbench.timeline.tool.list": "Ordner auflisten",
  "codingWorkbench.timeline.tool.edit": "Datei bearbeiten",
  "codingWorkbench.timeline.tool.write": "Datei schreiben",
  "codingWorkbench.timeline.tool.patch": "Patch anwenden",
  "codingWorkbench.timeline.tool.execute": "Programm",
  "codingWorkbench.timeline.tool.unknown": "Werkzeug",
  "codingWorkbench.timeline.tool.shell": "Shell-Befehl",
  "codingWorkbench.timeline.tool.webfetch": "Webabruf",
  "codingWorkbench.timeline.tool.websearch": "Websuche",
  "codingWorkbench.timeline.tool.skill": "Skill",
  "codingWorkbench.timeline.tool.subagent": "Subagent",
  "codingWorkbench.timeline.tool.todo": "Aufgabenliste",
  "codingWorkbench.timeline.tool.question": "Rückfrage",
  "codingWorkbench.timeline.tool.changeset_edit": "Dateien ändern",
  "codingWorkbench.timeline.tool.verification": "Verifikation",
  "codingWorkbench.timeline.tool.research_fetch": "Recherche-Abruf",
  "codingWorkbench.timeline.tool.skill_discover": "Skill-Erkennung",
  "codingWorkbench.timeline.tool.keiko_skill": "Skill",
  "codingWorkbench.timeline.tool.child_agent": "Untergeordneter Agent",
  "codingWorkbench.timeline.tool.git_diff": "Git-Diff",
  "codingWorkbench.timeline.tool.git_stage": "Git-Staging",
  "codingWorkbench.timeline.tool.git_commit": "Git-Commit",
  "codingWorkbench.timeline.tool.git_push": "Git-Push",
  "codingWorkbench.timeline.tool.pull_request": "Pull Request",
  "codingWorkbench.timeline.tool.git_execute": "Git-Vorgang",
  "codingWorkbench.timeline.tool.git_sync": "Git-Synchronisierung",
  "codingWorkbench.timeline.tool.git_branch": "Aufgaben-Branch anlegen",
  "codingWorkbench.timeline.tool.ci_status": "CI-Status",
  "codingWorkbench.changes.title": "Änderungen",
  "codingWorkbench.changes.idle": "Starte einen Lauf, um seine Workspace-Änderungen zu prüfen.",
  "codingWorkbench.changes.loading": "Neueste begrenzte Änderungen werden geladen…",
  "codingWorkbench.changes.bindingLost":
    "Die Aufgaben-Workspace-Bindung des Laufs ist nicht mehr verfügbar. Es wird kein Diff angezeigt.",
  "codingWorkbench.changes.unavailable":
    "Änderungen sind nicht verfügbar. Die App-Sitzung muss möglicherweise erneut gekoppelt werden; es wird kein veraltetes Diff angezeigt.",
  "codingWorkbench.changes.unpaired":
    "Browserfenster nicht gekoppelt — öffne Keiko über den Launcher, um den Aufgaben-Workspace dieses Laufs zu lesen. Es wird kein Diff angezeigt.",
  "codingWorkbench.changes.error":
    "Änderungen konnten nicht aktualisiert werden. Es wird kein veraltetes Diff angezeigt.",
  "codingWorkbench.changes.retry": "Änderungen aktualisieren",
  "codingWorkbench.changes.asOf": "Stand {head}",
  "codingWorkbench.changes.empty":
    "Dieser Lauf enthält in dieser Revision keine Workspace-Änderungen.",
  "codingWorkbench.changes.changedFiles": "{count} geänderte Dateien",
  "codingWorkbench.changes.changedFiles.one": "1 geänderte Datei",
  "codingWorkbench.changes.changedFilesShowing":
    "{count} von {total} geänderten Dateien werden angezeigt",
  "codingWorkbench.changes.virtualInstructions":
    "Liste der geänderten Dateien fokussieren und dann mit Pfeil- oder Bild-auf- und Bild-ab-Tasten scrollen.",
  "codingWorkbench.changes.filesTruncated":
    "Es wurden mehr Dateien geändert, als hier aufgelistet werden können. Es werden nur die ersten angezeigt.",
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
  "codingWorkbench.changes.diff.retry": "Diff erneut laden",
  "codingWorkbench.changes.diff.truncated":
    "Dieses begrenzte Datei-Diff ist unvollständig, weil es das Serverlimit erreicht hat.",
  "codingWorkbench.diffWindow.notice":
    "Dieses Diff ist groß: {rows} Zeilen in {files} Dateien, insgesamt {size}. Es wird jeweils nur eine Datei mit bis zu {page} ihrer Zeilen angezeigt, nichts wird ausgelassen. Wähle eine Datei oder eine Seite, um den Rest zu lesen.",
  "codingWorkbench.diffWindow.files": "Dateien in diesem Diff",
  "codingWorkbench.diffWindow.fileMeta": "+{added} −{removed} · {size} · {rows} Zeilen",
  "codingWorkbench.diffWindow.fileMetaBinary": "Binärdatei",
  "codingWorkbench.diffWindow.position":
    "Datei {file} von {files}, Zeilen {from} bis {to} von {rows}",
  "codingWorkbench.diffWindow.positionEmpty": "Datei {file} von {files}, keine Textzeilen",
  "codingWorkbench.diffWindow.pages": "Seiten dieser Datei",
  "codingWorkbench.diffWindow.previous": "Vorherige Zeilen",
  "codingWorkbench.diffWindow.next": "Nächste Zeilen",
  "codingWorkbench.diffWindow.pageOf": "Seite {page} von {pages}",
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
  "codingWorkbench.richContent.math.region": "Formel",
  "codingWorkbench.richContent.diff.region": "In der Modellantwort gezeigtes Diff",
  "codingWorkbench.richContent.diff.unnamedFile": "Diff",
  "codingWorkbench.richContent.diagram.title": "Diagramm-Quelltext",
  "codingWorkbench.richContent.diagram.region": "Diagramm",
  "codingWorkbench.richContent.diagram.note":
    "Das Diagramm konnte nicht gezeichnet werden. Sein Quelltext wird so gezeigt, wie er geschrieben ist.",
  "codingWorkbench.activity.reasoningBoundary":
    "Diese Zeitleiste zeigt die Konversation, die Arbeitsaktivität und, wenn das Modell sie liefert, seine Überlegungen; sie sind ungeprüft und werden weder im Verlauf noch in Nachweisen gespeichert.",
  "codingWorkbench.activity.reasoning.title": "Überlegungen",
  "codingWorkbench.activity.reasoning.thinking": "Denkt nach…",
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
  "codingWorkbench.activity.outputLimitReached":
    "Diese Antwort hat das Ausgabelimit des Modells erreicht und wurde abgeschnitten.",
  "codingWorkbench.activity.answerLoading": "Der Rest wird geladen …",
  "codingWorkbench.activity.textReadFailed": "Der Rest konnte nicht geladen werden.",
  "codingWorkbench.activity.textRetry": "Erneut versuchen",
  "codingWorkbench.activity.copy.answer": "Antwort als Markdown kopieren",
  "codingWorkbench.activity.copy.copied": "Kopiert",
  "codingWorkbench.activity.copy.copiedStatus": "Antwort als Markdown kopiert",
  "codingWorkbench.activity.copy.failedStatus":
    "Zugriff auf die Zwischenablage fehlgeschlagen. Markiere die Antwort und kopiere sie selbst.",
  "codingWorkbench.activity.role.user": "Du",
  "codingWorkbench.activity.role.assistant": "Coding-Agent",
  "codingWorkbench.activity.role.keiko": "Hinweis von Keiko",
  "codingWorkbench.activity.tool": "Tool-Aktivität: {tool}",
  "codingWorkbench.activity.toolCount": "{count} Aufrufe",
  "codingWorkbench.activity.toolState.pending": "Ausstehend",
  "codingWorkbench.activity.toolState.running": "Wird ausgeführt",
  "codingWorkbench.activity.toolState.succeeded": "Erfolgreich",
  "codingWorkbench.activity.toolState.failed": "Fehlgeschlagen",
  "codingWorkbench.activity.toolState.exited": "Beendet mit Code {code}",
  "codingWorkbench.activity.toolState.waiting-for-trust": "Wartet auf Freigabe",
  "codingWorkbench.activity.toolState.no-runnable-steps": "Nichts auszuführen",
  "codingWorkbench.activity.toolState.not-run": "Nicht ausgeführt",
  "codingWorkbench.activity.toolState.isolation-unavailable": "Hier nicht möglich",
  "codingWorkbench.activity.toolState.dependencies-unavailable": "Abhängigkeiten fehlen",
  "codingWorkbench.activity.toolState.not-done": "Nicht durchgeführt",
  "codingWorkbench.activity.toolState.prepared": "Vorbereitet",
  "codingWorkbench.activity.toolState.waiting-for-approval": "Wartet auf Freigabe",
  "codingWorkbench.activity.toolState.denied": "Abgelehnt",
  "codingWorkbench.activity.toolState.cancelled": "Abgebrochen",
  "codingWorkbench.activity.plan.title": "Aktueller Plan",
  "codingWorkbench.activity.plan.truncated": "Ein Teil dieses Plans wurde ausgelassen.",
  "codingWorkbench.activity.plan.progress": "{completed}/{total} abgeschlossen",
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
    "Die automatische Tool-Calling-Prüfung hat kein kompatibles Coding-Modell bestätigt. Prüfe die Modellfähigkeit und das letzte Readiness-Ergebnis unter Einstellungen → Modelle.",
  "codingWorkbench.source.unavailableReason.non-workflow-eligible":
    "Das Chat-Modell mit Tool-Calling ist nicht workflow-fähig. Aktiviere die Workflow-Eignung unter Einstellungen → Modelle.",
  "codingWorkbench.source.unavailableReason.non-coding-capable":
    "Das konfigurierte Chat-Modell ist nicht codingfähig.",
  "codingWorkbench.source.unavailableReason.deployment-policy-disabled":
    "Die Bereitstellungsrichtlinie deaktiviert die Gateway-Quelle der Coding-Runtime.",
  "codingWorkbench.source.unavailableReason.subscription-source":
    "Die Abo-Quelle ist ausgewählt; das Gateway wird nicht verwendet.",
  "codingWorkbench.source.unavailableReason.model-context-window-insufficient":
    "Das Kontextfenster des konfigurierten Modells ist für einen Coding-Lauf zu klein (mindestens 32.000 Tokens). Keiko hat es automatisch geprüft und konnte 32.000 Tokens nicht bestätigen. Wähle ein größeres Modell oder lass das Gateway max_input_tokens für dieses Modell angeben.",
  "codingWorkbench.source.unavailableReason.model-verification-pending":
    "Keiko prüft dieses Modell noch beim Gateway. Die Workbench aktualisiert sich von selbst, sobald die Prüfung abgeschlossen ist.",
  "codingWorkbench.source.unavailableReason.conversation-not-ready":
    "Dieses Modell ist nicht aktiviert oder hat seine Bereitschaftsprüfung nicht bestanden. Aktiviere es in Einstellungen > Modelle oder wähle ein anderes aktiviertes Modell.",
  "codingWorkbench.source.unavailableReason.tool-calling-unverified":
    "Das Gateway hat noch nicht bestätigt, dass dieses Modell Tools aufrufen kann. Wähle Tool-Aufrufe prüfen, um es jetzt zu prüfen, oder wähle ein anderes bereites Modell.",
  "codingWorkbench.source.unavailableReason.conversation-not-activated":
    "{model} ist in dieser Sitzung noch nicht aktiviert.",
  "codingWorkbench.source.unavailableReason.conversation-check-failed":
    "{model} hat die Bereitschaftsprüfung nicht bestanden.",
  "codingWorkbench.source.unavailableReason.conversation-request-failed":
    "Keiko konnte das Gateway nicht erreichen, um {model} zu aktivieren.",
  "codingWorkbench.modelActivation.action": "{model} aktivieren",
  "codingWorkbench.modelActivation.settings": "Details unter Einstellungen > Modelle",
  "codingWorkbench.toolCheck.action": "Tool-Aufrufe prüfen",
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
  "codingWorkbench.controls.help":
    "Die Auslieferung folgt dem serverbestätigten Modus und dem validierten Authority Envelope. Merge bleibt separat genehmigungspflichtig.",
  "codingWorkbench.controls.stop": "Lauf anhalten",
  "codingWorkbench.controls.resumeMode.label": "Autonomie beim Fortsetzen",
  "codingWorkbench.controls.resumeMode.help":
    "Setze den Lauf mit dem serverbestätigten aktuellen oder einem strengeren Modus fort. Eine Erweiterung ist nicht verfügbar.",
  "codingWorkbench.approval.eyebrow": "Genehmigung erforderlich",
  "codingWorkbench.approval.details": "Details",
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
  "codingWorkbench.approval.actionKind.git-unstage": "Vormerkung zurücknehmen",
  "codingWorkbench.approval.actionKind.git-fetch": "Vom Remote abrufen",
  "codingWorkbench.approval.actionKind.git-pull": "Vom Remote vorspulen (Fast-Forward)",
  "codingWorkbench.approval.actionKind.git-branch": "Aufgaben-Branch anlegen und wechseln",
  "codingWorkbench.approval.actionKind.verification-command": "Verifikationsbefehl",
  "codingWorkbench.approval.actionKind.ci-observe": "CI-Statusabfrage",
  "codingWorkbench.approval.actionKind.connector-read": "Connector-Lesezugriff",
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
  "codingWorkbench.approval.connectorScope.issue-tracker.admin": "Verwaltung der Jira-Instanz",
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
    "Reagiere auf die ausstehende Berechtigungsanfrage, um diese Übermittlung freizugeben oder abzulehnen.",
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
  "codingWorkbench.draftDelivery.remoteName": "Remote-Ziel",
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
  "codingWorkbench.descriptionStatus.reason.fallback-output-refused":
    "Deterministisch erstellt; die Antwort des Modells wurde als unsicher oder ungültig abgelehnt.",
  "codingWorkbench.descriptionStatus.reason.stale-snapshot":
    "Die Änderung hat sich seit der Entwurfserstellung weiterentwickelt.",
  "codingWorkbench.descriptionStatus.reason.expired":
    "Der erzeugte Entwurf wird nicht mehr vorgehalten. Die Änderung selbst ist unverändert.",
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
  "codingWorkbench.descriptionStatus.write": "Beschreibung verfassen",
  "codingWorkbench.descriptionStatus.unavailable":
    "Dieser gespeicherte Entwurf ist nicht mehr verfügbar. Aktualisiere den Laufstatus.",
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
  "codingWorkbench.commitResult.reason.buffers-dirty":
    "Geöffnete Dateien haben ungespeicherte Änderungen im Editor, die sich nicht vormerken lassen. Speichere sie, verifiziere die vorgemerkte Änderung und schlage den Commit dann erneut vor.",
  "codingWorkbench.commitResult.reason.candidate-not-staged":
    "Ein Teil der Änderung ist noch nicht vorgemerkt. Merke ihn vor, verifiziere die vorgemerkte Änderung und schlage den Commit dann erneut vor.",
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
  "codingWorkbench.commitResult.reason.signing-failed":
    "Git konnte diesen Commit nicht signieren. Prüfe deine Git-Signatureinrichtung und committe dann erneut.",
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
  "codingWorkbench.commitResult.preflight.verified-commit-drifted":
    "Der überprüfte Commit stimmt nicht mehr mit dem aktuellen Stand des Branches überein",
  "codingWorkbench.commitResult.preflight.source-branch-not-checked-out":
    "Der für diesen Push angegebene Branch ist nicht der ausgecheckte Branch",
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
  "codingWorkbench.approval.gitBranch.title": "Aufgaben-Branch {branch} anlegen und wechseln",
  "codingWorkbench.approval.gitBranch.branch": "Anzulegender Branch",
  "codingWorkbench.approval.changes.title": "Dateien, die diese Änderung schreiben würde",
  "codingWorkbench.approval.changes.files": "Dateien",
  "codingWorkbench.approval.changes.lines": "Zeilen",
  "codingWorkbench.approval.changes.lineCounts": "+{added} / -{deleted}",
  "codingWorkbench.approval.changes.truncated":
    "Es werden nur die ersten {shown} von {total} Dateien aufgeführt.",
  "codingWorkbench.approval.changes.scope": "Umfang: {scope}",
  "codingWorkbench.approval.changes.scopeWorkspace": "Umfang: gesamter Arbeitsbereich (.)",
  "codingWorkbench.approval.changes.countsUnavailable":
    "Die Zeilenzahlen sind nicht verfügbar, weil eine Datei zu groß zum Zählen ist.",
  "codingWorkbench.approval.changes.loading": "Geänderte Dateien werden geladen …",
  "codingWorkbench.approval.changes.unavailable":
    "Geänderte Dateien nicht abrufbar. Fenster erneut koppeln, um sie vor der Entscheidung zu sehen.",
  "codingWorkbench.approval.changes.retry": "Geänderte Dateien erneut laden",
  "codingWorkbench.approval.help":
    "Unverarbeitete Befehle, Prompts, Diffs und Dateiinhalte bleiben verborgen.",
  "codingWorkbench.approval.verification.title": "Was Freigeben ausführt",
  "codingWorkbench.approval.verification.commands": "Befehle, die Keiko ausführt",
  "codingWorkbench.approval.verification.help":
    "Der Befehl wird so gezeigt, wie Keiko ihn ausführt; Zugangsdaten sind maskiert.",
  "codingWorkbench.approval.verification.truncated":
    "Ein sehr langer Befehl wird abgeschnitten und endet mit …",
  "codingWorkbench.approval.verification.loading": "Der Befehl wird ermittelt …",
  "codingWorkbench.approval.verification.deferred.targeted-test":
    "Keiko führt nach der Freigabe die Tests für die geänderte Datei aus.",
  "codingWorkbench.approval.verification.deferred.package-selection":
    "Keiko wählt nach der Freigabe den Testbefehl des Pakets.",
  "codingWorkbench.approval.verification.deferred.host-setup":
    "Was hier ausgeführt wird, hängt von der Einrichtung dieses Computers ab; Keiko entscheidet nach der Freigabe.",
  "codingWorkbench.approval.verification.unavailable":
    "Keiko konnte den Befehl nicht ermitteln, daher wird nur die Art der Prüfung gezeigt.",
  "codingWorkbench.approval.native.title": "Was der Agent ausführen möchte",
  "codingWorkbench.approval.native.help": "Erlaubt genau diese Aktion einmal.",
  "codingWorkbench.approval.native.help.shell":
    "Führt diesen Befehl einmal im Aufgaben-Workspace aus.",
  "codingWorkbench.approval.native.help.edit":
    "Wendet diese Änderung einmal auf die aufgeführten Dateien an.",
  "codingWorkbench.approval.native.help.internet":
    "Erlaubt diese eine Internetanfrage. Internetzugriff gibt es nur im Modus Vollzugriff.",
  "codingWorkbench.approval.native.help.execute":
    "Führt dieses Code-Mode-Programm einmal in der Skript-Sandbox von OpenCode aus.",
  "codingWorkbench.approval.native.help.worktree":
    "Legt einen neuen Aufgaben-Workspace auf eigenem Branch an; dieser Lauf bleibt hier.",
  "codingWorkbench.approval.native.help.jira": "Nimmt genau diese Änderung in Jira vor, einmalig.",
  "codingWorkbench.approval.native.help.schedule":
    "Ändert, wann Keiko diese Aufgabe selbst fortsetzt, im Modus, den du dafür gewählt hast.",
  "codingWorkbench.approval.native.resources": "Angeforderter Befehl, Pfade oder Adressen",
  "codingWorkbench.approval.native.noResources":
    "Weder Befehl noch Pfad noch Adresse wurde genannt.",
  "codingWorkbench.approval.native.nothingNamed":
    "Die Genehmigung ist gesperrt, weil diese Anfrage weder Befehl noch Pfad noch Adresse nennt. Ablehnen lässt den Agenten weiterarbeiten.",
  "codingWorkbench.approval.native.loading": "Angeforderte Aktion wird geladen…",
  "codingWorkbench.approval.native.unavailable":
    "Die angeforderte Aktion ist nicht abrufbar. Fenster erneut koppeln, um sie vor der Entscheidung zu sehen.",
  "codingWorkbench.approval.native.retry": "Angeforderte Aktion erneut laden",
  "codingWorkbench.approval.native.permission.shell": "Shell-Befehl",
  "codingWorkbench.approval.native.permission.edit": "Dateiänderung",
  "codingWorkbench.approval.native.permission.write": "Dateiänderung",
  "codingWorkbench.approval.native.permission.patch": "Dateiänderung",
  "codingWorkbench.approval.native.permission.webfetch": "Webabruf",
  "codingWorkbench.approval.native.permission.websearch": "Websuche",
  "codingWorkbench.approval.native.permission.execute": "Code-Mode-Skript",
  "codingWorkbench.approval.native.permission.worktree": "Neuer Task-Workspace",
  "codingWorkbench.approval.native.permission.jira": "Jira-Änderung",
  "codingWorkbench.approval.native.permission.schedule": "Geplante Fortsetzung",
  "codingWorkbench.approval.native.permission.other": "Native Aktion",
  "codingWorkbench.approval.native.label.native-shell": "Nativer Shell-Befehl",
  "codingWorkbench.approval.native.label.native-edit": "Native Dateiänderung",
  "codingWorkbench.approval.native.label.native-egress": "Nativer Internetzugriff",
  "codingWorkbench.approval.native.label.native-execute": "Natives Code-Mode-Skript",
  "codingWorkbench.approval.native.label.native-read": "Natives Lesen",
  "codingWorkbench.approval.native.label.native-schedule": "Nativer Zeitplan",
  "codingWorkbench.approval.evidenceRequired":
    "Die Genehmigung bleibt gesperrt, bis geladen ist, was diese Anfrage berühren würde. Wiederhole diesen Abruf oder lehne die Anfrage ab.",
  "codingWorkbench.approval.approve": "Einmal genehmigen",
  "codingWorkbench.approval.deny": "Ablehnen",
  "codingWorkbench.changesetReview.eyebrow": "Änderungsprüfung",
  "codingWorkbench.changesetReview.title": "Vorgeschlagene Dateiänderung prüfen",
  "codingWorkbench.changesetReview.help":
    "Der Task ist pausiert, damit du diese genaue Änderung vor dem Schreiben bestätigen kannst.",
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
    "Keiko weiß nicht, ob die letzte Aktion durchgegangen ist, zum Beispiel eine Änderung in Jira oder eine Dateiänderung. Prüfe zuerst dort das Ergebnis. Keiko sendet sie nie von selbst erneut.",
  "codingWorkbench.recovery.summaryNoAction":
    "Laut dem Aktivitätsprotokoll von Keiko hatte keine Aktion begonnen. Prüfe deinen Arbeitsbereich, wenn du unsicher bist, und wiederhole dann den Lauf.",
  "codingWorkbench.recovery.retry": "Als neuen Lauf wiederholen",
  "codingWorkbench.recovery.acknowledge": "Wiederherstellung bestätigen",
  "codingWorkbench.recovery.newTask": "Neue Aufgabe starten",
  "codingWorkbench.recovery.retryHint":
    "Um die Aufgabe als neuen Lauf zu wiederholen, beschreibe sie im Feld darunter. Oder starte eine neue Aufgabe.",
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
  "codingWorkbench.runStatus.elapsed": "Läuft seit {duration}",
  "codingWorkbench.runStatus.duration": "Dauer {duration}",
  "codingWorkbench.runStatus.duration.seconds": "{seconds} s",
  "codingWorkbench.runStatus.duration.minutes": "{minutes} Min. {seconds} s",
  "codingWorkbench.runStatus.duration.hours": "{hours} Std. {minutes} Min.",
  "codingWorkbench.runStatus.phase.model": "Wartet auf das Modell",
  "codingWorkbench.runStatus.nativeRetry": "OpenCode-Versuch {attempt} geplant für {scheduledAt}",
  "codingWorkbench.runStatus.phase.gateway": "Modell-Gateway nicht erreichbar, neuer Versuch",
  "codingWorkbench.runStatus.phase.verifier": "Führt eine Prüfung aus",
  "codingWorkbench.runStatus.phase.tool": "Führt ein Werkzeug aus",
  "codingWorkbench.runStatus.phase.decision": "Wartet auf deine Entscheidung",
  "codingWorkbench.runStatus.readiness": "Bereitschaftsdetails",
  "codingWorkbench.runStatus.agent.plan": "Plan-Agent",
  "codingWorkbench.runStatus.answeredWithoutTools":
    "Das Modell hat geantwortet, ohne Werkzeuge zu nutzen. Es wurden keine Dateien geändert und keine Befehle ausgeführt.",
  "codingWorkbench.runStatus.stopCause.server-shutdown-waiting":
    "Keiko wurde geschlossen, während dieser Lauf auf deine Freigabe wartete. Prüfe den Arbeitsbereich, bevor du die Aufgabe erneut startest.",
  "codingWorkbench.runStatus.stopCause.server-shutdown-working":
    "Keiko wurde geschlossen, während dieser Lauf arbeitete. Bereits begonnene Änderungen sind möglicherweise unvollständig. Starte die Aufgabe erneut, um fortzufahren.",
  "codingWorkbench.resourceStatus.unavailable": "Nicht verfügbar",
  "codingWorkbench.announcement.runChecking": "Laufstatus wird geprüft.",
  "codingWorkbench.announcement.noActiveRun": "Kein aktiver Coding-Lauf.",
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
  "codingWorkbench.event.operator-decision": "Deine Entscheidung nötig",
  "codingWorkbench.event.failure-redacted": "Fehler gemeldet",
  "codingWorkbench.event.native-retry-changed": "OpenCode-Wiederholungsstatus aktualisiert",
  "codingWorkbench.event.model-gateway-retrying": "Modell-Gateway nicht erreichbar, neuer Versuch",
  "codingWorkbench.event.model-gateway-recovered": "Modell-Gateway antwortet wieder",
  "codingWorkbench.event.model-gateway-retry-stopped": "Wiederholung beim Modell-Gateway beendet",
  "codingWorkbench.event.detail": "Seq. {sequence} · Rev. {revision}",
  "codingWorkbench.event.detailFailure": "Seq. {sequence} · Rev. {revision} · Fehler: {failure}",
  "codingWorkbench.event.failure.edits-blocked":
    "Keiko hat den Lauf beendet, weil seine Änderungen mehrmals hintereinander aus einem Grund abgelehnt wurden, den das Modell durch eine andere Änderung nicht beheben kann: etwa weil keine Coding Workbench für diesen Arbeitsbereich verbunden ist, der Zugriff auf den Arbeitsbereich verloren ging oder der Pfad durch eine Richtlinie geschützt ist. Behebe diese Ursache, halte zum Beispiel die Coding Workbench für diesen Arbeitsbereich geöffnet, und starte die Aufgabe dann erneut; deine bisherigen Änderungen bleiben im Aufgaben-Arbeitsbereich.",
  "codingWorkbench.event.failure.edit-retries-exhausted":
    "Keiko hat den Lauf beendet, weil die Änderungen des Modells mehrmals hintereinander abgelehnt wurden, etwa weil sie nicht mehr zur Datei passten. Starte die Aufgabe erneut, formuliere sie um oder teile sie auf, oder wähle ein anderes Modell; deine bisherigen Änderungen bleiben im Aufgaben-Arbeitsbereich.",
  "codingWorkbench.event.failure.runtime":
    "Keiko hat den Lauf nach den angezeigten Aktionen wegen eines internen Fehlers beendet. Starte die Aufgabe erneut. Tritt der Fehler wieder auf, erstelle unten einen Fehlerbericht und gib ihn an deinen Support weiter.",
  "codingWorkbench.event.failure.invalid-intent":
    "Keiko hat die Aufgabe abgelehnt, bevor sie lief, zum Beispiel weil eine mit @ referenzierte Datei fehlt, außerhalb des Arbeitsbereichs liegt oder geschützt ist, oder weil der Slash-Befehl nicht verfügbar ist. Prüfe die referenzierten Dateien und den Befehl und starte die Aufgabe dann erneut.",
  "codingWorkbench.event.failure.workspace-unqualified":
    "Keiko lässt in diesem Ordner keinen Agenten arbeiten, weil er Keikos eigene Installation enthält, die der Agent sonst verändern könnte. Wähle einen Projektordner außerhalb der Keiko-Installation und starte die Aufgabe dann erneut.",
  "codingWorkbench.event.failure.runtime-supervisor-grants-acl":
    "Keiko konnte den Coding-Lauf auf diesem Windows-Computer nicht starten, weil Windows Keiko nicht erlaubt hat, seinen eigenen Ordner zu nutzen. Verschiebe oder kopiere den Keiko-Ordner in einen Ordner, der dir gehört, zum Beispiel in deinen eigenen Benutzerordner, und starte die Aufgabe dann erneut. Geht das nicht, bitte deine Administration um Hilfe.",
  "codingWorkbench.event.failure.runtime-supervisor-grants-directory":
    "Keiko konnte den Coding-Lauf auf diesem Windows-Computer nicht starten, weil es einen Ordner nicht öffnen konnte, den es braucht. Prüfe, ob der Keiko-Ordner noch existiert und in einem Ordner liegt, der dir gehört, zum Beispiel in deinem eigenen Benutzerordner, und starte die Aufgabe dann erneut. Hilft das nicht, bitte deine Administration um Hilfe.",
  "codingWorkbench.event.failure.runtime-supervisor-grants-capability":
    "Keiko konnte den Coding-Lauf auf diesem Windows-Computer nicht starten, weil Windows dem Lauf nicht erlaubt hat, den Aufgabenordner zu lesen. Prüfe, ob der Ordner noch auf einem Laufwerk dieses Computers existiert und du ihn öffnen darfst, und starte die Aufgabe dann erneut. Hilft das nicht, bitte deine Administration um Hilfe.",
  "codingWorkbench.event.failure.runtime-supervisor-gateway-connect":
    "Keiko konnte den Coding-Lauf auf diesem Windows-Computer nicht starten, weil der Windows-Dienst, den Keiko für Coding-Läufe braucht, nicht geantwortet hat. Wähle oben in der Coding Workbench Reparieren, falls angeboten, und starte die Aufgabe dann erneut. Hilft das nicht, bitte deine Administration um Hilfe.",
  "codingWorkbench.event.failure.runtime-supervisor-gateway-admit":
    "Keiko konnte den Coding-Lauf auf diesem Windows-Computer nicht starten, weil der Windows-Dienst, den Keiko für Coding-Läufe braucht, ihn nicht angenommen hat. Wähle oben in der Coding Workbench Reparieren, falls angeboten, und starte die Aufgabe dann erneut. Hilft das nicht, bitte deine Administration um Hilfe.",
  "codingWorkbench.event.failure.runtime-supervisor-no-desktop":
    "Keiko konnte den Coding-Lauf auf diesem Windows-Computer nicht starten, weil Keiko nicht in einer angemeldeten Desktop-Sitzung gestartet wurde, zum Beispiel über eine Remote-Shell oder als Dienst. Starte Keiko auf dem Desktop eines angemeldeten Windows-Benutzers und starte die Aufgabe dann erneut.",
  "codingWorkbench.event.failure.runtime-supervisor-image-path":
    "Keiko konnte den Coding-Lauf auf diesem Windows-Computer nicht starten, weil der Pfad des Keiko-Ordners zu lang ist. Verschiebe den Keiko-Ordner an einen kürzeren Pfad, zum Beispiel direkt unter deinen Benutzerordner, und starte Keiko und die Aufgabe dann erneut.",
  "codingWorkbench.event.failure.runtime-supervisor-refused":
    "Keiko konnte den Coding-Lauf auf diesem Windows-Computer nicht starten, weil Windows den Start verweigert hat. Starte die Aufgabe erneut. Tritt es wieder auf, bitte deine Administration um Hilfe.",
  "codingWorkbench.event.failure.generic":
    "Dieser Schritt konnte nicht abgeschlossen werden. Versuche es erneut. Tritt der Fehler wieder auf, erstelle unten einen Fehlerbericht und gib ihn an deinen Support weiter.",
  "codingWorkbench.event.failure.envelope-duration-exhausted":
    "Der Lauf hat sein Zeitlimit aufgebraucht – wie lange ein Lauf arbeiten darf –, deshalb endete er, bevor die Aufgabe erledigt war. Das ist ein Limit, kein Fehler. Deine bisherigen Änderungen bleiben im Aufgaben-Arbeitsbereich: Starte die Aufgabe als neuen Lauf mit frischem Zeitlimit erneut oder teile sie in kleinere Aufgaben auf. Das Limit wird mit KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES eingestellt, bis höchstens 480 Minuten; das ist auch der Standard. Keiko liest die Einstellung nur beim Start: Nach einer Änderung muss Keiko neu gestartet werden.",
  "codingWorkbench.event.failure.output-limit-reached":
    "Das Modell hat das Ausgabekontingent eines Schritts aufgebraucht, meist weil es lange nachgedacht hat, bevor es geantwortet oder ein Werkzeug genutzt hat. Deshalb hat Keiko den Lauf beendet. Deine bisherigen Änderungen bleiben im Aufgaben-Arbeitsbereich. Starte die Aufgabe erneut oder teile sie in kleinere Schritte auf. Tritt es wieder auf, wähle ein anderes Modell oder bitte deine Administration, das Ausgabelimit des Modells zu erhöhen.",
  "codingWorkbench.event.failure.output-exhausted-repeated":
    "Der Lauf wurde beendet, weil das Modell sein gesamtes Ausgabebudget erneut verbraucht hat, ohne ein Werkzeug aufzurufen oder zu antworten – auch nach einem Reparaturversuch. Meist verbraucht das Modell dieses Budget mit Reasoning. Lass das Gateway ein größeres max_output_tokens für dieses Modell melden oder wähle ein Modell mit geringerem Reasoning-Anteil, und starte die Aufgabe dann erneut; deine bisherigen Änderungen bleiben im Aufgaben-Arbeitsbereich.",
  "codingWorkbench.event.stopped":
    "Dieser Lauf wurde gestoppt. Nichts ist fehlgeschlagen, und deine bisherigen Änderungen bleiben im Aufgaben-Arbeitsbereich.",
  "codingWorkbench.event.failure.provider-unavailable":
    "Der Lauf wurde beendet, weil der Modellanbieter nicht erreichbar war oder aufgehört hat zu antworten – auch nachdem Keiko gewartet und es erneut versucht hat. Abgelehnt wurde nichts. Prüfe, ob das Modell-Gateway und sein Anbieter laufen, und starte die Aufgabe dann erneut; deine bisherigen Änderungen bleiben im Aufgaben-Arbeitsbereich. Ein Betreiber kann die Wartezeit mit der Gateway-Einstellung codingOutageWindowMs verlängern.",
  "codingWorkbench.event.failure.model-turn-failed":
    "Der Lauf wurde beendet, weil sein letzter Modellschritt fehlgeschlagen ist – den Grund zeigt dieser Schritt oben. Behebe diesen Grund und starte die Aufgabe dann erneut; deine bisherigen Änderungen bleiben im Aufgaben-Arbeitsbereich.",
  "codingWorkbench.event.failure.verification-not-evidenced":
    "Die Aufgabe ist nicht verifiziert: Die Prüfungen sind fehlgeschlagen, wurden nicht ausgeführt oder fanden vor der letzten Änderung statt. Deine Änderungen bleiben im Aufgaben-Arbeitsbereich. Prüfe das letzte Verifikationsergebnis, behebe die Ursache und führe die passenden Prüfungen erneut aus, bevor die Aufgabe abgeschlossen wird.",
  "codingWorkbench.event.failure.verificationGap.no-check-run":
    "Die Änderungen am Code des Projekts wurden nicht geprüft: Nach der letzten Änderung lief keine Prüfung, also zeigt nichts, dass sie funktionieren. Deine Änderungen bleiben im Aufgaben-Arbeitsbereich. Lass Keiko die Prüfung des Projekts ausführen und beheben, was sie findet, oder nenne unten, welche Prüfung laufen soll.",
  "codingWorkbench.event.failure.verificationGap.check-failed":
    "Nach der letzten Änderung ist eine Prüfung fehlgeschlagen, und der Lauf endete, bevor sie behoben war. Deine Änderungen bleiben im Aufgaben-Arbeitsbereich. Lass Keiko sie erneut ausführen und die Ursache beheben, oder beschreibe unten die Korrektur.",
  "codingWorkbench.event.failure.verificationGap.check-not-started":
    "Die Prüfung konnte nicht starten, deshalb wurden die Änderungen nicht geprüft. Der Schritt darüber nennt den Grund, zum Beispiel eine abgelehnte Berechtigung oder ein Werkzeug, das auf diesem Computer fehlt. Deine Änderungen bleiben im Aufgaben-Arbeitsbereich. Beseitige diesen Grund und lass Keiko die Prüfung dann erneut ausführen.",
  "codingWorkbench.event.failure.verificationGap.budget-exhausted":
    "Der Lauf hat sein Budget an Werkzeugaufrufen oder geänderten Bytes verbraucht, bevor eine Prüfung laufen konnte, deshalb wurden die Änderungen nicht geprüft. Deine Änderungen bleiben im Aufgaben-Arbeitsbereich. Starte einen neuen Lauf, um sie mit frischem Budget zu prüfen.",
  "codingWorkbench.event.runCheck.action": "Prüfung nachholen",
  "codingWorkbench.event.runCheck.request":
    "Führe jetzt die Prüfung des Projekts aus (Tests, Typprüfung oder Build), behebe einen Fehler, den du beheben kannst, und sag mir das Ergebnis.",
  "codingWorkbench.event.runFailed": "Coding-Lauf fehlgeschlagen",
  "codingWorkbench.event.runUnverified": "Änderungen nicht geprüft",
  "codingWorkbench.event.turnFailure.provider-failed":
    "Der Modellanbieter hat diesen Schritt abgelehnt. Prüfe Gateway-Konfiguration und Bereitschaft des gewählten Modells und versuche es erneut.",
  "codingWorkbench.event.turnFailure.stream-incomplete":
    "Der Antwort-Stream des Modells endete vor Abschluss des Schritts. Prüfe die Verbindung zum Anbieter und versuche es erneut.",
  "codingWorkbench.event.turnFailure.turn-rejected":
    "Das Modell oder eine Schutzprüfung der Workbench hat diesen Schritt abgelehnt. Prüfe die Gateway- und Berechtigungsdiagnose des Runs und passe Modell, Aufgabe oder Berechtigungen vor einem erneuten Versuch an.",
  "codingWorkbench.event.turnFailure.output-exhausted":
    "Das Modell hat sein gesamtes Ausgabebudget verbraucht, bevor eine Antwort entstand – meist durch Reasoning. Lass das Gateway ein größeres max_output_tokens für dieses Modell melden oder wähle ein Modell mit geringerem Reasoning-Anteil, und versuche es erneut.",
  "codingWorkbench.event.turnFailure.empty-answer":
    "Das Modell hat diesen Schritt ohne Text und ohne Werkzeugaufruf beendet. Der Anbieter hat geantwortet, es ist also kein Verbindungsproblem. Versuche den Schritt erneut; wiederholt es sich, formuliere die Aufgabe um oder wähle ein anderes Modell.",
  "codingWorkbench.event.turnFailure.invalid-tool-call":
    "Das Modell hat bei jedem Versuch ein Werkzeug mit Argumenten aufgerufen, die nicht zum Werkzeug passen. Der Anbieter hat geantwortet, es ist also kein Verbindungsproblem. Versuche den Schritt erneut; wiederholt es sich, formuliere die Aufgabe um oder wähle ein anderes Modell.",
  "codingWorkbench.event.turnCause.provider-failed":
    "Das Modell-Gateway hat diesen Schritt nicht abgeschlossen.",
  "codingWorkbench.event.turnCause.stream-incomplete":
    "Der Antwortstream des Modells endete, bevor dieser Schritt abgeschlossen war.",
  "codingWorkbench.event.turnCause.turn-rejected":
    "Das Modell oder eine Workbench-Sicherheitsprüfung hat diesen Schritt nicht angenommen.",
  "codingWorkbench.event.turnCause.output-exhausted":
    "Das Modell hat sein Ausgabebudget verbraucht, bevor dieser Schritt abgeschlossen war.",
  "codingWorkbench.event.turnCause.empty-answer":
    "Das Modell hat diesen Schritt ohne Antwort oder Tool-Aufruf beendet.",
  "codingWorkbench.event.turnCause.invalid-tool-call":
    "Das Modell hat für diesen Schritt keinen gültigen Tool-Aufruf erzeugt.",
  "codingWorkbench.event.turnProgress.active": "Die Aufgabe läuft weiter.",
  "codingWorkbench.event.turnProgress.gateway-retrying":
    "Keiko versucht den Aufruf des Modell-Gateways automatisch erneut.",
  "codingWorkbench.verification.result": "{verifier}: {status}",
  "codingWorkbench.verification.verifier.test": "Tests",
  "codingWorkbench.verification.verifier.targeted-test": "Gezielte Tests",
  "codingWorkbench.verification.verifier.typecheck": "Typprüfung",
  "codingWorkbench.verification.verifier.lint": "Lint",
  "codingWorkbench.verification.verifier.build": "Build",
  "codingWorkbench.verification.status.passed": "Bestanden",
  "codingWorkbench.verification.status.failed": "Fehlgeschlagen",
  "codingWorkbench.verification.status.partial": "Teilweise",
  "codingWorkbench.verification.status.notRun": "Nicht gelaufen",
  "codingWorkbench.verification.checks":
    "Prüfungen: {passed} bestanden, {failed} nicht erfolgreich, {skipped} übersprungen",
  "codingWorkbench.verification.checksWithBlocked":
    "Prüfungen: {passed} bestanden, {failed} nicht erfolgreich, {blocked} blockiert, {skipped} übersprungen",
  "codingWorkbench.verification.duration": "Dauer: {duration}",
  "codingWorkbench.activity.readBytes": "Gelesen: {bytes} Bytes",
  "codingWorkbench.activity.readFacts": "Gelesen: {bytes} Bytes · Ganze Datei: {lines} Zeilen",
  "codingWorkbench.activity.returnedPaths": "Zurückgegebene Pfade: {count}",
  "codingWorkbench.activity.editRefusalNotUtf8":
    "Die Datei blieb unverändert, weil sie nicht als UTF-8-Text gespeichert ist.",
  "codingWorkbench.activity.editRefusal.DIRTY":
    "Die Datei hat ungespeicherte Änderungen im Editor, daher wurde die Änderung nicht übernommen.",
  "codingWorkbench.activity.editRefusal.VERSION_MISMATCH":
    "Die Datei hat sich geändert, seit der Agent sie gelesen hat, daher wurde die Änderung nicht übernommen.",
  "codingWorkbench.activity.editRefusal.CONTENT_HASH_MISMATCH":
    "Die Datei hat sich geändert, seit der Agent sie gelesen hat, daher wurde die Änderung nicht übernommen.",
  "codingWorkbench.activity.editRefusal.NO_ACTIVE_SESSION":
    "Für diese Datei war keine Editor-Sitzung offen.",
  "codingWorkbench.activity.editRefusal.NO_ACTIVE_BRIDGE":
    "Der Editor war nicht verbunden, daher wurde die Änderung nicht übernommen.",
  "codingWorkbench.activity.editRefusal.INVALID_EDITS":
    "Die angeforderte Änderung passte nicht zur Datei.",
  "codingWorkbench.activity.editRefusal.OUT_OF_SCOPE":
    "Die Datei liegt außerhalb des Ordners, den diese Aufgabe ändern darf.",
  "codingWorkbench.activity.editRefusal.DECOMPOSE_PER_ROOT":
    "Die Änderung betraf mehr als einen Ordner und muss aufgeteilt werden.",
  "codingWorkbench.activity.editRefusal.PRECONDITION_REQUIRED":
    "Die Änderung nannte keine Fassung der Datei.",
  "codingWorkbench.activity.editRefusal.POLICY_DENIED":
    "Keikos Regeln erlauben diese Änderung nicht.",
  "codingWorkbench.activity.editRefusal.APPROVAL_REQUIRED":
    "Diese Änderung braucht zuerst deine Freigabe.",
  "codingWorkbench.activity.editRefusal.TIMED_OUT":
    "Die Änderung dauerte zu lange und wurde beendet.",
  "codingWorkbench.activity.editRefusal.QUEUE_FULL":
    "Zu viele Änderungen warteten, daher wurde diese nicht angenommen.",
  "codingWorkbench.activity.editRefusal.CANCELLED": "Die Änderung wurde abgebrochen.",
  "codingWorkbench.activity.editRefusal.PROVIDER_UNAVAILABLE":
    "Der Editor-Dienst war nicht verfügbar.",
  "codingWorkbench.activity.editRefusal.UNSUPPORTED_OPERATION":
    "Diese Art von Änderung kann der Editor nicht ausführen.",
  "codingWorkbench.activity.editRefusal.LIMIT_EXCEEDED": "Die Änderung war größer als erlaubt.",
  "codingWorkbench.activity.editRefusal.DUPLICATE_ACTION":
    "Dieselbe Änderung war bereits angefordert.",
  "codingWorkbench.activity.editRefusal.MUTATION_IN_FLIGHT":
    "Eine andere Änderung an dieser Datei lief noch.",
  "codingWorkbench.activity.editRefusal.RESPONSE_TOO_LARGE": "Die Antwort des Editors war zu groß.",
  "codingWorkbench.activity.editRefusal.TRANSPORT_FAILURE":
    "Die Verbindung zum Editor ist fehlgeschlagen.",
  "codingWorkbench.activity.editRefusal.REDIRECT_BLOCKED":
    "Die Änderung wurde umgeleitet; Keiko folgt keiner Umleitung.",
  "codingWorkbench.activity.editRefusal.EDIT_TRANSPORT_ERROR":
    "Die Änderung hat den Editor nicht erreicht.",
  "codingWorkbench.activity.editRefusal.EDIT_PREPARE_FAILED":
    "Die Änderung konnte nicht vorbereitet werden.",
  "codingWorkbench.activity.editRefusal.WORKSPACE_ACCESS_LOST":
    "Keiko hat den Zugriff auf den Arbeitsordner verloren.",
  "codingWorkbench.activity.editRefusal.EDIT_MUTATION_FAILED":
    "Das Schreiben der Änderung in die Datei ist fehlgeschlagen.",
  "codingWorkbench.activity.editRefusal.ci-observation-required":
    "Die Änderung wartet zuerst auf das CI-Ergebnis.",
  "codingWorkbench.activity.affectedFile": "Betroffene Datei: {path}",
  "codingWorkbench.activity.failureOrigin.keiko-refused": "Keiko hat blockiert",
  "codingWorkbench.activity.failureOrigin.command-failed": "Befehl fehlgeschlagen",
  "codingWorkbench.activity.failureOrigin.tool-error": "Werkzeug-Fehler",
  "codingWorkbench.activity.failureOrigin.timed-out": "Zeitüberschreitung",
  "codingWorkbench.activity.failureOrigin.invalid-arguments": "Ungültige Argumente",
  "codingWorkbench.activity.failureOrigin.cancelled": "Abgebrochen",
  "codingWorkbench.activity.failure.command-failed":
    "Der Befehl wurde nicht erfolgreich abgeschlossen (beendet mit Code {code}).",
  "codingWorkbench.activity.failure.command-failed-unknown":
    "Der Befehl wurde nicht erfolgreich abgeschlossen.",
  "codingWorkbench.activity.failure.tool-error":
    "Das Werkzeug konnte diesen Schritt nicht ausführen.",
  "codingWorkbench.activity.failure.keiko-refused": "Keiko hat diesen Schritt nicht zugelassen.",
  "codingWorkbench.activity.failure.timed-out": "Der Befehl hat sein Zeitlimit überschritten.",
  "codingWorkbench.activity.failure.invalid-arguments":
    "Die Argumente des Aufrufs waren nicht lesbar, das Werkzeug lief nicht.",
  "codingWorkbench.activity.failure.cancelled": "Dieser Schritt wurde abgebrochen.",
  "codingWorkbench.activity.failure.agentRetries":
    "Der Agent sieht dieses Ergebnis und kann darauf aufbauen.",
  "codingWorkbench.activity.refusalCause.approval-declined": "Du hast ihn abgelehnt.",
  "codingWorkbench.activity.refusalCause.approval-expired": "Niemand hat rechtzeitig entschieden.",
  "codingWorkbench.runStatus.failedCommands": "{count} Befehle fehlgeschlagen",
  "codingWorkbench.runStatus.failedCommands.one": "1 Befehl fehlgeschlagen",
  "codingWorkbench.stream.jumpToLatest": "Zum Neuesten",
  "codingWorkbench.stream.jumpToLatestNew": "{count} neue Schritte · Zum Neuesten",
  "codingWorkbench.stream.jumpToLatestNew.one": "1 neuer Schritt · Zum Neuesten",
  "codingWorkbench.activity.firstStep.waiting": "Warte auf den ersten Schritt des Modells…",
  "codingWorkbench.activity.firstStep.slow": "Läuft noch — das Modell antwortet langsam.",
  "codingWorkbench.activity.failedTimes": "In diesem Lauf {count}-mal fehlgeschlagen",
  "codingWorkbench.activity.took": "Dauer {duration}",
  "codingWorkbench.activity.command": "Befehl",
  "codingWorkbench.activity.agentMessage": "Meldung an den Agenten",
  "codingWorkbench.activity.output": "Ausgabe",
  "codingWorkbench.activity.hiddenLines": "{count} Zeilen ausgeblendet",
  "codingWorkbench.activity.hiddenLines.one": "1 Zeile ausgeblendet",
  "codingWorkbench.activity.linesShortened": "Lange Zeilen wurden gekürzt.",
  "codingWorkbench.activity.textShortened": "Der Text wurde gekürzt.",
  "codingWorkbench.activity.detailOmitted": "Befehl und Ausgabe werden live nicht mehr angezeigt.",
  "codingWorkbench.activity.outputShortened": "Ausgabe für das Modell gekürzt",
  "codingWorkbench.activity.outputShortened.hint":
    "Das Modell hat nur den Anfang dieses Ergebnisses gesehen; der Rest blieb außerhalb seines Kontexts.",
  "codingWorkbench.activity.outputShortened.hintLines":
    "Das Modell hat die ersten {kept} von {total} Zeilen dieses Ergebnisses gesehen; der Rest blieb außerhalb seines Kontexts.",
  "codingWorkbench.activity.verification.passed":
    "Alle angeforderten Verifizierungsprüfungen sind bestanden.",
  "codingWorkbench.activity.verification.failed-check":
    "Eine Verifizierungsprüfung wurde ausgeführt und ist fehlgeschlagen. Das Modell hat die fehlerhaften Stellen erhalten.",
  "codingWorkbench.activity.verification.waiting-for-trust":
    "Die Verifizierung ist nicht gelaufen: Du hast die Build-Dateien dieses Repositorys noch nicht freigegeben. Wähle oben in der Coding Workbench „Build-Dateien dieses Repositorys vertrauen“ und verifiziere dann erneut.",
  "codingWorkbench.activity.verification.no-runnable-steps":
    "Die Verifizierung ist nicht gelaufen: Der Verifizierer hat für diese Anfrage nichts gefunden, was er ausführen kann, etwa weil das gewählte Paket kein test-, lint- oder build-Skript hat. Das ist keine fehlgeschlagene Prüfung.",
  "codingWorkbench.activity.verification.not-run":
    "Die Verifizierung ist nicht vollständig gelaufen: Ein Schritt wurde übersprungen, abgelehnt oder abgebrochen. Das ist keine fehlgeschlagene Prüfung.",
  "codingWorkbench.activity.verification.isolation-unavailable":
    "Die Verifizierung konnte auf diesem Computer nicht laufen: Für diesen Run führt Keiko Projektbefehle nur in einer Container-Laufzeit (Docker oder Podman) oder unter Windows in seiner eigenen geprüften Isolation aus, und beides ist hier nicht verfügbar. Deine Änderung bleibt erhalten. Starte eine Container-Laufzeit und führe die Prüfung erneut aus, oder prüfe die Änderung selbst.",
  "codingWorkbench.activity.verification.dependencies-unavailable":
    "Die Verifizierung ist nicht gelaufen: Keiko konnte die Abhängigkeiten des Projekts nicht installieren, deshalb lief keine Prüfung. Das ist keine fehlgeschlagene Prüfung. Installiere die Abhängigkeiten selbst im Projektordner und verifiziere dann erneut.",
  "codingWorkbench.activity.git.prepared":
    "Hier vorbereitet; es ist keine weitere Entscheidung nötig.",
  "codingWorkbench.activity.git.waiting-for-approval":
    "Wartet auf eine Entscheidung, bevor dieser Schritt ausgeführt wird.",
  "codingWorkbench.activity.git.verification-failed":
    "Nicht committet: Die Verifizierung der vorgemerkten Änderung ist fehlgeschlagen. Behebe die fehlgeschlagene Prüfung, verifiziere erneut und committe dann.",
  "codingWorkbench.activity.git.verification-missing":
    "Nicht committet: Noch keine bestandene Verifizierung deckt die vorgemerkte Änderung ab. Verifiziere die vorgemerkte Änderung und committe dann.",
  "codingWorkbench.activity.git.not-staged":
    "Nicht committet: Ein Teil der Änderung ist noch nicht vorgemerkt. Merke die ganze Änderung vor, verifiziere die vorgemerkte Änderung und committe dann.",
  "codingWorkbench.activity.git.unsaved-changes":
    "Nicht committet: Im Editor geöffnete Dateien enthalten ungespeicherte Änderungen. Speichere sie, verifiziere die vorgemerkte Änderung und committe dann.",
  "codingWorkbench.activity.git.blocked":
    "Nicht durchgeführt: Die Richtlinien- oder Berechtigungsprüfung von Keiko hat diesen Schritt abgelehnt.",
  "codingWorkbench.activity.git.branch-invalid-name":
    "Nicht durchgeführt: Dies ist kein Branch-Name, den Keiko anlegt. Verwende Buchstaben, Ziffern, '-', '_', '.' und '/'.",
  "codingWorkbench.activity.git.branch-protected-name":
    "Nicht durchgeführt: Keiko legt keinen Aufgaben-Branch mit geschütztem Namen wie main oder dev an.",
  "codingWorkbench.activity.git.branch-exists":
    "Nicht durchgeführt: Ein Branch mit diesem Namen existiert bereits. Keiko verschiebt, setzt zurück oder löscht keinen bestehenden Branch.",
  "codingWorkbench.activity.git.branch-not-on-base":
    "Nicht durchgeführt: Dieser Lauf arbeitet bereits auf einem Aufgaben-Branch. Keiko legt einen Aufgaben-Branch nur vom Basis-Branch aus an.",
  "codingWorkbench.activity.git.branch-not-local-checkout":
    "Nicht durchgeführt: Keiko legt einen Aufgaben-Branch nur in einem lokalen Checkout an, und dieser Arbeitsbereich ist keiner.",
  "codingWorkbench.activity.git.branch-executable-filters":
    "Nicht durchgeführt: Dieser Checkout hat ausführbare Git-Filter, daher wechselt Keiko seinen Branch nicht.",
  "codingWorkbench.activity.git.branch-preflight":
    "Nicht durchgeführt: Git meldet einen Repository-Zustand, der den Branch blockiert, zum Beispiel einen laufenden Merge.",
  "codingWorkbench.activity.git.changed":
    "Nicht durchgeführt: Die Änderung oder das Repository hat sich verändert, nachdem dieser Schritt vorgeschlagen wurde.",
  "codingWorkbench.activity.git.not-done":
    "Nicht durchgeführt: Der Schritt ist fehlgeschlagen oder sein Ergebnis ist unklar.",
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
  "codingWorkbench.skills.summary": "Freigegebene Skills ({count})",
  "codingWorkbench.skills.ready": "Bereit",
  "codingWorkbench.skills.category.repositoryAnalysis": "Repository-Analyse",
  "codingWorkbench.skills.category.publicResearch": "Öffentliche Recherche",
  "codingWorkbench.skills.category.documentationLookup": "Dokumentationssuche",
  "codingWorkbench.skills.reason.disabled": "Deaktiviert",
  "codingWorkbench.skills.reason.incompatible": "Nicht kompatibel",
  "codingWorkbench.skills.reason.handlerUnavailable": "Kein Handler",
  "codingWorkbench.skills.reason.authorityDenied": "Berechtigung verweigert",
  "codingWorkbench.skills.unavailable": "Die freigegebenen Skills konnten nicht gelesen werden.",
  "codingWorkbench.skills.retry": "Erneut versuchen",
  "codingWorkbench.skills.reason.budgetExhausted": "Budget erschöpft",
  "codingWorkbench.mcp.summary": "MCP-Server ({count})",
  "codingWorkbench.mcp.status.connected": "Verbunden",
  "codingWorkbench.mcp.status.needsAuthorization": "Autorisierung erforderlich",
  "codingWorkbench.mcp.status.failed": "Nicht verbunden",
  "codingWorkbench.mcp.status.disabled": "Deaktiviert",
  "codingWorkbench.mcp.status.pending": "Verbindet",
  "codingWorkbench.mcp.authorize": "Autorisieren",
  "codingWorkbench.mcp.authorizeLabel": "MCP-Server {server} autorisieren",
  "codingWorkbench.mcp.openAuthorization": "Autorisierungsseite öffnen",
  "codingWorkbench.mcp.authorizing": "Warte auf die Autorisierung im Browser …",
  "codingWorkbench.mcp.cancel": "Abbrechen",
  "codingWorkbench.mcp.authorized": "Autorisiert. Der Server verbindet sich jetzt.",
  "codingWorkbench.mcp.authorizationFailed":
    "Die Autorisierung wurde nicht abgeschlossen. Versuche es erneut.",
  "codingWorkbench.mcp.authorizationExpired":
    "Die Autorisierung ist abgelaufen. Versuche es erneut.",
  "codingWorkbench.mcp.refused.urlRefused":
    "Keiko hat eine Autorisierungsseite zurückgehalten, die nicht zum erwarteten Aussteller gehört.",
  "codingWorkbench.mcp.refused.unavailable":
    "Der Server kann gerade nicht autorisiert werden. Versuche es gleich erneut.",
  "codingWorkbench.mcp.refused.connected": "Der Server ist bereits verbunden.",
  "codingWorkbench.mcp.refused.notOauth": "Dieser Server autorisiert nicht über OAuth.",
  "codingWorkbench.mcp.refused.failed": "Die Autorisierung konnte nicht gestartet werden.",
  "codingWorkbench.mcp.unavailable": "Die MCP-Server konnten nicht gelesen werden.",
  "codingWorkbench.mcp.retry": "Erneut versuchen",
  "codingWorkbench.announcement.researchActive": "Internet-Recherche-Berechtigung aktiv.",
  "codingWorkbench.alert.actionFailedCode":
    "Die angeforderte Runtime-Aktion ist fehlgeschlagen ({code}). Prüfe den Live-Zustand und versuche es erneut.",
  "codingWorkbench.alert.startRefusedModelUnavailable":
    "Das gewählte Modell ist für einen Coding-Lauf gerade nicht zugelassen ({code}). Führe unter Einstellungen → Modelle die Bereitschaftsprüfung dafür aus oder wähle ein Modell, das die Prüfung heute bestanden hat, und starte erneut.",
  "codingWorkbench.alert.startRefusedModelWindow":
    "Das Kontextfenster des gewählten Modells ist für einen Coding-Lauf zu klein (mindestens 32.000 Tokens; {code}). Keiko konnte 32.000 Tokens dafür nicht bestätigen. Wähle ein größeres Modell oder lass das Gateway max_input_tokens für dieses Modell angeben und starte dann erneut.",
  "codingWorkbench.alert.startRefusedModelVerificationPending":
    "Keiko prüft das Kontextfenster des gewählten Modells gerade beim Gateway ({code}). Bei einem ausgelasteten Gateway kann das einige Minuten dauern; starte erneut, sobald die Prüfung abgeschlossen ist.",
  "codingWorkbench.alert.startEndedModelChanged":
    "Das Modell hat gewechselt, während es geprüft wurde, deshalb wurde kein Lauf gestartet ({code}). Wähle das gewünschte Modell und starte erneut.",
  "codingWorkbench.alert.startRefusedWorkspaceLocation":
    "Unter Windows führt Keiko keine Coding-Aufgabe in einem ganzen Laufwerk, deinem Benutzerordner selbst oder einem Ordner mit Keikos eigenen Daten aus, weil die Aufgabe sonst alles darunter lesen könnte ({code}). Wähle einen Projektordner darin oder „Neuer lokaler Worktree“ und starte erneut.",
  "codingWorkbench.alert.startRefusedWorkspaceVolume":
    "Keiko legt seine Worktrees auf einem anderen Laufwerk als Windows ab, auf dem die Windows-Sandbox keine Coding-Aufgabe ausführen kann ({code}). Ein Betreiber muss KEIKO_STATE_DIR auf einen Ordner auf dem Windows-Laufwerk, meist C:, setzen und Keiko neu starten.",
  "codingWorkbench.alert.startRefusedWorkspaceUnqualified":
    "Das gebundene Repository konnte für einen Coding-Lauf nicht qualifiziert werden ({code}). Wähle das Repository erneut über „Browse…“, damit sein echter Pfad gebunden wird, und starte erneut.",
  "codingWorkbench.alert.startRefusedSelectionMismatch":
    "Das Repository, das du siehst, ist nicht das, das Keiko für diesen Start geöffnet hatte, deshalb wurde nichts gestartet und nichts geändert ({code}). Keiko versucht jetzt, das angezeigte Repository zu öffnen. Prüfe seinen Namen und drücke erneut auf Start, sobald es geöffnet ist.",
  "codingWorkbench.alert.startRefusedActiveRun":
    "In dieser Aufgabe läuft noch ein anderer Lauf, deshalb hat Keiko keinen zweiten gestartet ({code}). Warte, bis er beendet ist, oder stoppe ihn, und starte dann erneut.",
  "codingWorkbench.alert.startRefusedRecoveryRequired":
    "Ein Lauf dieser Aufgabe wurde unterbrochen und braucht noch deine Entscheidung, bevor etwas Neues starten kann ({code}). Öffne diesen Lauf und wähle „Wiederherstellung bestätigen“ oder starte eine neue Aufgabe, und starte dann erneut.",
  "codingWorkbench.alert.startRefusedIssueContext":
    "Keiko konnte das Issue, an das diese Aufgabe gebunden ist, nicht lesen ({code}). Prüfe, ob du noch im Issue-Tracker angemeldet bist und das Issue noch existiert, und starte dann erneut.",
  "codingWorkbench.alert.startRefusedDrift":
    "Das, was du freigegeben hast, passt nicht mehr zu Aufgabe, Ordner, Branch oder Limits, wie sie jetzt sind ({code}). Prüfe die Aufgabe und drücke erneut auf Start, damit sie neu freigegeben wird.",
  "codingWorkbench.alert.startRefusedAuthorityExpired":
    "Deine Freigabe für diese Aufgabe ist abgelaufen ({code}). Drücke erneut auf Start, um sie neu freizugeben.",
  "codingWorkbench.alert.startRefusedAuthorityReplayed":
    "Diese Freigabe wurde schon für einen anderen Start verwendet und gilt nicht zweimal ({code}). Drücke erneut auf Start, um sie neu freizugeben.",
  "codingWorkbench.alert.startRefusedAuthorityBudget":
    "Die Aufgabe verlangt mehr, als die freigegebenen Limits erlauben ({code}). Mache die Aufgabe kleiner oder wähle einen anderen Modus und starte dann erneut.",
  "codingWorkbench.alert.startRefusedApprovalActivation":
    "Keiko konnte deine Freigabe nicht aktivieren ({code}). Drücke erneut auf Start. Passiert es wieder, erstelle einen Fehlerbericht und gib ihn an deinen Support weiter.",
  "codingWorkbench.alert.startRefusedReplayCap":
    "Für diesen Lauf wurden zu viele wiederholte Anfragen gesendet ({code}). Warte einen Moment und starte die Aufgabe dann erneut.",
  "codingWorkbench.alert.startRefusedEditsBlocked":
    "Keiko hat den Lauf gestoppt, weil die Änderungen des Agenten mehrmals hintereinander abgelehnt wurden ({code}), zum Beispiel wegen eines geschützten Pfads, einer Regel des gewählten Modus oder einer Datei, die er nicht bearbeiten kann. Die Laufdetails zeigen, was es war. Passe die Aufgabe oder den Modus an und starte dann erneut.",
  "codingWorkbench.alert.actionFailedSupportId": "Support-ID: {correlationId}.",
  "codingWorkbench.alert.authenticationRefreshFailed":
    "Authentifizierung konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.authenticationSetupRefreshFailed":
    "Authentifizierungseinrichtung konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.modelSourceRefreshFailed":
    "Modellquelle konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.runtimeRefreshFailed": "Runtime konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.runtimeUnqualified":
    "Auf dieser Installation kann kein Coding-Lauf gestartet werden. Prüfe die Startdiagnose im Aktivitätsprotokoll, bevor du die Installation änderst.",
  "codingWorkbench.alert.workspaceRefreshFailed":
    "Arbeitsbereich konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.workspaceBindFailed":
    "Der Workspace konnte nicht gebunden werden. Prüfe Repository-Pfad und Zielbranch.",
  "codingWorkbench.alert.runRefreshFailed": "Lauf konnte nicht aktualisiert werden.",
  "codingWorkbench.alert.eventStreamRefreshFailed":
    "Ereignisstrom konnte nicht aktualisiert werden.",
  "codingWorkbench.status.eventStreamReconnecting":
    "Die Live-Aktualisierung wurde unterbrochen. Verbindung zum Ereignisstrom wird wiederhergestellt…",
  "codingWorkbench.issue.resolving": "Verlinktes Issue wird gelesen…",
  "codingWorkbench.issue.error.multiple-issues":
    "Dieser Prompt nennt mehrere Issues. Wähle ein Haupt-Issue für diese Aufgabe und sende ihn erneut.",
  "codingWorkbench.issue.retry": "Erneut versuchen",
  "codingWorkbench.issue.cancel": "Abbrechen",
  "codingWorkbench.issue.accepted": "Issue {issue} · Basis {baseRef}",
  "codingWorkbench.issue.error.invalid-reference":
    "Das ist keine GitHub-Issue-Referenz. Gib eine Issue-URL oder #Nummer aus diesem Repository ein; Pull-Request-URLs und andere Hosts werden abgelehnt.",
  "codingWorkbench.issue.error.repository-mismatch":
    "Das Issue gehört zu einem anderen Repository als dem unter diesem Pfad. Ändere den Repository-Pfad oder öffne den Git-Client, um zu diesem Repository zu wechseln oder es zu klonen. Keiko leitet niemals stillschweigend um.",
  "codingWorkbench.issue.error.auth-required":
    "Der GitHub-Issue-Zugriff ist für dieses Repository nicht aktiviert. Aktiviere ihn hier und starte die Vorschau erneut.",
  "codingWorkbench.issue.enableAccess": "GitHub-Issue-Zugriff aktivieren",
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
  "codingWorkbench.issue.error.unknown-repository":
    "Öffne dieses Repository zuerst in der Workbench und lade dann die Vorschau des Issues.",
  "codingWorkbench.issue.error.unknown":
    "Die Issue-Vorschau ist fehlgeschlagen. Prüfe den Live-Zustand und versuche es erneut.",
  "codingWorkbench.issue.supportId": "Support-ID: {correlationId}.",
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
    "Um ihre Arbeit zu prüfen, muss Keiko die Build-Dateien dieses Repositorys ausführen (zum Beispiel pom.xml oder package.json). Erlaube das, sobald du diesem Repository vertraust.",
  "codingWorkbench.trust.runWaitingNotice":
    "Dieser Run wartet auf dich. Um seine Arbeit zu prüfen, muss Keiko die Build-Dateien dieses Repositorys ausführen (zum Beispiel pom.xml oder package.json). Erlaube das, sobald du diesem Repository vertraust; nur du kannst das entscheiden. Der Run läuft von selbst weiter, sobald du entschieden hast.",
  "codingWorkbench.trust.driftNotice":
    "Du vertraust diesem Repository bereits, aber diese Aufgabe hat dessen Build-Dateien geändert (zum Beispiel pom.xml oder package.json). Erlaube das, sobald du die Änderung angesehen hast; nur du kannst das entscheiden.",
  "codingWorkbench.trust.allow": "Build-Dateien dieses Repositorys vertrauen",
  "codingWorkbench.trust.allowing": "Wird freigegeben…",
  "codingWorkbench.revert.region": "Letzter Durchgang",
  "codingWorkbench.revert.summary":
    "Der letzte Durchgang hat {count} Dateien geändert (+{additions} / -{deletions}).",
  "codingWorkbench.revert.summary.one":
    "Der letzte Durchgang hat 1 Datei geändert (+{additions} / -{deletions}).",
  "codingWorkbench.revert.undo": "Letzten Durchgang rückgängig machen",
  "codingWorkbench.revert.undo.confirm":
    "Den letzten Durchgang rückgängig machen? Das hält den Durchgang an, falls er noch läuft, und setzt die geänderten Dateien auf ihren früheren Inhalt zurück. Solange der Run offen bleibt, kannst du die Änderungen wiederherstellen.",
  "codingWorkbench.revert.undo.confirmAction": "Rückgängig bestätigen",
  "codingWorkbench.revert.staged":
    "Der letzte Durchgang ist rückgängig gemacht: {count} Dateien haben wieder ihren früheren Inhalt. Stelle die Änderungen wieder her oder beende den Run, um das Rückgängigmachen beizubehalten. Solange es besteht, startet in diesem Run keine neue Aufgabe.",
  "codingWorkbench.revert.staged.one":
    "Der letzte Durchgang ist rückgängig gemacht: 1 Datei hat wieder ihren früheren Inhalt. Stelle die Änderungen wieder her oder beende den Run, um das Rückgängigmachen beizubehalten. Solange es besteht, startet in diesem Run keine neue Aufgabe.",
  "codingWorkbench.revert.restore": "Änderungen wiederherstellen",
  "codingWorkbench.revert.restore.confirm":
    "Die rückgängig gemachten Änderungen wiederherstellen? Die Dateien erhalten den Inhalt, den der Durchgang hinterlassen hat. Hast du eine dieser Dateien seit dem Rückgängigmachen bearbeitet, wird nichts überschrieben und die Wiederherstellung abgelehnt.",
  "codingWorkbench.revert.restore.confirmAction": "Wiederherstellung bestätigen",
  "codingWorkbench.revert.cancel": "Abbrechen",
  "codingWorkbench.revert.busy": "Wird angewendet…",
  "codingWorkbench.inbox.region": "Nachrichten, die auf diese Aufgabe warten",
  "codingWorkbench.inbox.summary": "{count} Nachrichten warten auf die laufende Aufgabe.",
  "codingWorkbench.inbox.summary.one": "1 Nachricht wartet auf die laufende Aufgabe.",
  "codingWorkbench.inbox.delivery.steer": "Jetzt senden",
  "codingWorkbench.inbox.delivery.steer.help":
    "Sie erreicht die laufende Aufgabe in ihrem nächsten Schritt.",
  "codingWorkbench.inbox.delivery.queue": "Eingereiht",
  "codingWorkbench.inbox.delivery.queue.help":
    "Sie wird nach der aktuellen Arbeit der laufenden Aufgabe zugestellt.",
  "codingWorkbench.inbox.emptyPreview": "Nachricht ohne Text",
  "codingWorkbench.inbox.sendNow": "Jetzt senden",
  "codingWorkbench.inbox.sendNow.item": "Jetzt senden: {text}",
  "codingWorkbench.inbox.cancel": "Abbrechen",
  "codingWorkbench.inbox.cancel.item": "Nachricht abbrechen: {text}",
  "codingWorkbench.inbox.busy": "Wird angewendet…",
  "codingWorkbench.inbox.error":
    "Die wartenden Nachrichten konnten nicht gelesen werden. Möglicherweise erreichen sie die laufende Aufgabe trotzdem noch.",
  "codingWorkbench.inbox.retry": "Erneut versuchen",
} satisfies CodingWorkbenchMessageCatalog;
