"use client";

import { useMemo } from "react";
import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

const SETTINGS_MESSAGES = {
  "settings.models.gatewayTitle": {
    en: "Model gateway",
    de: "Modell-Gateway",
  },
  "settings.models.gatewayDescription": {
    en: "Credentials are stored locally by the Keiko loopback server; secrets are never returned to the browser.",
    de: "Zugangsdaten werden lokal vom Keiko-Loopback-Server gespeichert; Secrets werden nie an den Browser zurückgegeben.",
  },
  "settings.models.updateCredentials": {
    en: "Update credentials",
    de: "Zugangsdaten aktualisieren",
  },
  "settings.models.connectGateway": {
    en: "Connect gateway",
    de: "Gateway verbinden",
  },
  "settings.models.setupRequired": {
    en: "Gateway setup required",
    de: "Gateway-Einrichtung erforderlich",
  },
  "settings.models.connected": {
    en: "Gateway connected",
    de: "Gateway verbunden",
  },
  "settings.models.configured": {
    en: "Gateway configured",
    de: "Gateway konfiguriert",
  },
  "settings.models.detailSetup": {
    en: "Enter the gateway base URL and API token before using chat or agent workflows.",
    de: "Gib Gateway-Basis-URL und API-Token ein, bevor du Chat- oder Agent-Workflows nutzt.",
  },
  "settings.models.detailNoModels": {
    en: "The gateway is configured, but no conversation-capable models are currently available.",
    de: "Das Gateway ist konfiguriert, aber aktuell sind keine dialogfähigen Modelle verfügbar.",
  },
  "settings.models.detailNoChat": {
    en: "Gateway connected, but none of the discovered models can be used for conversation. Add a chat-capable deployment.",
    de: "Gateway verbunden, aber keines der gefundenen Modelle kann für Konversationen genutzt werden. Füge ein chatfähiges Deployment hinzu.",
  },
  "settings.models.detailReady": {
    en: "Keiko can use the configured gateway models for chat and agent workflows.",
    de: "Keiko kann die konfigurierten Gateway-Modelle für Chat- und Agent-Workflows nutzen.",
  },
  "settings.models.modelCount": {
    en: "{count} models",
    de: "{count} Modelle",
  },
  "settings.models.chatCount": {
    en: "{count} chat",
    de: "{count} Chat",
  },
  "settings.models.statusConfigured": {
    en: "gateway configured",
    de: "Gateway konfiguriert",
  },
  "settings.models.statusSetupRequired": {
    en: "setup required",
    de: "Einrichtung erforderlich",
  },
  "settings.models.statusConversationEligible": {
    en: "conversation-eligible",
    de: "konversationsfähig",
  },
  "settings.models.statusEmbedding": {
    en: "available for embeddings",
    de: "für Embeddings verfügbar",
  },
  "settings.models.statusNotSelectable": {
    en: "not selectable for conversation",
    de: "nicht für Konversationen auswählbar",
  },
  "settings.models.loadError": {
    en: "Could not load gateway settings - the local Keiko backend did not respond.",
    de: "Gateway-Einstellungen konnten nicht geladen werden - das lokale Keiko-Backend hat nicht geantwortet.",
  },
  "settings.models.retry": {
    en: "Retry",
    de: "Erneut versuchen",
  },
  "settings.models.loading": {
    en: "Loading gateway models...",
    de: "Gateway-Modelle werden geladen…",
  },
  "settings.models.emptyConfigured": {
    en: "No conversation-capable models are currently available. Review the gateway configuration or discovered model set.",
    de: "Aktuell sind keine dialogfähigen Modelle verfügbar. Prüfe die Gateway-Konfiguration oder die gefundenen Modelle.",
  },
  "settings.models.emptyUnconfigured": {
    en: "No models are configured yet. Connect the gateway to load configured model capabilities.",
    de: "Noch sind keine Modelle konfiguriert. Verbinde das Gateway, um konfigurierte Modellfähigkeiten zu laden.",
  },
  "settings.models.eligibilityOk": {
    en: "Conversation-eligible",
    de: "Konversationsfähig",
  },
  "settings.models.eligibilityOkAria": {
    en: "Model eligibility: eligible for conversation",
    de: "Modelleignung: für Konversationen geeignet",
  },
  "settings.models.eligibilityPrefix": {
    en: "Model eligibility: {label}",
    de: "Modelleignung: {label}",
  },
  "settings.models.embeddingLabel": {
    en: "Embedding-ready",
    de: "Embedding-bereit",
  },
  "settings.models.embeddingAvailable": {
    en: "Available for embeddings; not shown in the chat model picker",
    de: "Für Embeddings verfügbar; nicht in der Chat-Modellauswahl sichtbar",
  },
  "settings.models.ineligibleEmbedding": {
    en: "Embedding model - not selectable for text conversation",
    de: "Embedding-Modell - nicht für Textkonversationen auswählbar",
  },
  "settings.models.ineligibleOcr": {
    en: "OCR/vision-only - not selectable for text conversation",
    de: "Nur OCR/Vision - nicht für Textkonversationen auswählbar",
  },
  "settings.models.ineligibleGeneric": {
    en: "Not a chat model - not selectable for text conversation",
    de: "Kein Chat-Modell - nicht für Textkonversationen auswählbar",
  },
  "settings.models.ineligibleShortOcr": {
    en: "OCR/vision-only",
    de: "nur OCR/Vision",
  },
  "settings.models.ineligibleShortGeneric": {
    en: "not a chat model",
    de: "kein Chat-Modell",
  },
  "settings.models.notSelectable": {
    en: "Not selectable - {reason}",
    de: "Nicht auswählbar - {reason}",
  },
  "settings.models.voiceProviderAvailable": {
    en: "Voice provider - available for {capabilities}{personas}",
    de: "Sprachanbieter - verfügbar für {capabilities}{personas}",
  },
  "settings.models.voiceProviderBadge": {
    en: "Voice provider - {label}",
    de: "Sprachanbieter - {label}",
  },
  "settings.models.voiceCapabilitySpeechToText": {
    en: "speech-to-text",
    de: "Speech-to-Text",
  },
  "settings.models.voiceCapabilitySpeechOutput": {
    en: "speech output",
    de: "Sprachausgabe",
  },
  "settings.models.voiceCapabilityRealtimeDialogue": {
    en: "realtime dialogue",
    de: "Echtzeitdialog",
  },
  "settings.models.voiceCapabilityVoice": {
    en: "voice",
    de: "Sprache",
  },
  "settings.models.voicePersonas": {
    en: "; voices: {personas}",
    de: "; Stimmen: {personas}",
  },
  "settings.models.readinessError": {
    en: "Readiness check failed. The gateway configuration was not changed.",
    de: "Bereitschaftsprüfung fehlgeschlagen. Die Gateway-Konfiguration wurde nicht geändert.",
  },
  "settings.models.copyReport": {
    en: "Copy report",
    de: "Bericht kopieren",
  },
  "settings.models.copied": {
    en: "Copied",
    de: "Kopiert",
  },
  "settings.models.reportCopied": {
    en: "Readiness report copied.",
    de: "Bereitschaftsbericht kopiert.",
  },
  "settings.models.reportCopyFailed": {
    en: "Clipboard access failed. Select and copy the report details manually.",
    de: "Zugriff auf die Zwischenablage fehlgeschlagen. Wähle die Berichtdetails aus und kopiere sie manuell.",
  },
  "settings.models.checkingReadiness": {
    en: "Checking {mode} readiness...",
    de: "Bereitschaftsprüfung läuft ({mode})…",
  },
  "settings.models.readinessModeDeep": {
    en: "deep",
    de: "tief",
  },
  "settings.models.readinessModeBasic": {
    en: "basic",
    de: "einfach",
  },
  "settings.models.workingToday": {
    en: "Working today",
    de: "Heute funktionsfähig",
  },
  "settings.models.notVerified": {
    en: "Not verified",
    de: "Nicht verifiziert",
  },
  "settings.models.verifiedCapabilities": {
    en: "Verified capabilities",
    de: "Verifizierte Fähigkeiten",
  },
  "settings.models.capabilityStreaming": {
    en: "Streaming",
    de: "Streaming",
  },
  "settings.models.capabilityTools": {
    en: "Tools",
    de: "Tools",
  },
  "settings.models.capabilityJson": {
    en: "JSON",
    de: "JSON",
  },
  "settings.models.capabilityReasoning": {
    en: "Reasoning",
    de: "Reasoning",
  },
  "settings.models.capabilityImage": {
    en: "Image",
    de: "Bild",
  },
  "settings.models.capabilityPdf": {
    en: "PDF",
    de: "PDF",
  },
  "settings.models.contextTokensShort": {
    en: "{count} ctx",
    de: "{count} ctx",
  },
  "settings.models.runReadiness": {
    en: "Run readiness check",
    de: "Bereitschaft prüfen",
  },
  "settings.models.deepProbes": {
    en: "Deep probes",
    de: "Tiefe Prüfungen",
  },
  "settings.models.capabilitySummary": {
    en: "tools {tools} · structured {structured} · {costClass}/{latencyClass}",
    de: "Tools {tools} · strukturiert {structured} · {costClass}/{latencyClass}",
  },
  "settings.models.yes": {
    en: "yes",
    de: "ja",
  },
  "settings.models.no": {
    en: "no",
    de: "nein",
  },
  "settings.selfHosted": {
    en: "Self-hosted",
    de: "Self-hosted",
  },
  "settings.selfHostedTitle": {
    en: "Runs inside your network",
    de: "Läuft in deinem Netzwerk",
  },
  "settings.tabs.models": {
    en: "Models",
    de: "Modelle",
  },
  "settings.tabs.general": {
    en: "General",
    de: "Allgemein",
  },
  "settings.tabs.editor": {
    en: "Editor",
    de: "Editor",
  },
  "settings.tabs.languages": {
    en: "Languages",
    de: "Sprachen",
  },
  "settings.tabs.security": {
    en: "Security",
    de: "Sicherheit",
  },
  "settings.editor.title": {
    en: "Editor settings",
    de: "Editor-Einstellungen",
  },
  "settings.editor.description": {
    en: "Search, scope, change, and reset server-owned editor preferences. Values apply only after Keiko returns the matching effective snapshot.",
    de: "Suche, ändere und setze serververwaltete Editor-Einstellungen je nach Geltungsbereich zurück. Werte gelten erst, wenn Keiko den passenden effektiven Snapshot zurückgibt.",
  },
  "settings.editor.search": {
    en: "Search editor settings",
    de: "Editor-Einstellungen suchen",
  },
  "settings.editor.scope": {
    en: "Scope",
    de: "Geltungsbereich",
  },
  "settings.editor.scopeUser": {
    en: "User",
    de: "Benutzer",
  },
  "settings.editor.scopeWorkspace": {
    en: "Workspace",
    de: "Arbeitsbereich",
  },
  "settings.editor.modifiedOnly": {
    en: "Modified only",
    de: "Nur geänderte",
  },
  "settings.editor.resetAll": {
    en: "Reset visible settings",
    de: "Sichtbare Einstellungen zurücksetzen",
  },
  "settings.editor.noWorkspace": {
    en: "Open a workspace to edit workspace-scoped settings.",
    de: "Öffne einen Arbeitsbereich, um arbeitsbereichsbezogene Einstellungen zu ändern.",
  },
  "settings.editor.loading": {
    en: "Loading editor settings...",
    de: "Editor-Einstellungen werden geladen…",
  },
  "settings.editor.empty": {
    en: "No editor settings match the current filter.",
    de: "Keine Editor-Einstellung passt zum aktuellen Filter.",
  },
  "settings.editor.loadError": {
    en: "Editor settings could not be loaded.",
    de: "Editor-Einstellungen konnten nicht geladen werden.",
  },
  "settings.editor.mutationError": {
    en: "Editor settings could not be saved.",
    de: "Editor-Einstellungen konnten nicht gespeichert werden.",
  },
  "settings.editor.conflict": {
    en: "Editor settings changed elsewhere. The latest snapshot was reloaded.",
    de: "Editor-Einstellungen wurden anderswo geändert. Der aktuelle Snapshot wurde neu geladen.",
  },
  "settings.editor.retry": {
    en: "Retry",
    de: "Erneut versuchen",
  },
  "settings.editor.reset": {
    en: "Reset at selected scope",
    de: "Im ausgewählten Geltungsbereich zurücksetzen",
  },
  "settings.editor.applying": {
    en: "Applying editor setting...",
    de: "Editor-Einstellung wird angewendet…",
  },
  "settings.editor.applied": {
    en: "Editor setting applied.",
    de: "Editor-Einstellung angewendet.",
  },
  "settings.editor.source": {
    en: "Source: {source}",
    de: "Quelle: {source}",
  },
  "settings.editor.sourceBuiltInDefault": {
    en: "built-in default",
    de: "eingebaute Vorgabe",
  },
  "settings.editor.sourceUser": {
    en: "user",
    de: "Benutzer",
  },
  "settings.editor.sourceWorkspace": {
    en: "workspace",
    de: "Arbeitsbereich",
  },
  "settings.editor.effectLive": {
    en: "Live",
    de: "Live",
  },
  "settings.editor.effectRestart": {
    en: "Restart",
    de: "Neustart",
  },
  "settings.editor.policyLocked": {
    en: "Locked by policy: {reason}",
    de: "Durch Richtlinie gesperrt: {reason}",
  },
  "settings.editor.aiStatus": {
    en: "AI status: {state} ({reason})",
    de: "KI-Status: {state} ({reason})",
  },
  "settings.editor.confirmInlineCompletion": {
    en: "Enable inline AI completion for this user? Keiko will route optional ghost-text requests through the governed Model Gateway only when operator policy, model capability, budget, and health allow it. This does not grant patch, execution, delivery, or wider authority.",
    de: "Inline-KI-Vervollständigung für diesen Benutzer aktivieren? Keiko sendet optionale Ghost-Text-Anfragen nur über das governte Model Gateway, wenn Operator-Policy, Modellfähigkeit, Budget und Health es erlauben. Das gewährt keine Patch-, Ausführungs-, Delivery- oder weitergehende Autorität.",
  },
  "settings.editor.confirmTestGeneration": {
    en: "Enable AI test generation for this workspace? Generated tests remain review-only, use the governed Model Gateway when available, and cannot execute or apply without the existing review and verification gates.",
    de: "KI-Testgenerierung für diesen Arbeitsbereich aktivieren? Generierte Tests bleiben review-pflichtig, nutzen bei Verfügbarkeit das governte Model Gateway und können ohne bestehende Review- und Verification-Gates nicht ausgeführt oder angewendet werden.",
  },
  "settings.editor.confirmPatchApply": {
    en: "Enable governed AI patch apply for this workspace? Keiko will still require explicit human review for each patch, revalidate the diff server-side, and will not grant delivery, merge, or authority-widening rights.",
    de: "Governten KI-Patch-Apply für diesen Arbeitsbereich aktivieren? Keiko verlangt weiterhin explizites menschliches Review für jeden Patch, validiert den Diff serverseitig erneut und gewährt keine Delivery-, Merge- oder Authority-Erweiterung.",
  },
  "settings.editor.scopeUnavailable": {
    en: "This setting cannot be changed at the selected scope.",
    de: "Diese Einstellung kann im ausgewählten Geltungsbereich nicht geändert werden.",
  },
  "settings.editor.followupExternalReload": {
    en: "External reload automation is enabled in the watcher milestone; this release shows the effective policy.",
    de: "Automatisches externes Neuladen wird im Watcher-Meilenstein aktiviert; diese Version zeigt die effektive Richtlinie.",
  },
  "settings.editor.setting.fontSize": {
    en: "Font size",
    de: "Schriftgröße",
  },
  "settings.editor.setting.tabSize": {
    en: "Tab size",
    de: "Tabulatorbreite",
  },
  "settings.editor.setting.insertSpaces": {
    en: "Insert spaces",
    de: "Leerzeichen einfügen",
  },
  "settings.editor.setting.wordWrap": {
    en: "Word wrap",
    de: "Zeilenumbruch",
  },
  "settings.editor.setting.renderWhitespace": {
    en: "Render whitespace",
    de: "Leerzeichen anzeigen",
  },
  "settings.editor.setting.minimap": {
    en: "Minimap",
    de: "Minimap",
  },
  "settings.editor.setting.formatOnSave": {
    en: "Format on save",
    de: "Beim Speichern formatieren",
  },
  "settings.editor.setting.externalReload": {
    en: "External reload",
    de: "Externes Neuladen",
  },
  "settings.editor.setting.inlineCompletion": {
    en: "Inline AI completion",
    de: "Inline-KI-Vervollständigung",
  },
  "settings.editor.setting.testGeneration": {
    en: "AI test generation",
    de: "KI-Testgenerierung",
  },
  "settings.editor.setting.patchApply": {
    en: "AI patch apply",
    de: "KI-Patch-Apply",
  },
  "settings.editor.setting.watcherExclusions": {
    en: "Watcher exclusions",
    de: "Watcher-Ausschlüsse",
  },
  "settings.editor.setting.largeFileMode": {
    en: "Large-file mode",
    de: "Große Dateien",
  },
  "settings.editor.setting.modelRetentionCount": {
    en: "Retained model count",
    de: "Behaltene Modellanzahl",
  },
  "settings.editor.setting.modelRetentionBytes": {
    en: "Retained model bytes",
    de: "Behaltene Modellbytes",
  },
  "settings.editor.setting.keybindingOverrides": {
    en: "Keyboard shortcut overrides",
    de: "Tastenkürzel-Overrides",
  },
  "settings.keyboard.title": {
    en: "Keyboard shortcuts",
    de: "Tastenkürzel",
  },
  "settings.keyboard.description": {
    en: "Search effective shell, editor, and supported Monaco shortcuts. Rebindable commands persist through the server-owned M7 settings control plane.",
    de: "Suche effektive Shell-, Editor- und unterstützte Monaco-Kürzel. Änderbare Befehle werden über die serververwaltete M7-Einstellungssteuerung gespeichert.",
  },
  "settings.keyboard.search": {
    en: "Search keyboard shortcuts",
    de: "Tastenkürzel suchen",
  },
  "settings.keyboard.modifiedOnly": {
    en: "Modified only",
    de: "Nur geänderte",
  },
  "settings.keyboard.resetAll": {
    en: "Reset keyboard shortcuts",
    de: "Tastenkürzel zurücksetzen",
  },
  "settings.keyboard.fallback": {
    en: "Keyboard shortcut overrides were ignored and defaults are active: {reason}.",
    de: "Tastenkürzel-Overrides wurden ignoriert und Vorgaben sind aktiv: {reason}.",
  },
  "settings.keyboard.recordingLive": {
    en: "Recording keyboard shortcut.",
    de: "Tastenkürzel wird aufgezeichnet.",
  },
  "settings.keyboard.reason": {
    en: "Shortcut rejected: {reason}",
    de: "Tastenkürzel abgelehnt: {reason}",
  },
  "settings.keyboard.sourceDefault": {
    en: "default",
    de: "Vorgabe",
  },
  "settings.keyboard.sourceUser": {
    en: "modified",
    de: "geändert",
  },
  "settings.keyboard.scopeGlobal": {
    en: "global",
    de: "global",
  },
  "settings.keyboard.scopeEditor": {
    en: "editor",
    de: "Editor",
  },
  "settings.keyboard.scopeSettings": {
    en: "settings",
    de: "Einstellungen",
  },
  "settings.keyboard.scopeExplorer": {
    en: "explorer",
    de: "Explorer",
  },
  "settings.keyboard.scopeGit": {
    en: "git",
    de: "Git",
  },
  "settings.keyboard.conflict": {
    en: "Conflicts with: {commands}",
    de: "Konflikt mit: {commands}",
  },
  "settings.keyboard.pressShortcut": {
    en: "Press shortcut",
    de: "Tastenkürzel drücken",
  },
  "settings.keyboard.cancel": {
    en: "Cancel",
    de: "Abbrechen",
  },
  "settings.keyboard.record": {
    en: "Record",
    de: "Aufzeichnen",
  },
  "settings.keyboard.remove": {
    en: "Remove",
    de: "Entfernen",
  },
  "settings.keyboard.protected": {
    en: "Protected",
    de: "Geschützt",
  },
  "command.undo": {
    en: "Undo",
    de: "Rückgängig",
  },
  "command.undo.description": {
    en: "Undo the last workspace window or panel action.",
    de: "Macht die letzte Arbeitsbereichs-Fenster- oder Panel-Aktion rückgängig.",
  },
  "command.redo": {
    en: "Redo",
    de: "Wiederholen",
  },
  "command.redo.description": {
    en: "Redo the last reverted workspace window or panel action.",
    de: "Stellt die letzte rückgängig gemachte Fenster- oder Panel-Aktion wieder her.",
  },
  "command.focusStatus": {
    en: "Focus status",
    de: "Status fokussieren",
  },
  "command.focusStatus.description": {
    en: "Move keyboard focus to the workspace status field.",
    de: "Bewegt den Tastaturfokus zum Statusfeld.",
  },
  "command.focusWorkspaceSearch": {
    en: "Focus workspace search",
    de: "Arbeitsbereichssuche fokussieren",
  },
  "command.focusWorkspaceSearch.description": {
    en: "Open or focus workspace search.",
    de: "Öffnet oder fokussiert die Arbeitsbereichssuche.",
  },
  "command.quickAccessFiles": {
    en: "Quick Access: files",
    de: "Schnellzugriff: Dateien",
  },
  "command.quickAccessFiles.description": {
    en: "Open the unified quick-access file picker.",
    de: "Öffnet den einheitlichen Datei-Schnellzugriff.",
  },
  "command.quickAccessCommands": {
    en: "Quick Access: commands",
    de: "Schnellzugriff: Befehle",
  },
  "command.quickAccessCommands.description": {
    en: "Open the unified command palette.",
    de: "Öffnet die einheitliche Befehlspalette.",
  },
  "command.openEditorSettings": {
    en: "Open editor settings",
    de: "Editor-Einstellungen öffnen",
  },
  "command.openEditorSettings.description": {
    en: "Open Settings on the editor preferences view.",
    de: "Öffnet die Einstellungen in der Editor-Ansicht.",
  },
  "command.splitEditorRight": {
    en: "Split editor right",
    de: "Editor rechts teilen",
  },
  "command.splitEditorRight.description": {
    en: "Split the active editor pane to the right.",
    de: "Teilt den aktiven Editorbereich nach rechts.",
  },
  "command.splitEditorDown": {
    en: "Split editor down",
    de: "Editor nach unten teilen",
  },
  "command.splitEditorDown.description": {
    en: "Split the active editor pane downward.",
    de: "Teilt den aktiven Editorbereich nach unten.",
  },
  "command.closeEditorSplit": {
    en: "Close editor split",
    de: "Editor-Teilung schließen",
  },
  "command.closeEditorSplit.description": {
    en: "Close the active editor split.",
    de: "Schließt die aktive Editor-Teilung.",
  },
  "command.nextEditorTab": {
    en: "Next editor tab",
    de: "Nächster Editor-Tab",
  },
  "command.nextEditorTab.description": {
    en: "Move to the next tab in the active editor pane.",
    de: "Wechselt zum nächsten Tab im aktiven Editorbereich.",
  },
  "command.previousEditorTab": {
    en: "Previous editor tab",
    de: "Vorheriger Editor-Tab",
  },
  "command.previousEditorTab.description": {
    en: "Move to the previous tab in the active editor pane.",
    de: "Wechselt zum vorherigen Tab im aktiven Editorbereich.",
  },
  "command.closeEditorTab": {
    en: "Close editor tab",
    de: "Editor-Tab schließen",
  },
  "command.closeEditorTab.description": {
    en: "Close the active editor tab.",
    de: "Schließt den aktiven Editor-Tab.",
  },
  "command.reopenClosedEditor": {
    en: "Reopen closed editor",
    de: "Geschlossenen Editor erneut öffnen",
  },
  "command.reopenClosedEditor.description": {
    en: "Reopen the most recently closed editor tab.",
    de: "Öffnet den zuletzt geschlossenen Editor-Tab erneut.",
  },
  "command.saveAllEditors": {
    en: "Save all editors",
    de: "Alle Editoren speichern",
  },
  "command.saveAllEditors.description": {
    en: "Save every dirty editor tab.",
    de: "Speichert alle geänderten Editor-Tabs.",
  },
  "command.editorSave": {
    en: "Save document",
    de: "Dokument speichern",
  },
  "command.editorSave.description": {
    en: "Monaco save action owned by the editor surface.",
    de: "Von der Editorfläche verwaltete Monaco-Speicheraktion.",
  },
  "command.editorFind": {
    en: "Find in document",
    de: "Im Dokument suchen",
  },
  "command.editorFind.description": {
    en: "Monaco find action.",
    de: "Monaco-Suchaktion.",
  },
  "command.editorFormat": {
    en: "Format document",
    de: "Dokument formatieren",
  },
  "command.editorFormat.description": {
    en: "Monaco format action backed by governed formatting.",
    de: "Monaco-Formataktion mit governter Formatierung.",
  },
  "command.editorGenerateTests": {
    en: "Generate tests",
    de: "Tests generieren",
  },
  "command.editorGenerateTests.description": {
    en: "Host-injected Monaco action for governed test generation.",
    de: "Host-injizierte Monaco-Aktion für governte Testgenerierung.",
  },
  "command.editorAskSelection": {
    en: "Ask Keiko about selection",
    de: "Keiko zur Auswahl fragen",
  },
  "command.editorAskSelection.description": {
    en: "Host-injected Monaco action for selected text context.",
    de: "Host-injizierte Monaco-Aktion für ausgewählten Textkontext.",
  },
  "command.editorRenameSymbol": {
    en: "Rename symbol",
    de: "Symbol umbenennen",
  },
  "command.editorRenameSymbol.description": {
    en: "Monaco rename-symbol action.",
    de: "Monaco-Aktion zum Umbenennen von Symbolen.",
  },
  "command.editorAccessibilityHelp": {
    en: "Accessibility help",
    de: "Barrierefreiheitshilfe",
  },
  "command.editorAccessibilityHelp.description": {
    en: "Monaco accessibility help remains protected.",
    de: "Monaco-Barrierefreiheitshilfe bleibt geschützt.",
  },
  "settings.snippets.title": {
    en: "Workspace snippets",
    de: "Arbeitsbereichs-Snippets",
  },
  "settings.snippets.description": {
    en: "Create governed workspace snippets. Keiko validates the bounded TextMate-compatible subset before it appears in completions.",
    de: "Erstelle governte Arbeitsbereichs-Snippets. Keiko validiert die begrenzte TextMate-kompatible Teilmenge, bevor sie in Vervollständigungen erscheint.",
  },
  "settings.snippets.noWorkspace": {
    en: "Open a workspace to manage workspace snippets.",
    de: "Öffne einen Arbeitsbereich, um Arbeitsbereichs-Snippets zu verwalten.",
  },
  "settings.snippets.issue": {
    en: "Snippet operation failed: {issue}",
    de: "Snippet-Aktion fehlgeschlagen: {issue}",
  },
  "settings.snippets.name": {
    en: "Name",
    de: "Name",
  },
  "settings.snippets.prefix": {
    en: "Prefix",
    de: "Präfix",
  },
  "settings.snippets.language": {
    en: "Language",
    de: "Sprache",
  },
  "settings.snippets.include": {
    en: "Include glob",
    de: "Include-Glob",
  },
  "settings.snippets.body": {
    en: "Body",
    de: "Body",
  },
  "settings.snippets.preview": {
    en: "Preview",
    de: "Vorschau",
  },
  "settings.snippets.save": {
    en: "Save snippet",
    de: "Snippet speichern",
  },
  "settings.snippets.reset": {
    en: "Reset snippets",
    de: "Snippets zurücksetzen",
  },
  "settings.snippets.empty": {
    en: "No workspace snippets are defined.",
    de: "Keine Arbeitsbereichs-Snippets definiert.",
  },
  "settings.snippets.lines": {
    en: "{count} lines",
    de: "{count} Zeilen",
  },
  "settings.snippets.delete": {
    en: "Delete",
    de: "Löschen",
  },
  "settings.language.title": {
    en: "Language",
    de: "Sprache",
  },
  "settings.language.description": {
    en: "Choose the language used by the Keiko browser interface.",
    de: "Wähle die Sprache der Keiko-Oberfläche.",
  },
  "settings.language.label": {
    en: "Interface language",
    de: "Sprache der Oberfläche",
  },
  "settings.language.help": {
    en: "Saved on this device and applied immediately.",
    de: "Wird auf diesem Gerät gespeichert und sofort angewendet.",
  },
  "settings.voice.title": {
    en: "Assistant voice",
    de: "Assistenzstimme",
  },
  "settings.voice.description": {
    en: "Choose the voice used by Voice Dialogue.",
    de: "Wähle die Stimme für den Sprachdialog.",
  },
  "settings.voice.label": {
    en: "Voice",
    de: "Stimme",
  },
  "settings.voice.help": {
    en: "Saved on this device and used the next time Voice Dialogue speaks.",
    de: "Wird auf diesem Gerät gespeichert und beim nächsten Sprachdialog genutzt.",
  },
  "settings.voice.unavailable": {
    en: "Voice choices become available after a configured voice provider exposes speech output.",
    de: "Stimmen sind verfügbar, sobald ein verbundener Sprachanbieter Sprachausgabe bereitstellt.",
  },
  "settings.wallpaper.title": {
    en: "Workspace wallpaper",
    de: "Arbeitsbereich-Hintergrund",
  },
  "settings.wallpaper.description": {
    en: "Liquid Chrome - a subtle metallic flow behind the grid that reacts to your cursor and clicks. Turn it off to stop the WebGL animation completely.",
    de: "Liquid Chrome ist ein dezenter metallischer Hintergrund hinter dem Raster, der auf Cursor und Klicks reagiert. Schalte ihn aus, um die WebGL-Animation vollständig zu stoppen.",
  },
  "settings.wallpaper.toggle": {
    en: "Liquid wallpaper",
    de: "Liquid-Hintergrund",
  },
  "settings.wallpaper.running": {
    en: "Running",
    de: "Aktiv",
  },
  "settings.wallpaper.stopped": {
    en: "Stopped",
    de: "Gestoppt",
  },
  "settings.wallpaper.opacity": {
    en: "Wallpaper opacity",
    de: "Deckkraft des Hintergrunds",
  },
  "settings.scale.off": {
    en: "Off",
    de: "Aus",
  },
  "settings.scale.full": {
    en: "Full",
    de: "Voll",
  },
  "settings.scale.base": {
    en: "Base",
    de: "Basis",
  },
  "settings.scale.lighter": {
    en: "Lighter",
    de: "Heller",
  },
  "settings.scale.subtle": {
    en: "Subtle",
    de: "Dezent",
  },
  "settings.scale.strong": {
    en: "Strong",
    de: "Stark",
  },
  "settings.workspace.backgroundBrightness": {
    en: "Workspace background brightness",
    de: "Helligkeit des Arbeitsbereichs",
  },
  "settings.workspace.gridStrength": {
    en: "Workspace grid strength",
    de: "Rasterstärke",
  },
  "settings.workspace.cameraAnimation": {
    en: "Workspace camera smoothness",
    de: "Kamera-Animation",
  },
  "settings.workspace.cameraAnimationMinimal": {
    en: "Minimal",
    de: "Minimal",
  },
  "settings.workspace.cameraAnimationSmooth": {
    en: "Smooth",
    de: "Sanft",
  },
  "settings.workspace.cameraAnimationHelp": {
    en: "Move right to make pan and zoom transitions softer. Minimal applies changes immediately.",
    de: "Weiter rechts werden Schwenken und Zoomen weicher animiert. Minimal wendet Änderungen direkt an.",
  },
  "settings.workspace.borderStrength": {
    en: "Workspace border strength",
    de: "Rahmenstärke",
  },
  "settings.workspace.innerGlow": {
    en: "Workspace inner glow",
    de: "Inneres Leuchten",
  },
  "settings.updates.title": {
    en: "Updates",
    de: "Updates",
  },
  "settings.updates.description": {
    en: "Check for Keiko updates and install them when available.",
    de: "Prüfe verfügbare Keiko-Updates und installiere sie bei Bedarf.",
  },
  "settings.updates.open": {
    en: "Review updates",
    de: "Updates prüfen",
  },
  "settings.security.placeholder": {
    en: "SSO · audit log · data residency - coming soon.",
    de: "SSO · Audit-Log · Datenresidenz - bald verfügbar.",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<Locale, string>>>>;

export type SettingsMessageKey = keyof typeof SETTINGS_MESSAGES;
export type I18nTranslate = (key: SettingsMessageKey, values?: MessageValues) => string;

function messageFor(locale: Locale, key: SettingsMessageKey): string {
  return SETTINGS_MESSAGES[key][locale] ?? SETTINGS_MESSAGES[key].en;
}

function interpolate(template: string, values: MessageValues = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function useSettingsTranslate(): I18nTranslate {
  const locale = useLocale();
  return useMemo<I18nTranslate>(() => {
    return (key, values) => interpolate(messageFor(locale, key), values);
  }, [locale]);
}
