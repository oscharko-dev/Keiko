import type { LocalKnowledgeMessageCatalog } from "./local-knowledge-i18n.en";

export const DE_LOCAL_KNOWLEDGE_MESSAGES: LocalKnowledgeMessageCatalog = {
  "common.cancel": "Abbrechen",
  "common.retry": "Erneut versuchen",
  "common.dismissError": "Fehler ausblenden",
  "common.status": "Status",
  "common.save": "Speichern",
  "common.saving": "Speichere…",
  "common.delete": "Löschen",
  "common.continue": "Weiter",
  "common.browse": "Durchsuchen",
  "common.working": "Wird ausgeführt…",
  "common.dismiss": "Ausblenden",
  "localKnowledge.disconnect.title": "Knowledge Pod trennen",
  "localKnowledge.disconnect.description":
    '"{name}" trennen? Der Index bleibt erhalten; nur die Verknüpfung zur Quelle wird entfernt.',
  "localKnowledge.disconnect.confirm": "Trennen",
  "localKnowledge.row.addToWorkspace": "Zum Arbeitsbereich hinzufügen",
  "localKnowledge.row.addDocuments": "Dokumente hinzufügen",
  "localKnowledge.row.addDocumentsLabel": "Dokumente zu Knowledge Pod {name} hinzufügen",
  "localKnowledge.row.actionsLabel": "Aktionen für Knowledge Pod {name}",
  "localKnowledge.row.addToWorkspaceLabel": "Knowledge Pod {name} zum Arbeitsbereich hinzufügen",
  "localKnowledge.row.details": "Details",
  "localKnowledge.row.detailsLabel": "Details zu Knowledge Pod {name} öffnen",
  "localKnowledge.row.disconnectLabel": "Knowledge Pod {name} trennen",
  "localKnowledge.picker.loading": "Knowledge Pods werden geladen…",
  "localKnowledge.picker.loadFailed": "Knowledge Pods konnten nicht geladen werden.",
  "localKnowledge.picker.retry": "Erneut versuchen",
  "localKnowledge.picker.create": "Knowledge Pod erstellen",
  "localKnowledge.picker.label": "Knowledge-Pod-Quelle auswählen",
  "localKnowledge.picker.placeholder": "— Knowledge-Pod-Quelle wählen —",
  "localKnowledge.picker.menuTitle": "Verfügbare Knowledge-Pod-Quellen",
  "localKnowledge.picker.setOption": "{name} ({count} Pods)",
  "localKnowledge.picker.setsFailed": "Knowledge Pod Sets konnten nicht geladen werden.",
  "localKnowledge.picker.manage": "Knowledge Pods erstellen oder verwalten",
  "localKnowledge.picker.state.ready": "Bereit",
  "localKnowledge.picker.state.indexing": "Wird indexiert…",
  "localKnowledge.picker.state.error": "Fehlgeschlagen",
  "localKnowledge.node.unselected": "Lokales Wissen",
  "localKnowledge.node.meta": "Lokaler Knowledge Pod",
  "localKnowledge.node.manage": "Verwalten",
  "localKnowledge.state.draft": "Entwurf",
  "localKnowledge.state.indexing": "Wird indexiert",
  "localKnowledge.state.ready": "Indexiert",
  "localKnowledge.state.stale": "Veraltet",
  "localKnowledge.state.deleting": "Wird gelöscht",
  "localKnowledge.state.error": "Fehlgeschlagen",
  "localKnowledge.row.cancelIndexingLabel": "Indexierung für Knowledge Pod {name} abbrechen",
  "localKnowledge.row.cancelling": "Wird abgebrochen…",
  "localKnowledge.row.startIndexingLabel": "Indexierung für Knowledge Pod {name} starten",
  "localKnowledge.row.index": "Indexieren",
  "localKnowledge.row.indexing": "Wird indexiert…",
  "localKnowledge.readiness.ready": "Bereit",
  "localKnowledge.readiness.indexing": "Wird indexiert",
  "localKnowledge.readiness.stale": "Veraltet",
  "localKnowledge.readiness.degraded": "Eingeschränkt",
  "localKnowledge.readiness.unavailable": "Nicht verfügbar",
  "localKnowledge.readiness.error": "Fehlgeschlagen",
  "localKnowledge.readiness.draft": "Entwurf",
  "localKnowledge.readiness.unknown": "Unbekannt",
  "localKnowledge.set.article": "Knowledge Pod Set: {name}",
  "localKnowledge.set.podCountBadge": "{count} Pods",
  "localKnowledge.set.podCountText": "{count} Knowledge Pods",
  "localKnowledge.set.readinessSummary": "Bereitschaft des Knowledge Pod Sets: {readiness}.",
  "localKnowledge.set.reasonsSummary": "Gründe: {reasons}",
  "localKnowledge.set.count.pods": "Pods",
  "localKnowledge.set.count.sources": "Quellen",
  "localKnowledge.set.count.docs": "Dokumente",
  "localKnowledge.set.count.chunks": "Chunks",
  "localKnowledge.set.count.vectors": "Vektoren",
  "localKnowledge.set.count.ready": "bereit",
  "localKnowledge.set.count.degraded": "eingeschränkt",
  "localKnowledge.set.count.unavailable": "nicht verfügbar",
  "localKnowledge.set.count.policyDenied": "durch Richtlinie gesperrt",
  "localKnowledge.set.count.indexing": "wird indexiert",
  "localKnowledge.set.count.stale": "veraltet",
  "localKnowledge.set.count.error": "fehlgeschlagen",
  "localKnowledge.set.count.missing": "fehlend",
  "localKnowledge.set.reason.memberDraft": "Entwurf",
  "localKnowledge.set.reason.memberIndexing": "wird indexiert",
  "localKnowledge.set.reason.memberStale": "veraltet",
  "localKnowledge.set.reason.memberError": "fehlgeschlagen",
  "localKnowledge.set.reason.memberUnavailable": "nicht verfügbar",
  "localKnowledge.set.reason.memberDegraded": "eingeschränkt",
  "localKnowledge.set.reason.missingMember": "fehlend",
  "localKnowledge.set.reason.policyDenied": "durch Richtlinie gesperrt",
  "localKnowledge.set.reason.embeddingUnknown": "Embedding unbekannt",
  "localKnowledge.set.reason.embeddingIncompatible": "Embedding-Abweichung",
  "localKnowledge.set.reason.embeddingUnavailable": "Embedding nicht verfügbar",
  "localKnowledge.set.reason.embeddingOpaque": "Embedding nicht prüfbar",
  "localKnowledge.set.reason.noSources": "keine Quellen",
  "localKnowledge.set.reason.noVectors": "keine Vektoren",
  "localKnowledge.set.reason.futureRemoteMember": "Remote-Platzhalter",
  "localKnowledge.set.reason.futureFederatedMember": "Föderations-Platzhalter",
  "localKnowledge.set.reason.futureEphemeralMember": "Platzhalter (ephemer)",
  "localKnowledge.guidance.summary": "Hinweis zum Knowledge Pod: {label}. {description}",
  "localKnowledge.guidance.label.embeddingMismatch": "Embedding-Abweichung",
  "localKnowledge.guidance.label.embeddingUnavailable": "Embedding nicht verfügbar",
  "localKnowledge.guidance.label.reindexRecommended": "Neuindexierung empfohlen",
  "localKnowledge.guidance.label.embeddingOpaque": "Embedding nicht prüfbar",
  "localKnowledge.guidance.label.manualReady": "HTML-Handbuch",
  "localKnowledge.guidance.label.manualDegraded": "Handbuch eingeschränkt",
  "localKnowledge.guidance.label.manualIndexing": "Handbuch wird indexiert",
  "localKnowledge.guidance.label.manualUnavailable": "Handbuch nicht verfügbar",
  "localKnowledge.guidance.label.futureMember": "Platzhalter für künftige Mitglieder",
  "localKnowledge.guidance.label.membersUnavailable": "Mitglieder nicht verfügbar",
  "localKnowledge.guidance.label.membersNotReady": "Mitglieder nicht bereit",
  "localKnowledge.guidance.label.retrievalDegraded": "Retrieval eingeschränkt",
  "localKnowledge.guidance.label.embeddingReadinessWarning": "Warnung zur Embedding-Bereitschaft",
  "localKnowledge.guidance.label.policyDenied": "Durch Richtlinie gesperrt",
  "localKnowledge.guidance.label.sealedLocalPolicy": "Versiegelte lokale Richtlinie",
  "localKnowledge.guidance.description.embeddingMismatch.pod":
    "Die semantische Suche ist für diesen Pod deaktiviert, bis er lokal neu indexiert wird.",
  "localKnowledge.guidance.description.embeddingMismatch.set":
    "Die semantische Suche ist für betroffene Set-Mitglieder deaktiviert, bis sie lokal neu indexiert werden.",
  "localKnowledge.guidance.description.embeddingUnavailable.pod":
    "Die semantische Suche kann unter der aktuellen lokalen Richtlinie nicht ausgeführt werden.",
  "localKnowledge.guidance.description.embeddingUnavailable.set":
    "Die semantische Suche kann für betroffene Set-Mitglieder unter der aktuellen lokalen Richtlinie nicht ausgeführt werden.",
  "localKnowledge.guidance.description.reindexRecommended.pod":
    "Die Kompatibilität ist ungeprüft; der lexikalische Fallback bleibt verfügbar.",
  "localKnowledge.guidance.description.reindexRecommended.set":
    "Die Kompatibilität ist für betroffene Set-Mitglieder ungeprüft; der lexikalische Fallback bleibt verfügbar.",
  "localKnowledge.guidance.description.embeddingOpaque.pod":
    "Die semantische Kompatibilität kann für diesen Retrieval-Raum nicht geprüft werden.",
  "localKnowledge.guidance.description.embeddingOpaque.set":
    "Die semantische Kompatibilität kann für dieses Knowledge Pod Set nicht geprüft werden.",
  "localKnowledge.guidance.description.policyDenied.pod":
    "Dieser Knowledge Pod blockiert geerdete Antwortsynthese oder die Freigabe von Rohinhalten; Keiko meldet den Zustand „durch Richtlinie gesperrt“, statt Auszüge an ein Modell zu senden.",
  "localKnowledge.guidance.description.policyDenied.set":
    "Dieses Knowledge Pod Set blockiert für betroffene Mitglieder geerdete Antwortsynthese oder die Freigabe von Rohinhalten; Keiko meldet den Zustand „durch Richtlinie gesperrt“, statt Auszüge an ein Modell zu senden.",
  "localKnowledge.guidance.description.sealedLocalPolicy.pod":
    "Externe Embedding- oder Reranking-Aufrufe sind für diesen Knowledge Pod deaktiviert; das Retrieval kann lexikalischen oder lokalen Fallback nutzen.",
  "localKnowledge.guidance.description.sealedLocalPolicy.set":
    "Externe Embedding- oder Reranking-Aufrufe sind für betroffene Set-Mitglieder deaktiviert; das Retrieval kann lexikalischen oder lokalen Fallback nutzen.",
  "localKnowledge.guidance.description.futureMember":
    "Dieses Knowledge Pod Set enthält Platzhalter für künftige Remote-, föderierte oder ephemere Mitglieder; diese sind noch keine aktiven Retrieval-Quellen.",
  "localKnowledge.guidance.description.membersUnavailable":
    "Einige Set-Mitglieder fehlen, sind fehlgeschlagen oder nicht verfügbar; das Retrieval nutzt nur verfügbare Mitglieder.",
  "localKnowledge.guidance.description.membersNotReady":
    "Einige Set-Mitglieder werden indexiert, sind veraltet oder Entwürfe; aktualisiere oder indexiere sie, bevor du dich auf dieses Set verlässt.",
  "localKnowledge.guidance.description.retrievalDegraded":
    "Einige Set-Mitglieder haben keine Quellen, keine Vektoren oder eine eingeschränkte Indexierung; womöglich ist nur der lexikalische Fallback verfügbar.",
  "localKnowledge.guidance.description.embeddingReadinessWarning":
    "Bei einigen Set-Mitgliedern muss das Embedding geprüft werden; Keiko vergleicht keine rohen Vektor-Scores über Embedding-Räume hinweg.",
  "localKnowledge.guidance.description.manualReady":
    "Bereit für die Chat-Suche über Lokales Wissen. {counts}.",
  "localKnowledge.guidance.description.manualDegraded":
    "Der Handbuch-Abruf ist eingeschränkt; Antworten nutzen womöglich nur verfügbare Belege. {counts}.",
  "localKnowledge.guidance.description.manualIndexing":
    "Handbuch-Abruf (Status: {state}); noch nicht bereit, Belege beizusteuern.",
  "localKnowledge.guidance.description.manualUnavailable":
    "Handbuch-Abruf (Status: {state}); er darf nicht stillschweigend als leere Belegmenge gelten.",
  "localKnowledge.guidance.manualCounts": "{docs} Dok. · {chunks} Chunks · {vectors} Vektoren",
  "localKnowledge.guidance.manualState.ready": "bereit",
  "localKnowledge.guidance.manualState.indexing": "wird indexiert",
  "localKnowledge.guidance.manualState.stale": "veraltet",
  "localKnowledge.guidance.manualState.degraded": "eingeschränkt",
  "localKnowledge.guidance.manualState.unavailable": "nicht verfügbar",
  "localKnowledge.guidance.manualState.error": "fehlgeschlagen",
  "localKnowledge.guidance.manualState.draft": "Entwurf",
  "localKnowledge.picker.sectionPods": "Knowledge Pods",
  "localKnowledge.picker.sectionSets": "Knowledge Pod Sets",
  "localKnowledge.picker.unavailablePod": "Knowledge Pod (nicht verfügbar)",
  "localKnowledge.picker.unavailableSet": "Knowledge Pod Set (nicht verfügbar)",
  "localKnowledge.scopePill.pendingPod": "Knowledge Pod",
  "localKnowledge.scopePill.pendingSet": "Knowledge Pod Set",
  "localKnowledge.scopePill.disconnect": "{label} vom Chat trennen",
  "localKnowledge.scopePill.disconnectError": "Knowledge Pod konnte nicht getrennt werden.",
  "localKnowledge.scopePill.removed": "Verbundener Knowledge Pod wurde entfernt.",
  "localKnowledge.scopePill.updated.one": "Verbundene Knowledge Pods aktualisiert: 1 Quelle.",
  "localKnowledge.scopePill.updated.other":
    "Verbundene Knowledge Pods aktualisiert: {count} Quellen.",
  "localKnowledge.picker.selectedWithState": "{name} ({state})",
  "localKnowledge.node.unavailable": "Nicht verfügbar",
  "localKnowledge.node.defaultLabel": "Knowledge Pod",
  "localKnowledge.manualRefresh.title": "Letzte Aktualisierung",
  "localKnowledge.manualRefresh.removalNote":
    "Entfernte Seiten konnten in diesem Lauf nicht erkannt werden (der Crawl hat sein Seitenlimit erreicht).",
  "localKnowledge.manualRefresh.outcome.unchanged": "Unverändert",
  "localKnowledge.manualRefresh.outcome.updated": "Aktualisiert",
  "localKnowledge.manualRefresh.outcome.partial": "Teilweise",
  "localKnowledge.manualRefresh.outcome.failed": "Fehlgeschlagen",
  "localKnowledge.manualRefresh.outcome.cancelled": "Abgebrochen",
  "localKnowledge.manualRefresh.count.addedPages": "Hinzugefügt",
  "localKnowledge.manualRefresh.count.changedPages": "Geändert",
  "localKnowledge.manualRefresh.count.removedPages": "Entfernt",
  "localKnowledge.manualRefresh.count.movedPages": "Verschoben",
  "localKnowledge.manualRefresh.count.unchangedPages": "Unverändert",
  "localKnowledge.manualRefresh.count.failedPages": "Fehlgeschlagen",
  "localKnowledge.manualRefresh.count.deniedLinks": "Abgelehnte Links",
  "localKnowledge.manualRefresh.reason.scopePreserved":
    "Die Aktualisierung hat den ursprünglich freigegebenen Handbuch-Umfang samt Limits wiederverwendet.",
  "localKnowledge.manualRefresh.reason.scopeLimitReached":
    "Die Aktualisierung hat ein Crawl-Limit erreicht; einige Seiten wurden nicht besucht.",
  "localKnowledge.manualRefresh.reason.removalDetectionSkipped":
    "Der Crawl hat sein Seitenlimit erreicht, daher konnten entfernte Seiten in diesem Lauf nicht erkannt werden.",
  "localKnowledge.manualRefresh.reason.pagesAdded": "Neue Seiten wurden entdeckt und indexiert.",
  "localKnowledge.manualRefresh.reason.pagesChanged":
    "Vorhandene Seiten haben sich geändert und wurden neu indexiert.",
  "localKnowledge.manualRefresh.reason.pagesRemoved":
    "Seiten, die nicht mehr erreichbar sind, wurden aus dem Pod entfernt.",
  "localKnowledge.manualRefresh.reason.pagesMoved":
    "Seiten wurden an einen neuen Ort verschoben; ihr Inhalt blieb unverändert.",
  "localKnowledge.manualRefresh.reason.pagesFailed":
    "Einige Seiten konnten nicht neu indexiert werden und sind möglicherweise vorübergehend nicht durchsuchbar; eine spätere erfolgreiche Aktualisierung versucht es erneut.",
  "localKnowledge.manualRefresh.reason.linksDenied":
    "Einige Links wurden übersprungen, weil sie außerhalb des freigegebenen Umfangs lagen.",
  "localKnowledge.manualRefresh.reason.embeddingIncompatible":
    "Das Embedding-Modell hat sich geändert; indexiere das Handbuch neu, um seine Vektoren zu aktualisieren.",
  "localKnowledge.manualRefresh.reason.crawlEmpty":
    "Der Aktualisierungs-Crawl hat keine indexierbaren Seiten gefunden.",
  "localKnowledge.manualRefresh.reason.crawlCancelled":
    "Die Aktualisierung wurde abgebrochen. Noch nicht erreichte Seiten sind nicht betroffen; eine Seite, die in diesem Moment bereits neu indexiert wurde, ist möglicherweise bis zu einer späteren erfolgreichen Aktualisierung vorübergehend nicht durchsuchbar.",
  "localKnowledge.manualRefresh.reason.indexFailed":
    "Die Indexierung ist bei der Aktualisierung fehlgeschlagen. Seiten, die zum Zeitpunkt des Fehlers neu indexiert wurden, sind möglicherweise vorübergehend nicht durchsuchbar, bis eine spätere erfolgreiche Aktualisierung sie repariert.",
  "localKnowledge.create.title": "Knowledge Pod erstellen",
  "localKnowledge.create.description": "Benenne diesen Knowledge Pod.",
  "localKnowledge.create.nameLabel": "Anzeigename des Knowledge Pod",
  "localKnowledge.create.validation.nameRequired":
    "Der Anzeigename des Knowledge Pod ist erforderlich.",
  "localKnowledge.create.creating": "Wird erstellt…",
  "localKnowledge.create.submit": "Knowledge Pod erstellen",
  "localKnowledge.overview.backToWorkspace": "Zurück zum Arbeitsbereich",
  "localKnowledge.overview.backToPods": "Zurück zu Knowledge Pods",
  "localKnowledge.overview.sectionLabel": "Knowledge Pods",
  "localKnowledge.overview.emptyTitle": "Noch keine Knowledge Pods",
  "localKnowledge.overview.emptyBody":
    "Erstelle einen Knowledge Pod, um gesteuerte lokale Quellen zu indexieren.",
  "localKnowledge.overview.createFirst": "Ersten Knowledge Pod erstellen",
  "localKnowledge.overview.loadingPods": "Knowledge Pods werden geladen…",
  "localKnowledge.overview.podList": "Knowledge Pod-Liste",
  "localKnowledge.overview.combineDisabledHint":
    "Erstelle Knowledge Pods, bevor du sie zu einem Set kombinierst.",
  "localKnowledge.overview.retryLoadingPods": "Knowledge Pods erneut laden",
  "localKnowledge.set.createTitle": "Knowledge Pod Set erstellen",
  "localKnowledge.set.nameLabel": "Name des Knowledge Pod Set",
  "localKnowledge.set.membersLegend": "Knowledge Pods ({selected}/{max})",
  "localKnowledge.set.emptyMembers": "Keine Knowledge Pods zum Kombinieren verfügbar.",
  "localKnowledge.set.selectableMembers": "Auswählbare Knowledge Pods",
  "localKnowledge.set.validation.nameRequired": "Der Name des Knowledge Pod Set ist erforderlich.",
  "localKnowledge.set.validation.selectionRequired":
    "Wähle mindestens einen Knowledge Pod zum Kombinieren aus.",
  "localKnowledge.set.validation.tooMany":
    "Ein Knowledge Pod Set kann höchstens {count} Knowledge Pods enthalten.",
  "localKnowledge.set.submit": "Knowledge Pod Set erstellen",
  "localKnowledge.set.deleteTitle": "Knowledge Pod Set löschen",
  "localKnowledge.set.deleteDescription":
    '"{name}" löschen? Enthaltene Knowledge Pods behalten ihre Indizes; nur dieses Set wird entfernt.',
  "localKnowledge.set.deleteConfirm": "Löschen",
  "localKnowledge.set.deleting": "Lösche…",
  "localKnowledge.set.sectionTitle": "Knowledge Pod Sets",
  "localKnowledge.set.list": "Knowledge Pod Set-Liste",
  "localKnowledge.set.dragSet": "Knowledge Pod Set {name} in den Arbeitsbereich ziehen",
  "localKnowledge.set.dragSetTitle":
    "In den Arbeitsbereich ziehen, um eine Knowledge Pod Set-Karte zu erstellen",
  "localKnowledge.set.addToWorkspace": "Knowledge Pod Set {name} zum Arbeitsbereich hinzufügen",
  "localKnowledge.set.deleteAria": "Knowledge Pod Set {name} löschen",
  "localKnowledge.row.article": "Knowledge Pod: {name}",
  "localKnowledge.row.dragJiraPod": "Jira Pod {name} in den Arbeitsbereich ziehen",
  "localKnowledge.row.dragPod": "Knowledge Pod {name} in den Arbeitsbereich ziehen",
  "localKnowledge.row.dragPodTitle":
    "In den Arbeitsbereich ziehen, um eine Knowledge Pod-Karte zu erstellen",
  "localKnowledge.error.api": "Etwas ist schiefgelaufen. Versuche es erneut. ({code})",
  "localKnowledge.error.unexpected": "Ein unerwarteter Fehler ist aufgetreten.",
  "localKnowledge.nativeDialog.busy":
    "Es ist bereits ein nativer Dialog geöffnet. Schließe ihn zuerst.",
  "localKnowledge.nativeDialog.unavailable":
    "Native Dialoge sind auf dieser Plattform nicht verfügbar. Gib den Pfad manuell ein.",
  "localKnowledge.nativeDialog.partialSelection.singular":
    "{count} ausgewähltes Element konnte nicht hinzugefügt werden und wurde übersprungen.",
  "localKnowledge.nativeDialog.partialSelection.plural":
    "{count} ausgewählte Elemente konnten nicht hinzugefügt werden und wurden übersprungen.",
  "localKnowledge.detail.loading": "Knowledge Pod wird geladen…",
  "localKnowledge.detail.pageLabel": "Knowledge Pod-Detailansicht",
  "localKnowledge.detail.noSelection":
    "Kein Knowledge Pod ausgewählt. Öffne einen Knowledge Pod aus der Übersicht für lokales Wissen.",
  "localKnowledge.detail.notFound":
    "Dieser Knowledge Pod existiert nicht mehr. Kehre zur Übersicht für lokales Wissen zurück.",
  "localKnowledge.detail.loadFailed": "Knowledge Pod konnte nicht geladen werden.",
  "localKnowledge.detail.retryLoad": "Knowledge Pod erneut laden",
  "localKnowledge.detail.routeError.title":
    "Bei dieser Knowledge-Pod-Seite ist ein Fehler aufgetreten",
  "localKnowledge.detail.routeError.body":
    "Die Seite konnte nicht dargestellt werden. Ihr Knowledge Pod und dessen Daten sind davon nicht betroffen.",
  "localKnowledge.detail.routeError.retry": "Erneut versuchen",
  "localKnowledge.detail.backToLocalKnowledge": "Zurück zu lokalem Wissen",
  "localKnowledge.detail.tools": "Werkzeuge für diesen Knowledge Pod",
  "localKnowledge.detail.advanced.summary": "Status, Quellen und Diagnose",
  "localKnowledge.detail.advanced.hint": "Embeddings, Retrieval, Quellen und Job-Verlauf",
  "localKnowledge.detail.documentCounts": "Dokumentzählung",
  "localKnowledge.detail.rows.showMore": "{count} weitere {noun} anzeigen",
  "localKnowledge.detail.rows.showFewer": "Weniger {noun} anzeigen",
  "localKnowledge.detail.rows.diagnostics": "Diagnosen",
  "localKnowledge.detail.rows.jobs": "Jobs",
  "localKnowledge.detail.rename.formLabel": "Knowledge Pod umbenennen",
  "localKnowledge.detail.rename.displayName": "Anzeigename",
  "localKnowledge.detail.rename.description": "Beschreibung",
  "localKnowledge.detail.rename.nameRequired": "Der Anzeigename ist erforderlich.",
  "localKnowledge.detail.rename.button": "Umbenennen",
  "localKnowledge.detail.rename.buttonFor": "Knowledge Pod {name} umbenennen",
  "localKnowledge.detail.rebind.button": "Quelle neu verbinden",
  "localKnowledge.detail.rebind.repositoryRoot": "Neuer Repository-Stamm",
  "localKnowledge.detail.rebind.sharedRoot": "Neuer gemeinsamer Stammordner",
  "localKnowledge.detail.rebind.folderRoot": "Neuer Ordnerstamm",
  "localKnowledge.detail.rebind.chooseRoot": "Neuen Stammordner auswählen",
  "localKnowledge.detail.rebind.save": "Stamm speichern",
  "localKnowledge.detail.rebind.saving": "Verbinde neu…",
  "localKnowledge.detail.connect.region": "Quelle verbinden",
  "localKnowledge.detail.connect.title": "Knowledgequelle verbinden",
  "localKnowledge.detail.connect.description":
    "Wähle eine Knowledgequelle aus und verbinde sie mit diesem Knowledge Pod.",
  "localKnowledge.detail.connect.sourcePickerTitle": "Knowledgequelle",
  "localKnowledge.detail.connect.sourcePickerDescription":
    "Nutze Ordner für ganze Sammlungen oder Dokumente für gezielte Ergänzungen. Weitere Quellen kannst du später hinzufügen.",
  "localKnowledge.detail.connect.supportedFormats":
    "Unterstützt PDF-, Word-, Excel- und PowerPoint-Dateien (PPTX) sowie Text, Markdown, CSV, JSON, HTML und gängige Quell- und Konfigurationsdateien. Bis zu {size} pro Datei.",
  "localKnowledge.detail.connect.chooseFiles": "Dokumente für diesen Knowledge Pod auswählen",
  "localKnowledge.detail.connect.chooseFolder": "Ordner für diesen Knowledge Pod auswählen",
  "localKnowledge.detail.connect.pickFolderSource": "Ordner auswählen",
  "localKnowledge.detail.connect.pickDocumentSource": "Dokumente auswählen",
  "localKnowledge.detail.connect.filter.documents": "PDF-, Word-, Excel- und PowerPoint-Dateien",
  "localKnowledge.detail.connect.filter.structuredData": "Tabellen und strukturierte Daten",
  "localKnowledge.detail.connect.filter.textDocuments": "Text und Markdown",
  "localKnowledge.detail.connect.filter.webDocuments": "Webdokumente",
  "localKnowledge.detail.connect.filter.scripts": "Skripte",
  "localKnowledge.detail.connect.filter.sourceCode": "Quellcode",
  "localKnowledge.detail.connect.filter.configuration": "Konfigurationsdateien",
  "localKnowledge.detail.connect.sourcePath": "Quellpfad",
  "localKnowledge.detail.connect.displayName": "Anzeigename (optional)",
  "localKnowledge.detail.connect.displayNamePlaceholder":
    "Wird sicher aus der ausgewählten Quelle abgeleitet",
  "localKnowledge.detail.connect.specificFiles": "Nur bestimmte Dokumente indexieren",
  "localKnowledge.detail.connect.relativeFiles": "Relative Dokumentpfade",
  "localKnowledge.detail.connect.selectedSource": "Ausgewählte Knowledgequelle: {path}",
  "localKnowledge.detail.connect.selectedDocuments": "Ausgewählte Dokumente: {count} aus {root}",
  "localKnowledge.detail.connect.repositoryMode": "Als Code-Repository verbinden",
  "localKnowledge.detail.connect.selectedRepository": "Ausgewähltes Repository: {path}",
  "localKnowledge.detail.connect.repositoryFilesDisabledNote":
    "Die Auswahl einzelner Dokumente ist im Repository-Modus nicht verfügbar. Das gesamte Repository wird als eine Code-Quelle verbunden.",
  "localKnowledge.detail.connect.connect": "Verbinden",
  "localKnowledge.detail.connect.connecting": "Verbinde…",
  "localKnowledge.detail.connect.limitSummary":
    "Maximale Größe pro Datei: {size}. Parser-Budget: {objects} Objekte, {duration} pro Dokument.",
  "localKnowledge.detail.help.sourceSetup":
    "Eine Knowledgequelle ist das Material, das Keiko für diesen Knowledge Pod durchsuchen darf. Verbinde einen Ordner für eine Sammlung oder einzelne Dokumente für gezielte Ergänzungen.",
  "localKnowledge.detail.help.sourcePath":
    "Dieser Pfad zeigt Keiko, wo die ausgewählte Quelle auf diesem Gerät liegt. Keiko indexiert nur die verbundene Quelle.",
  "localKnowledge.detail.help.sourceDisplayName":
    "Lege optional einen Namen für diese Quelle fest. Ohne Eingabe leitet Keiko einen sicheren Namen aus der ausgewählten Quelle ab.",
  "localKnowledge.detail.help.specificFiles":
    "Nutze das, wenn aus einem Ordner nur bestimmte Dokumente in den Knowledge Pod sollen. Jede Zeile steht für ein Dokument unterhalb des Quellpfads.",
  "localKnowledge.detail.help.repositoryMode":
    "Verbindet diese Quelle als Code-Repository statt als Dokumentordner. Keiko nutzt dann code-bewusstes Chunking, Zitate mit Datei- und Zeilenangabe sowie eine schnelle inkrementelle Aktualisierung anhand der Git-Änderungen. Nicht gemeinsam mit der Auswahl einzelner Dokumente verfügbar.",
  "localKnowledge.detail.help.indexNow":
    "Startet die Indexierung. Keiko liest die Quelle, extrahiert Text und bereitet ihn für spätere Antworten vor.",
  "localKnowledge.detail.help.maintenance":
    "Diese Aktionen sind für Wartung und Fehlerbehebung. Du kannst Änderungen übernehmen, Probleme erneut versuchen, den Index neu aufbauen oder den Knowledge Pod löschen.",
  "localKnowledge.detail.help.maintenanceLimits":
    "Diese Grenzen schützen die App vor Dateien, die zu groß oder zu komplex für eine zuverlässige Verarbeitung sind.",
  "localKnowledge.detail.help.actionReembed":
    "Erstellt die Such-Fingerabdrücke mit dem aktuellen Embedding-Modell neu. Sinnvoll, wenn das Embedding-Modell gewechselt wurde.",
  "localKnowledge.detail.help.actionRebuild":
    "Verarbeitet alle Quellen von Anfang an. Nutze das, wenn Indexierungseinstellungen geändert wurden oder Ergebnisse unvollständig wirken.",
  "localKnowledge.detail.help.actionRefresh":
    "Sucht geänderte oder entfernte Dateien und aktualisiert nur das Nötige. Das ist der normale Wartungslauf für bestehende Quellen.",
  "localKnowledge.detail.help.actionRepair":
    "Versucht Dokumente erneut, die beim Indexieren fehlgeschlagen sind. Bereits erfolgreiche Dokumente bleiben erhalten.",
  "localKnowledge.detail.help.actionDelete":
    "Löscht den lokalen Index dieses Knowledge Pod. Die Dateien auf deinem Gerät werden nicht gelöscht.",
  "localKnowledge.detail.help.actionProgress":
    "Dieser Bereich zeigt den Live-Fortschritt der aktuellen Aktion. Er aktualisiert sich, während Keiko Dokumente und Vektoren verarbeitet.",
  "localKnowledge.detail.help.actionDocuments":
    "Zeigt, wie viele Dokumente diese Aktion bereits verarbeitet hat und wie viele erwartet werden.",
  "localKnowledge.detail.help.actionVectors":
    "Zeigt, wie viele durchsuchbare Text-Fingerabdrücke während dieser Aktion erstellt wurden.",
  "localKnowledge.detail.help.indexStatus":
    "Der Indexstatus zeigt, ob Keiko die verbundenen Quellen bereits verarbeitet hat und ob dieser Knowledge Pod für die Suche bereit ist.",
  "localKnowledge.detail.help.indexedDocuments":
    "Zeigt, wie viele Dokumente Keiko lesen und in den Index aufnehmen konnte. Fehlgeschlagene Dokumente benötigen Aufmerksamkeit.",
  "localKnowledge.detail.help.vectors":
    "Vektoren sind Such-Fingerabdrücke für Textabschnitte. Damit findet Keiko passende Inhalte nach Bedeutung, nicht nur nach exakten Wörtern.",
  "localKnowledge.detail.help.latestJob":
    "Der letzte Job ist der zuletzt gestartete Indexierungslauf. Er zeigt, ob Keiko noch arbeitet, fertig ist oder mit einem Fehler gestoppt hat.",
  "localKnowledge.detail.help.discoveryProgress":
    "Discovery bedeutet, dass Keiko Dokumente in der Quelle findet und prüft. Das ist die Vorstufe, bevor Inhalte wirklich suchbar sind.",
  "localKnowledge.detail.help.retrievalCoverage":
    "Die Retrieval-Abdeckung zeigt, wie viel der indexierten Inhalte für die semantische Suche bereit ist. Niedrige Abdeckung kann zu unvollständigen Treffern führen.",
  "localKnowledge.detail.help.indexMessage":
    "Diese Meldung fasst zusammen, ob Index und Suchdaten zum aktuellen Quellensatz passen.",
  "localKnowledge.detail.help.advanced":
    "Öffnet technische Details zu Quellen, Embeddings, Retrieval und Job-Verlauf. Nützlich, wenn Antworten erwartete Inhalte vermissen lassen.",
  "localKnowledge.detail.help.embeddingSection":
    "Embeddings übersetzen Text in Such-Fingerabdrücke. Dieser Bereich prüft, ob ältere und neue Fingerabdrücke noch zusammenpassen.",
  "localKnowledge.detail.help.pinnedModel":
    "Das fixierte Modell hat die vorhandenen Such-Fingerabdrücke erstellt. Dadurch bleibt nachvollziehbar, womit ältere Indexdaten entstanden sind.",
  "localKnowledge.detail.help.currentModel":
    "Das aktuelle Modell würde Keiko jetzt für neue oder neu aufgebaute Suchdaten verwenden.",
  "localKnowledge.detail.help.compatibility":
    "Kompatibel bedeutet, dass alte und neue Such-Fingerabdrücke zuverlässig vergleichbar sind. Wenn nicht, sollten die Vektoren neu erstellt werden.",
  "localKnowledge.detail.help.embeddingMessage":
    "Diese Meldung erklärt, ob die Embedding-Konfiguration bereit ist oder Aufmerksamkeit braucht.",
  "localKnowledge.detail.help.contextualRetrieval":
    "Kontextuelles Retrieval kann jedem Textabschnitt beim Indexieren eine kurze Einordnung hinzufügen. Das kann spätere Antworten verbessern, benötigt aber zusätzliche Modellaufrufe.",
  "localKnowledge.detail.help.contextStatus":
    "Zeigt, ob kontextuelles Retrieval bereit, deaktiviert oder ein Neuaufbau erforderlich ist.",
  "localKnowledge.detail.help.contextModel":
    "Zeigt, welches Chatmodell den Zusatzkontext erzeugt. Ohne eigenes Modell nutzt Keiko den Gateway-Standard.",
  "localKnowledge.detail.help.contextStale":
    "Veraltete Kontext-Chunks sind Abschnitte, deren Zusatzkontext nicht mehr zu den aktuellen Einstellungen passt. Ein Neuaufbau aktualisiert sie.",
  "localKnowledge.detail.help.contextEnable":
    "Aktiviert kontextuelles Retrieval für künftige Indexierungsläufe. Vorhandene Daten ändern sich erst nach einem Neuaufbau.",
  "localKnowledge.detail.help.contextModelInput":
    "Optionale Modell-ID für die Kontext-Erzeugung. Lasse das Feld leer, um den Gateway-Standard zu verwenden.",
  "localKnowledge.detail.help.contextStrict":
    "Im strikten Modus stoppt die Indexierung, wenn kein Kontext erzeugt werden kann. Lasse ihn aus, wenn Keiko mit einem Fallback weiterarbeiten soll.",
  "localKnowledge.detail.help.contextGeneratedLimit":
    "Begrenzt die Länge des erzeugten Kontexts pro Textabschnitt, damit der Index kompakt bleibt.",
  "localKnowledge.detail.help.contextDocumentLimit":
    "Begrenzt, wie viel Dokumenttext zur Kontext-Erzeugung für einen Abschnitt verwendet werden darf.",
  "localKnowledge.detail.help.contextSave":
    "Speichert diese Retrieval-Einstellungen. Baue den Knowledge Pod danach neu auf, damit vorhandene Abschnitte die neuen Einstellungen nutzen.",
  "localKnowledge.detail.help.sources":
    "Quellen sind die Ordner oder Dokumente, die mit diesem Knowledge Pod verbunden sind. Ein Pod kann mehrere Quellen kombinieren.",
  "localKnowledge.detail.help.sourceCard":
    "Diese Karte zeigt eine verbundene Quelle und wie viele Dokumente daraus indexiert, fehlgeschlagen oder übersprungen wurden.",
  "localKnowledge.detail.help.sourceCoverage":
    "Der Balken fasst das Ergebnis für diese Quelle zusammen: indexierte, fehlgeschlagene und übersprungene Dokumente.",
  "localKnowledge.detail.help.rebind":
    "Nutze das, wenn eine Quelle auf der Festplatte verschoben wurde. Keiko behält die Quelle und zeigt auf den neuen Speicherort.",
  "localKnowledge.detail.help.overview":
    "Der Überblick zeigt Grundeinstellungen und Gesundheitsinformationen zu diesem Knowledge Pod.",
  "localKnowledge.detail.help.overviewStatus":
    "Zeigt den Lebenszyklusstatus des Knowledge Pod, zum Beispiel Entwurf, Indexierung oder bereit.",
  "localKnowledge.detail.help.overviewEmbeddingModel":
    "Zeigt, welches Embedding-Modell mit den Suchdaten dieses Knowledge Pod verbunden ist.",
  "localKnowledge.detail.help.overviewStorage":
    "Zeigt, wie viel lokaler Speicher durch die Indexdaten aktuell belegt wird.",
  "localKnowledge.detail.help.overviewUnsupported":
    "Listet Dokumente, die Keiko mit den verfügbaren Parsern nicht verarbeiten konnte.",
  "localKnowledge.detail.help.overviewLastIndexed":
    "Zeigt, wann Keiko diesen Knowledge Pod zuletzt vollständig verarbeitet hat.",
  "localKnowledge.detail.help.overviewVectorCompatible":
    "Zeigt, ob die vorhandenen Such-Fingerabdrücke noch zur aktuellen Embedding-Konfiguration passen.",
  "localKnowledge.detail.help.overviewStaleReasons":
    "Listet Gründe, warum dieser Knowledge Pod eine Aktualisierung, einen Neuaufbau oder neue Vektoren benötigen kann.",
  "localKnowledge.detail.help.overviewNextSteps":
    "Zeigt konkrete nächste Schritte, wenn einzelne Dokumente nicht indexiert werden konnten.",
  "localKnowledge.detail.help.privacy":
    "Diese Hinweise erklären, was lokal bleibt und wann Keiko das konfigurierte Model Gateway nutzen kann.",
  "localKnowledge.detail.help.diagnostics":
    "Diagnosen zeigen Verarbeitungsprobleme, ohne Rohtext aus Dokumenten offenzulegen. Sie erklären, warum manche Dokumente Aufmerksamkeit brauchen.",
  "localKnowledge.detail.help.diagnosticRow":
    "Eine Diagnose beschreibt ein wiederkehrendes Verarbeitungsproblem, zum Beispiel eine unlesbare Seite oder ein nicht unterstütztes Format.",
  "localKnowledge.detail.help.jobs":
    "Die Job-Historie listet frühere Indexierungsläufe. Sie zeigt, wann Daten verarbeitet wurden und ob ein Lauf fehlgeschlagen ist.",
  "localKnowledge.detail.help.jobRow":
    "Eine Job-Zeile zeigt einen Indexierungslauf mit Status, Zeitraum, Dauer und Dokumentzählung.",
  "localKnowledge.detail.help.largeDocuments":
    "Große Dokumente werden in Etappen verarbeitet, damit Keiko fortsetzen kann, statt von vorne zu beginnen.",
  "localKnowledge.detail.help.largeDocumentRow":
    "Diese Zeile zeigt Phase und Abdeckung für ein großes Dokument.",
  "localKnowledge.detail.help.largeResume":
    "Setzt die Verarbeitung großer Dokumente dort fort, wo Keiko sicher weitermachen kann.",
  "localKnowledge.detail.actions.group": "Aktionen für Knowledge Pod {name}",
  "localKnowledge.detail.actions.maintenance": "Wartung und Löschen",
  "localKnowledge.detail.actions.maintenanceHint":
    "Aktualisieren, reparieren, neu aufbauen oder entfernen",
  "localKnowledge.detail.actions.index.button": "Jetzt indexieren",
  "localKnowledge.detail.actions.index.busy": "Indexiere…",
  "localKnowledge.detail.actions.index.aria": "Diesen Knowledge Pod jetzt indexieren",
  "localKnowledge.detail.actions.delete.title": "Knowledge Pod löschen",
  "localKnowledge.detail.actions.delete.description":
    'Dadurch wird der Pod-Index dauerhaft gelöscht. Quelldateien auf der Festplatte werden nicht gelöscht. Gib "{name}" ein, um zu bestätigen.',
  "localKnowledge.detail.actions.delete.confirmName": "Gib den Pod-Namen zur Bestätigung ein",
  "localKnowledge.detail.actions.delete.aria": "Knowledge Pod {name} löschen",
  "localKnowledge.detail.actions.reembed.title": "Vektoren für das aktuelle Modell neu erstellen",
  "localKnowledge.detail.actions.reembed.description":
    "Erstellt alle Vektoren für das aktuelle Embedding-Modell neu. Nutze diese Aktion, nachdem das konfigurierte Embedding-Modell oder Gateway geändert wurde.",
  "localKnowledge.detail.actions.reembed.confirm": "Vektoren neu erstellen",
  "localKnowledge.detail.actions.reembed.button": "Vektoren für aktuelles Modell neu erstellen",
  "localKnowledge.detail.actions.reembed.aria":
    "Vektoren von Knowledge Pod {name} für das aktuelle Embedding-Modell neu erstellen",
  "localKnowledge.detail.actions.rebuild.title": "Vollständig neu aufbauen",
  "localKnowledge.detail.actions.rebuild.description":
    "Verarbeitet alle Quellen erneut, baut Chunks und Retrieval-Texte neu auf und erstellt Embeddings mit dem aktuellen Modell. Nutze diese Aktion nach Änderungen an Tokenizer, Analyse oder kontextuellem Retrieval.",
  "localKnowledge.detail.actions.rebuild.confirm": "Neu aufbauen",
  "localKnowledge.detail.actions.rebuild.button": "Vollständig neu aufbauen",
  "localKnowledge.detail.actions.rebuild.aria": "Knowledge Pod {name} vollständig neu aufbauen",
  "localKnowledge.detail.actions.refresh.title": "Geänderte Dateien aktualisieren",
  "localKnowledge.detail.actions.refresh.description":
    "Führt eine inkrementelle Aktualisierung aus. Unveränderte Dateien bleiben bestehen, geänderte Dateien werden neu indexiert und entfernte Dateien bereinigt.",
  "localKnowledge.detail.actions.refresh.confirm": "Aktualisieren",
  "localKnowledge.detail.actions.refresh.button": "Geänderte Dateien aktualisieren",
  "localKnowledge.detail.actions.refresh.aria":
    "Geänderte Dateien für Knowledge Pod {name} aktualisieren",
  "localKnowledge.detail.actions.repair.title": "Fehlgeschlagene Dateien reparieren",
  "localKnowledge.detail.actions.repair.description":
    "Versucht zuvor fehlgeschlagene Dateien erneut und nimmt neu geänderte Dateien im selben inkrementellen Lauf mit.",
  "localKnowledge.detail.actions.repair.confirm": "Reparieren",
  "localKnowledge.detail.actions.repair.button": "Fehlgeschlagene Dateien reparieren",
  "localKnowledge.detail.actions.repair.aria":
    "Fehlgeschlagene Dateien für Knowledge Pod {name} reparieren",
  "localKnowledge.detail.progress.indexing": "Dokumente werden indexiert",
  "localKnowledge.detail.progress.reembedding":
    "Vektoren werden für das aktuelle Modell neu erstellt",
  "localKnowledge.detail.progress.refreshing": "Geänderte Dateien werden aktualisiert",
  "localKnowledge.detail.progress.repairing": "Fehlgeschlagene Dateien werden repariert",
  "localKnowledge.detail.progress.remaining": "Voraussichtlich verbleibend: {duration}",
  "localKnowledge.detail.progress.estimating": "Verbleibende Zeit wird geschätzt",
  "localKnowledge.detail.progress.elapsed": "Läuft weiter. Verstrichen: {duration}. {eta}.",
  "localKnowledge.detail.progress.documents": "Dokumente",
  "localKnowledge.detail.progress.vectors": "Vektoren",
  "localKnowledge.detail.progress.documentProgress": "Fortschritt der Dokumentaktion",
  "localKnowledge.detail.progress.vectorProgress": "Fortschritt der Vektoraktion",
  "localKnowledge.detail.progress.delayed": "Fortschrittsaktualisierung verzögert sich: {error}",
  "localKnowledge.detail.deleteAffectedSets.title": "Mitgliedschaft in Knowledge Pod Sets geändert",
  "localKnowledge.detail.deleteAffectedSets.description.one":
    "Dieser Knowledge Pod wurde aus einem Knowledge Pod Set entfernt, zu dem er gehörte.",
  "localKnowledge.detail.deleteAffectedSets.description.many":
    "Dieser Knowledge Pod wurde aus {count} Knowledge Pod Sets entfernt, zu denen er gehörte.",
  "localKnowledge.detail.index.title": "Indexstatus",
  "localKnowledge.detail.index.noJobRecorded": "Kein Job aufgezeichnet",
  "localKnowledge.detail.index.runFailed": "Indexierung fehlgeschlagen: {message}",
  "localKnowledge.detail.index.eta": "ETA {duration}",
  "localKnowledge.detail.index.updating": "Aktualisiert alle 2 s",
  "localKnowledge.detail.index.latestRun": "Letzter Lauf",
  "localKnowledge.detail.index.indexedDocuments": "Indexierte Dokumente",
  "localKnowledge.detail.index.failedSkipped": "{failed} fehlgeschlagen, {skipped} übersprungen",
  "localKnowledge.detail.index.vectors": "Vektoren",
  "localKnowledge.detail.index.chunksMissingVectors": "{count} Chunks ohne Vektoren",
  "localKnowledge.detail.index.allChunksEmbedded": "Alle Chunks haben Embeddings",
  "localKnowledge.detail.index.latestJob": "Letzter Job",
  "localKnowledge.detail.index.notIndexed": "Nicht indexiert",
  "localKnowledge.detail.index.discoveryProgress": "Discovery-Fortschritt",
  "localKnowledge.detail.index.retrievalCoverage": "Retrieval-Abdeckung",
  "localKnowledge.detail.index.embeddingStopped":
    "Embedding wurde vorzeitig beendet: {message}. Für {count} Chunks fehlen noch Vektoren.",
  "localKnowledge.detail.index.missingVectors":
    "Für {count} Chunks fehlen noch Vektoren, bevor Retrieval die gesamte Quelle abdecken kann.",
  "localKnowledge.detail.index.unsupportedDocuments":
    "{count} Dokumente benötigen einen anderen Extraktionspfad, bevor sie indexiert werden können.",
  "localKnowledge.detail.index.aligned": "Index und Vektoren passen zum aktuellen Quellensatz.",
  "localKnowledge.detail.compatibility.title": "Embedding-Kompatibilität",
  "localKnowledge.detail.compatibility.compatible": "Kompatibel",
  "localKnowledge.detail.compatibility.unknown": "Unbekannt",
  "localKnowledge.detail.compatibility.incompatible": "Inkompatibel",
  "localKnowledge.detail.compatibility.notConfigured": "Nicht konfiguriert",
  "localKnowledge.detail.compatibility.noProvider": "Kein Embedding-Anbieter",
  "localKnowledge.detail.compatibility.readyMessage":
    "Das fixierte Embedding-Modell ist für Embeddings konfiguriert.",
  "localKnowledge.detail.compatibility.fixGatewayMessage":
    "Embedding-Kompatibilität konnte nicht bestätigt werden. Führe nach der Gateway-Korrektur eine vollständige Neuerstellung der Vektoren aus.",
  "localKnowledge.detail.compatibility.pinnedModel": "Fixiertes Modell",
  "localKnowledge.detail.compatibility.currentModel": "Aktuelles Embedding-Modell",
  "localKnowledge.detail.compatibility.metric": "Kompatibilität",
  "localKnowledge.detail.compatibility.legacyHealth": "Legacy-Health",
  "localKnowledge.detail.overview.title": "Überblick",
  "localKnowledge.detail.overview.name": "Name",
  "localKnowledge.detail.overview.description": "Beschreibung",
  "localKnowledge.detail.overview.tags": "Knowledge Pod Tags",
  "localKnowledge.detail.overview.statusAria": "Status: {status}",
  "localKnowledge.detail.overview.embeddingModel": "Embedding-Modell",
  "localKnowledge.detail.overview.storageSize": "Speichergröße",
  "localKnowledge.detail.overview.unsupportedDocuments": "Nicht unterstützte Dokumente",
  "localKnowledge.detail.overview.lastIndexed": "Zuletzt indexiert",
  "localKnowledge.detail.overview.vectorCompatible": "Vektorkompatibel",
  "localKnowledge.detail.overview.vectorUnknown": "Unbekannt — Gateway-Konfiguration prüfen",
  "localKnowledge.detail.overview.vectorIncompatible":
    "Inkompatibel — Vektoren vollständig neu erstellen",
  "localKnowledge.detail.overview.staleReasons": "Gründe für veralteten Zustand",
  "localKnowledge.detail.overview.nextSteps": "Nächste Schritte",
  "localKnowledge.detail.overview.unsupportedGuidance":
    "Hinweise zu nicht unterstützten Dokumenten",
  "localKnowledge.detail.overview.unsupported.pdfNeedsOcr":
    "Gescannte PDFs benötigen einen OCR-fähigen Extraktionspfad. Konfiguriere einen verifizierten OCR- oder Vision-Adapter oder stelle ein PDF mit Textebene bereit.",
  "localKnowledge.detail.overview.unsupported.imageNeedsOcr":
    "Reine Bilddokumente benötigen einen OCR-fähigen Extraktionspfad, bevor sie indexiert werden können.",
  "localKnowledge.detail.overview.unsupported.ocrFailed":
    "Die OCR-Extraktion ist für mindestens ein Dokument fehlgeschlagen. Prüfe die Konfiguration des OCR-Adapters und starte die Indexierung erneut.",
  "localKnowledge.detail.overview.unsupported.unsupportedFormat":
    "Einige Dokumente werden in diesem Build nicht unterstützt. Prüfe die Diagnosen im Zustandsbericht für die betroffenen Formate und die nächsten Schritte.",
  "localKnowledge.detail.context.title": "Kontextuelles Retrieval",
  "localKnowledge.detail.context.description":
    "Erzeugt beim Indexieren pro Chunk einen zusätzlichen Chat-Aufruf für Kontext. Baue den Knowledge Pod nach dem Speichern vollständig neu auf.",
  "localKnowledge.detail.context.status.ready": "Bereit",
  "localKnowledge.detail.context.status.rebuild": "Neuaufbau erforderlich",
  "localKnowledge.detail.context.status.degraded": "Eingeschränkt",
  "localKnowledge.detail.context.status.unavailable": "Nicht verfügbar",
  "localKnowledge.detail.context.status.disabled": "Deaktiviert",
  "localKnowledge.detail.context.saved":
    "Gespeichert. Baue diesen Knowledge Pod vollständig neu auf, damit die Retrieval-Texte aktualisiert werden.",
  "localKnowledge.detail.context.saveFailed":
    "Kontextuelles Retrieval konnte nicht gespeichert werden.",
  "localKnowledge.detail.context.retrievalContext": "Retrieval-Kontext",
  "localKnowledge.detail.context.settingsSource": "Einstellungen: {source}",
  "localKnowledge.detail.context.model": "Kontextmodell",
  "localKnowledge.detail.context.gatewayDefault": "Gateway-Standard",
  "localKnowledge.detail.context.strict": "strikt",
  "localKnowledge.detail.context.nonStrict": "Fallback erlaubt",
  "localKnowledge.detail.context.staleChunks": "Veraltete Kontext-Chunks",
  "localKnowledge.detail.context.degradedChunks": "{count} eingeschränkt",
  "localKnowledge.detail.context.generateAtIndex": "Retrieval-Kontext beim Indexieren erzeugen",
  "localKnowledge.detail.context.modelId": "Kontextmodell-ID",
  "localKnowledge.detail.context.defaultModelPlaceholder":
    "Standard-Chatmodell des Gateways nutzen",
  "localKnowledge.detail.context.failOnError":
    "Indexierung fehlschlagen lassen, wenn Kontext nicht erzeugt werden kann",
  "localKnowledge.detail.context.generatedLimit": "Zeichenlimit für erzeugten Kontext",
  "localKnowledge.detail.context.documentLimit": "Zeichenlimit für Dokumentkontext",
  "localKnowledge.detail.context.save": "Retrieval-Einstellungen speichern",
  "localKnowledge.detail.sources.title": "Quellen",
  "localKnowledge.detail.sources.empty": "Mit diesem Knowledge Pod sind keine Quellen verbunden.",
  "localKnowledge.detail.sources.list": "Quellen des Knowledge Pod",
  "localKnowledge.detail.sources.selectedFiles.one": "{root} (1 ausgewählte Datei)",
  "localKnowledge.detail.sources.selectedFiles.many": "{root} ({count} ausgewählte Dateien)",
  "localKnowledge.detail.sources.coverage":
    "Dokumentabdeckung der Quelle: {indexed} indexiert, {failed} fehlgeschlagen, {skipped} übersprungen",
  "localKnowledge.detail.counts.indexed": "{count} indexiert",
  "localKnowledge.detail.counts.failed": "{count} fehlgeschlagen",
  "localKnowledge.detail.counts.skipped": "{count} übersprungen",
  "localKnowledge.detail.counts.processed": "{count} verarbeitet",
  "localKnowledge.detail.privacy.title": "Datenschutz und Löschung",
  "localKnowledge.detail.privacy.details": "Details zu Datenschutz und Löschung",
  "localKnowledge.detail.privacy.localState":
    "Indexierter Text, Vektoren, Diagnosen und Job-Historie bleiben im lokalen Keiko-Laufzeitstatus auf diesem Gerät.",
  "localKnowledge.detail.privacy.modelGateway":
    "Ausgewählte Chunks können beim Indexieren für Embeddings und bei geerdeten Antworten über das konfigurierte Model Gateway gesendet werden, wenn du Fragen zu diesem Knowledge Pod stellst.",
  "localKnowledge.detail.privacy.deletion":
    "Beim Löschen eines Knowledge Pod werden seine lokalen Indexdaten und Mitgliedschaften in Knowledge Pod Sets entfernt. Quelldateien auf der Festplatte werden nicht gelöscht.",
  "localKnowledge.detail.diagnostics.title": "Health-Diagnosen",
  "localKnowledge.detail.diagnostics.empty":
    "Keine Parser-Diagnosen — alle Dokumente wurden sauber verarbeitet.",
  "localKnowledge.detail.diagnostics.groupedList": "Gruppierte Parser-Diagnosen",
  "localKnowledge.detail.diagnostics.list": "Parser-Diagnosen",
  "localKnowledge.detail.diagnostics.severity.info": "Info",
  "localKnowledge.detail.diagnostics.severity.warning": "Warnung",
  "localKnowledge.detail.diagnostics.severity.error": "Fehler",
  "localKnowledge.detail.diagnostics.groupAria": "{severity}: {code} ({count}x)",
  "localKnowledge.detail.diagnostics.rowAria": "{severity}: {code}",
  "localKnowledge.detail.jobs.title": "Indexierungs-Historie",
  "localKnowledge.detail.jobs.empty": "Noch keine Indexierungsjobs aufgezeichnet.",
  "localKnowledge.detail.jobs.list": "Indexierungs-Historie",
  "localKnowledge.detail.jobs.inProgress": "Läuft",
  "localKnowledge.detail.jobs.rowAria": "Job {id}: {status}",
  "localKnowledge.detail.jobs.status.queued": "In Warteschlange",
  "localKnowledge.detail.jobs.status.running": "Läuft",
  "localKnowledge.detail.jobs.status.succeeded": "Erfolgreich",
  "localKnowledge.detail.jobs.status.failed": "Fehlgeschlagen",
  "localKnowledge.detail.jobs.status.cancelled": "Abgebrochen",
  "localKnowledge.detail.large.title": "Große Dokumente",
  "localKnowledge.detail.large.list": "Fortschritt großer Dokumente",
  "localKnowledge.detail.large.qualityWarnings": "Warnungen zur Retrieval-Qualität",
  "localKnowledge.detail.large.inProgress": "In Bearbeitung: {phases}",
  "localKnowledge.detail.large.idle": "Inaktiv",
  "localKnowledge.detail.large.coverage": "{coverage}-Abdeckung",
  "localKnowledge.detail.large.pages": "{count} Seiten",
  "localKnowledge.detail.large.chunksEmbedded": "{embedded}/{chunks} Chunks mit Embedding",
  "localKnowledge.detail.large.resumable": "fortsetzbar",
  "localKnowledge.detail.large.resumeFailed": "Fortsetzen fehlgeschlagen.",
  "localKnowledge.detail.large.partialCoverage.one":
    "1 Dokument wurde mit teilweiser Abdeckung indexiert. Die Pipeline ist stabil; die Retrieval-Qualität ist für dieses Dokument eingeschränkt.",
  "localKnowledge.detail.large.partialCoverage.many":
    "{count} Dokumente wurden mit teilweiser Abdeckung indexiert. Die Pipeline ist stabil; die Retrieval-Qualität ist für diese Dokumente eingeschränkt.",
  "localKnowledge.detail.large.resumeAria": "Unterbrochene Indexierung großer Dokumente fortsetzen",
  "localKnowledge.detail.large.resuming": "Setze fort…",
  "localKnowledge.detail.large.resume.one": "1 Dokument fortsetzen",
  "localKnowledge.detail.large.resume.many": "{count} Dokumente fortsetzen",
  "localKnowledge.detail.recovery.title": "Unterbrochene Indexierung",
  "localKnowledge.detail.recovery.active":
    "Die Indexierung ist noch aktiv ({processed} verarbeitet über {sources} Quellen).",
  "localKnowledge.detail.recovery.resumable":
    "Ein unterbrochener Lauf kann fortgesetzt werden ({processed} verarbeitet über {sources} Quellen).",
  "localKnowledge.detail.recovery.resume": "Indexierung fortsetzen",
  "localKnowledge.detail.recovery.resuming": "Wird fortgesetzt…",
  "localKnowledge.detail.recovery.resumeAria": "Unterbrochene Indexierung fortsetzen",
  "localKnowledge.detail.recovery.failed": "Fortsetzen fehlgeschlagen.",
  "localKnowledge.detail.large.phase.preflight": "Vorprüfung",
  "localKnowledge.detail.large.phase.extracting": "Extraktion",
  "localKnowledge.detail.large.phase.extracted": "Extrahiert",
  "localKnowledge.detail.large.phase.chunking": "Chunking",
  "localKnowledge.detail.large.phase.chunked": "In Chunks zerlegt",
  "localKnowledge.detail.large.phase.embedding": "Embedding",
  "localKnowledge.detail.large.phase.embedded": "Embedding erstellt",
  "localKnowledge.detail.large.phase.complete": "Abgeschlossen",
  "localKnowledge.detail.large.phase.cancelled": "Abgebrochen",
  "localKnowledge.detail.large.phase.failed": "Fehlgeschlagen",
};
