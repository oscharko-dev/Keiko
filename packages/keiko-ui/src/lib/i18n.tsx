"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const I18N_STORAGE_KEY = "keiko.locale";

export const SUPPORTED_LOCALES = ["en", "de"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
};

const EN_MESSAGES = {
  "app.skipToContent": "Skip to content",
  "app.workspaceHeading": "Keiko workspace",
  "header.tileAll": "Tile all windows",
  "header.splitFront": "Split front windows",
  "header.cascade": "Cascade windows",
  "rail.primaryNavigation": "Primary workspace navigation",
  "rail.newChat": "New chat",
  "rail.chatHistory": "Chat History",
  "rail.memoria": "MemoriaViva",
  "rail.quality": "Quality Intelligence",
  "rail.promptEnhancer": "Prompt Enhancer",
  "rail.localKnowledge": "Local Knowledge",
  "rail.figma": "Figma Snapshot",
  "rail.lightMode": "Light mode",
  "rail.darkMode": "Dark mode",
  "rail.settings": "Settings",
  "common.optional": "optional",
  "common.loading": "Loading...",
  "common.cancel": "Cancel",
  "common.retry": "Retry",
  "common.dismissError": "Dismiss error",
  "common.status": "Status",
  "common.duration": "Duration",
  "common.confidence": "Confidence",
  "mode.group": "Agent mode",
  "mode.manual.title": "You approve every privileged action",
  "mode.manual.label": "You",
  "mode.autonomous.title": "Keiko governs agents per your policy",
  "chat.role.user": "You",
  "chat.keikoLogo": "Keiko logo",
  "chat.keikoResponding": "Keiko is responding",
  "chat.copy.unavailable": "Copy unavailable: the clipboard requires a secure (HTTPS) connection.",
  "chat.copy.copiedStatus": "Answer copied",
  "chat.copy.copied": "Copied",
  "chat.copy.message": "Copy answer",
  "chat.copy.short": "Copy",
  "chat.messageLabel": "Chat message",
  "chat.conversation": "Conversation",
  "chat.conversationReady": "Conversation ready",
  "chat.empty.headline": "How can I help you today?",
  "chat.empty.noChat.title": "Pick or start a chat",
  "chat.empty.noChat.hint":
    "Select a conversation from the project sidebar, or create a new one to get started.",
  "chat.hero.title": "What should we build?",
  "chat.hero.loadingWorkspace": "Loading local workspace...",
  "chat.hero.placeholder": "Describe a task, paste a link, or ask anything...",
  "chat.workLocally": "Work locally",
  "chat.composer.placeholder": "Ask Keiko...",
  "chat.composer.loading": "Loading...",
  "chat.model.menuTitle": "Models",
  "chat.model.title": "Model",
  "chat.model.loading": "Loading models...",
  "chat.model.noEligible": "No conversation-eligible model",
  "chat.model.change": "Change model",
  "chat.model.noneConfiguredTitle":
    "No conversation-eligible model is configured - connect a gateway in Settings",
  "chat.noModelAlert":
    "No conversation-eligible model is configured. Connect a gateway in Settings to enable chat.",
  "chat.loadingGateway": "Connecting to your gateway...",
  "chat.send.hint": "Type a message to send",
  "chat.send.label": "Send message",
  "chat.send.noModel": "No model available",
  "chat.send.contextTooLarge": "Context too large",
  "chat.send.connecting": "Connecting to gateway",
  "chat.send.cancel": "Cancel response",
  "chat.send.statusQueued": "Submitting your message…",
  "chat.send.statusContacting": "Contacting model…",
  "chat.send.statusStreaming": "Receiving response…",
  "chat.send.statusCancelled": "Response cancelled.",
  "chat.voice": "Voice",
  "chat.error.send": "Could not send message.",
  "chat.error.load": "Could not load chat.",
  "chat.error.scopeUpdate": "Unable to update knowledge scope.",
  "chat.error.memoryUpdate": "Unable to update memory.",
  "chat.grounding.label": "Grounding",
  "chat.grounding.mode": "Grounding mode",
  "chat.grounding.strategy": "Strategy",
  "chat.grounding.modelOnly": "Model only",
  "chat.grounding.liveFiles": "Live Files context",
  "chat.grounding.multiple": "Multiple sources",
  "chat.grounding.disconnectConfirm":
    "This will disconnect {count} grounding {sourceLabel}. Continue?",
  "chat.grounding.sourceSingular": "source",
  "chat.grounding.sourcePlural": "sources",
  "chat.grounding.capsule": "Knowledge capsule: {name}",
  "chat.grounding.capsuleSet": "Capsule set: {name}",
  "chat.grounding.unavailable": "{label} (unavailable)",
  "chat.memory.panel": "Conversation memory",
  "chat.memory.budget": "MemoriaViva budget",
  "chat.memory.budgetStepper": "MemoriaViva budget",
  "chat.memory.enable": "Enable MemoriaViva for the next request",
  "chat.memory.stateOn": "MemoriaViva on",
  "chat.memory.stateOff": "MemoriaViva off",
  "chat.memory.included": "{count} memories included",
  "chat.memory.noneIncluded": "No memories included",
  "chat.memory.disclosurePending": "MemoriaViva disclosure appears after the next response.",
  "chat.memory.usedTokens": "Used {used} of {tokens} MemoriaViva tokens.",
  "chat.memory.disabledLast": "MemoriaViva was disabled for the last request.",
  "chat.memory.provenance": "Provenance for {id}",
  "chat.memory.source": "Source",
  "chat.memory.sensitivity": "Sensitivity",
  "chat.memory.status": "Status",
  "chat.memory.confidence": "Confidence",
  "chat.memory.captured": "Captured",
  "chat.memory.approvalRequired": "Approval required",
  "chat.memory.proposedMemory": "Proposed memory",
  "chat.memory.accept": "Accept",
  "chat.memory.reject": "Reject",
  "chat.memory.accepted": "MemoriaViva proposal accepted.",
  "chat.memory.rejected": "MemoriaViva proposal rejected.",
  "chat.memory.acceptError": "Unable to accept memory.",
  "chat.memory.rejectError": "Unable to reject memory.",
  "chat.memory.updateDetected": "MemoriaViva update detected",
  "chat.memory.suggestedUpdate": "Suggested update: {body}",
  "chat.memory.suggestedUpdateFallback": "Suggested update.",
  "chat.memory.forgetDetected": "MemoriaViva forget detected",
  "chat.memory.confirmationRequired": "Confirmation required",
  "chat.memory.forgetMatched": "Matched memory {id} for a forget operation.",
  "chat.memory.forget": "Forget",
  "chat.memory.reviewForget": "Review forget",
  "chat.memory.forgetPermanently": "Forget permanently",
  "chat.memory.forgetCompleted": "MemoriaViva forget action completed.",
  "chat.memory.forgetError": "Unable to forget memory.",
  "chat.memory.proposalDeclined": "Memory proposal declined",
  "chat.memory.noReason": "No reason provided",
  "chat.memory.actionNotCreated": "MemoriaViva action not created",
  "chat.grounded.cancel": "Cancel grounded request",
  "attachment.rejection.textOnly":
    "The selected model can't accept this attachment type. Choose a model that supports images or documents.",
  "attachment.rejection.unsupported":
    "Unsupported file type{mime}. Supported types: images (image/*), PDF, plain text, markdown, JSON, YAML.",
  "attachment.rejection.oversized":
    "File is larger than the 8 MiB limit. Choose a smaller file or summarize the content as text.",
  "attachment.rejection.empty": "Empty file. Add a file with content to attach.",
  "attachment.remove": "Remove attachment {name}",
  "attachment.pending": "Pending attachments",
  "attachment.drop": "Drop files here to attach",
  "attachment.disabledDifferentModel":
    "The selected model does not support image or document input. Choose a different model to attach files.",
  "attachment.disabledNoModel":
    "The selected model does not support image or document input. No configured model currently supports attachments.",
  "attachment.attachFile": "Attach file",
  "attachment.notSupported": "Attachments not supported",
  "attachment.docsContext": "Documents included as context",
  "attachment.docContextLabel": "Document included as context:",
  "attachment.docsContextLabel": "Documents included as context:",
  "attachment.truncated": " (truncated)",
  "attachment.truncatedHint": "Some document text was truncated to fit the context limit.",
  "footer.status": "Workspace status",
  "footer.version": "Keiko version {version}",
  "footer.versionLoading": "version loading",
  "footer.versionUnavailable": "version unavailable",
  "footer.windowSingular": "{count} window",
  "footer.windowPlural": "{count} windows",
  "footer.openWindows": "Open windows",
  "footer.minimized": "Minimized",
  "footer.fullscreen": "Fullscreen",
  "footer.visible": "Visible",
  "footer.restore": "Restore",
  "footer.focus": "Focus",
  "footer.windowAction": "{action} {title} window{suffix}",
  "scope.pressure.low": "Low",
  "scope.pressure.moderate": "Moderate",
  "scope.pressure.high": "High",
  "scope.pressure.exceeded": "Exceeded",
  "scope.budgetSummary": "Last grounded run: {tokens} tokens, {files} files",
  "scope.connectedFolder": "Connected folder",
  "scope.folder": "Folder: {name}",
  "scope.repository": "Repository scope",
  "scope.connectedFile": "Connected file",
  "scope.file": "File: {name}",
  "scope.filesConnected": "{count} files connected",
  "scope.boundary.repository":
    "Keiko may inspect only the connected repository; safe-read exclusions and context budget limits apply before each answer.",
  "scope.boundary.folder":
    "Keiko may inspect only the connected folder; safe-read exclusions and context budget limits apply before each answer.",
  "scope.boundary.file":
    "Keiko may inspect only the connected file scope; safe-read exclusions and context budget limits apply before each answer.",
  "scope.disconnect": "Disconnect {label} from chat",
  "scope.disconnectWithPath": "Disconnect {label} from chat ({path})",
  "scope.disconnectError": "Unable to disconnect scope.",
  "settings.title": "Settings",
  "settings.selfHosted": "Self-hosted",
  "settings.selfHostedTitle": "Runs inside your network",
  "settings.tabs.models": "Models",
  "settings.tabs.general": "General",
  "settings.tabs.security": "Security",
  "settings.language.title": "Language",
  "settings.language.description": "Choose the language used by the Keiko browser interface.",
  "settings.language.label": "Interface language",
  "settings.language.compactLabel": "Language",
  "settings.language.help": "Saved on this device and applied immediately.",
  "settings.wallpaper.title": "Workspace wallpaper",
  "settings.wallpaper.description":
    "Liquid Chrome - a subtle metallic flow behind the grid that reacts to your cursor and clicks. Turn it off to stop the WebGL animation completely.",
  "settings.wallpaper.toggle": "Liquid wallpaper",
  "settings.wallpaper.running": "Running",
  "settings.wallpaper.stopped": "Stopped",
  "settings.wallpaper.opacity": "Wallpaper opacity",
  "settings.scale.off": "Off",
  "settings.scale.full": "Full",
  "settings.scale.base": "Base",
  "settings.scale.lighter": "Lighter",
  "settings.scale.subtle": "Subtle",
  "settings.scale.strong": "Strong",
  "settings.workspace.backgroundBrightness": "Workspace background brightness",
  "settings.workspace.gridStrength": "Workspace grid strength",
  "settings.workspace.borderStrength": "Workspace border strength",
  "settings.workspace.innerGlow": "Workspace inner glow",
  "settings.models.gatewayTitle": "Model gateway",
  "settings.models.gatewayDescription":
    "Credentials are stored locally by the Keiko loopback server; secrets are never returned to the browser.",
  "settings.models.updateCredentials": "Update credentials",
  "settings.models.connectGateway": "Connect gateway",
  "settings.models.setupRequired": "Gateway setup required",
  "settings.models.connected": "Gateway connected",
  "settings.models.configured": "Gateway configured",
  "settings.models.detailSetup":
    "Enter the gateway base URL and API token before using chat or agent workflows.",
  "settings.models.detailNoModels":
    "The gateway is configured, but no conversation-capable models are currently available.",
  "settings.models.detailNoChat":
    "Gateway connected, but none of the discovered models can be used for conversation. Add a chat-capable deployment.",
  "settings.models.detailReady":
    "Keiko can use the configured gateway models for chat and agent workflows.",
  "settings.models.modelCount": "{count} models",
  "settings.models.chatCount": "{count} chat",
  "settings.models.statusConfigured": "gateway configured",
  "settings.models.statusSetupRequired": "setup required",
  "settings.models.statusConversationEligible": "conversation-eligible",
  "settings.models.statusEmbedding": "available for embeddings",
  "settings.models.statusNotSelectable": "not selectable for conversation",
  "settings.models.loadError":
    "Could not load gateway settings - the local Keiko backend did not respond.",
  "settings.models.retry": "Retry",
  "settings.models.loading": "Loading gateway models...",
  "settings.models.emptyConfigured":
    "No conversation-capable models are currently available. Review the gateway configuration or discovered model set.",
  "settings.models.emptyUnconfigured":
    "No models are configured yet. Connect the gateway to load configured model capabilities.",
  "settings.models.eligibilityOk": "Conversation-eligible",
  "settings.models.eligibilityOkAria": "Model eligibility: eligible for conversation",
  "settings.models.eligibilityPrefix": "Model eligibility: {label}",
  "settings.models.embeddingLabel": "Embedding-ready",
  "settings.models.embeddingAvailable":
    "Available for embeddings; not shown in the chat model picker",
  "settings.models.ineligibleEmbedding": "Embedding model - not selectable for text conversation",
  "settings.models.ineligibleOcr": "OCR/vision-only - not selectable for text conversation",
  "settings.models.ineligibleGeneric": "Not a chat model - not selectable for text conversation",
  "settings.models.ineligibleShortOcr": "OCR/vision-only",
  "settings.models.ineligibleShortGeneric": "not a chat model",
  "settings.models.notSelectable": "Not selectable - {reason}",
  "settings.models.voiceProviderAvailable":
    "Voice provider - available for {capabilities}{personas}",
  "settings.models.voiceProviderBadge": "Voice provider - {label}",
  "settings.models.voiceCapabilitySpeechToText": "speech-to-text",
  "settings.models.voiceCapabilitySpeechOutput": "speech output",
  "settings.models.voiceCapabilityRealtimeDialogue": "realtime dialogue",
  "settings.models.voiceCapabilityVoice": "voice",
  "settings.models.voicePersonas": "; voices: {personas}",
  "settings.models.readinessError":
    "Readiness check failed. The gateway configuration was not changed.",
  "settings.models.copyReport": "Copy report",
  "settings.models.copied": "Copied",
  "settings.models.reportCopied": "Readiness report copied.",
  "settings.models.reportCopyFailed":
    "Clipboard access failed. Select and copy the report details manually.",
  "settings.models.checkingReadiness": "Checking {mode} readiness...",
  "settings.models.readinessModeDeep": "deep",
  "settings.models.readinessModeBasic": "basic",
  "settings.models.workingToday": "Working today",
  "settings.models.notVerified": "Not verified",
  "settings.models.verifiedCapabilities": "Verified capabilities",
  "settings.models.capabilityStreaming": "Streaming",
  "settings.models.capabilityTools": "Tools",
  "settings.models.capabilityJson": "JSON",
  "settings.models.capabilityReasoning": "Reasoning",
  "settings.models.capabilityImage": "Image",
  "settings.models.capabilityPdf": "PDF",
  "settings.models.contextTokensShort": "{count} ctx",
  "settings.models.runReadiness": "Run readiness check",
  "settings.models.deepProbes": "Deep probes",
  "settings.models.capabilitySummary":
    "tools {tools} · structured {structured} · {costClass}/{latencyClass}",
  "settings.models.yes": "yes",
  "settings.models.no": "no",
  "settings.security.placeholder": "SSO · audit log · data residency - coming soon.",
} as const;

const DE_MESSAGES: Record<MessageKey, string> = {
  "app.skipToContent": "Zum Inhalt springen",
  "app.workspaceHeading": "Keiko-Arbeitsbereich",
  "header.tileAll": "Alle Fenster kacheln",
  "header.splitFront": "Vordere Fenster teilen",
  "header.cascade": "Fenster stapeln",
  "rail.primaryNavigation": "Primaere Arbeitsbereichsnavigation",
  "rail.newChat": "Neuer Chat",
  "rail.chatHistory": "Chatverlauf",
  "rail.memoria": "MemoriaViva",
  "rail.quality": "Quality Intelligence",
  "rail.promptEnhancer": "Prompt Enhancer",
  "rail.localKnowledge": "Lokales Wissen",
  "rail.figma": "Figma-Snapshot",
  "rail.lightMode": "Heller Modus",
  "rail.darkMode": "Dunkler Modus",
  "rail.settings": "Einstellungen",
  "common.optional": "optional",
  "common.loading": "Laedt...",
  "common.cancel": "Abbrechen",
  "common.retry": "Erneut versuchen",
  "common.dismissError": "Fehler ausblenden",
  "common.status": "Status",
  "common.duration": "Dauer",
  "common.confidence": "Konfidenz",
  "mode.group": "Agentenmodus",
  "mode.manual.title": "Du bestaetigst jede privilegierte Aktion",
  "mode.manual.label": "Du",
  "mode.autonomous.title": "Keiko steuert Agenten nach deiner Richtlinie",
  "chat.role.user": "Du",
  "chat.keikoLogo": "Keiko-Logo",
  "chat.keikoResponding": "Keiko antwortet",
  "chat.copy.unavailable":
    "Kopieren nicht verfuegbar: Die Zwischenablage erfordert eine sichere HTTPS-Verbindung.",
  "chat.copy.copiedStatus": "Antwort kopiert",
  "chat.copy.copied": "Kopiert",
  "chat.copy.message": "Antwort kopieren",
  "chat.copy.short": "Kopieren",
  "chat.messageLabel": "Chatnachricht",
  "chat.conversation": "Konversation",
  "chat.conversationReady": "Konversation bereit",
  "chat.empty.headline": "Wie kann ich dir heute helfen?",
  "chat.empty.noChat.title": "Chat auswaehlen oder starten",
  "chat.empty.noChat.hint":
    "Waehle eine Konversation aus der Projekt-Seitenleiste oder erstelle eine neue.",
  "chat.hero.title": "Was sollen wir bauen?",
  "chat.hero.loadingWorkspace": "Lokaler Arbeitsbereich wird geladen...",
  "chat.hero.placeholder": "Beschreibe eine Aufgabe, fuege einen Link ein oder frag etwas...",
  "chat.workLocally": "Lokal arbeiten",
  "chat.composer.placeholder": "Frag Keiko...",
  "chat.composer.loading": "Laedt...",
  "chat.model.menuTitle": "Modelle",
  "chat.model.title": "Modell",
  "chat.model.loading": "Modelle werden geladen...",
  "chat.model.noEligible": "Kein dialogfaehiges Modell",
  "chat.model.change": "Modell wechseln",
  "chat.model.noneConfiguredTitle":
    "Kein dialogfaehiges Modell ist konfiguriert - verbinde ein Gateway in den Einstellungen",
  "chat.noModelAlert":
    "Kein dialogfaehiges Modell ist konfiguriert. Verbinde ein Gateway in den Einstellungen, um Chat zu aktivieren.",
  "chat.loadingGateway": "Verbindung zum Gateway wird hergestellt...",
  "chat.send.hint": "Gib eine Nachricht ein, um sie zu senden",
  "chat.send.label": "Nachricht senden",
  "chat.send.noModel": "Kein Modell verfuegbar",
  "chat.send.contextTooLarge": "Kontext zu gross",
  "chat.send.connecting": "Gateway wird verbunden",
  "chat.send.cancel": "Antwort abbrechen",
  "chat.send.statusQueued": "Nachricht wird gesendet...",
  "chat.send.statusContacting": "Modell wird kontaktiert...",
  "chat.send.statusStreaming": "Antwort wird empfangen...",
  "chat.send.statusCancelled": "Antwort abgebrochen.",
  "chat.voice": "Spracheingabe",
  "chat.error.send": "Nachricht konnte nicht gesendet werden.",
  "chat.error.load": "Chat konnte nicht geladen werden.",
  "chat.error.scopeUpdate": "Wissensbereich konnte nicht aktualisiert werden.",
  "chat.error.memoryUpdate": "Speicher konnte nicht aktualisiert werden.",
  "chat.grounding.label": "Grounding",
  "chat.grounding.mode": "Grounding-Modus",
  "chat.grounding.strategy": "Strategie",
  "chat.grounding.modelOnly": "Nur Modell",
  "chat.grounding.liveFiles": "Live-Dateikontext",
  "chat.grounding.multiple": "Mehrere Quellen",
  "chat.grounding.disconnectConfirm":
    "Dadurch werden {count} Grounding-{sourceLabel} getrennt. Fortfahren?",
  "chat.grounding.sourceSingular": "Quelle",
  "chat.grounding.sourcePlural": "Quellen",
  "chat.grounding.capsule": "Wissenskapsel: {name}",
  "chat.grounding.capsuleSet": "Kapselset: {name}",
  "chat.grounding.unavailable": "{label} (nicht verfuegbar)",
  "chat.memory.panel": "Konversationsspeicher",
  "chat.memory.budget": "MemoriaViva-Budget",
  "chat.memory.budgetStepper": "MemoriaViva-Budget",
  "chat.memory.enable": "MemoriaViva fuer die naechste Anfrage aktivieren",
  "chat.memory.stateOn": "MemoriaViva an",
  "chat.memory.stateOff": "MemoriaViva aus",
  "chat.memory.included": "{count} Erinnerungen einbezogen",
  "chat.memory.noneIncluded": "Keine Erinnerungen einbezogen",
  "chat.memory.disclosurePending": "MemoriaViva-Hinweis erscheint nach der naechsten Antwort.",
  "chat.memory.usedTokens": "{used} von {tokens} MemoriaViva-Token verwendet.",
  "chat.memory.disabledLast": "MemoriaViva war fuer die letzte Anfrage deaktiviert.",
  "chat.memory.provenance": "Herkunft fuer {id}",
  "chat.memory.source": "Quelle",
  "chat.memory.sensitivity": "Sensitivitaet",
  "chat.memory.status": "Status",
  "chat.memory.confidence": "Konfidenz",
  "chat.memory.captured": "Erfasst",
  "chat.memory.approvalRequired": "Bestaetigung erforderlich",
  "chat.memory.proposedMemory": "Vorgeschlagene Erinnerung",
  "chat.memory.accept": "Akzeptieren",
  "chat.memory.reject": "Ablehnen",
  "chat.memory.accepted": "MemoriaViva-Vorschlag akzeptiert.",
  "chat.memory.rejected": "MemoriaViva-Vorschlag abgelehnt.",
  "chat.memory.acceptError": "Erinnerung konnte nicht akzeptiert werden.",
  "chat.memory.rejectError": "Erinnerung konnte nicht abgelehnt werden.",
  "chat.memory.updateDetected": "MemoriaViva-Aktualisierung erkannt",
  "chat.memory.suggestedUpdate": "Vorgeschlagene Aktualisierung: {body}",
  "chat.memory.suggestedUpdateFallback": "Vorgeschlagene Aktualisierung.",
  "chat.memory.forgetDetected": "MemoriaViva-Vergessen erkannt",
  "chat.memory.confirmationRequired": "Bestaetigung erforderlich",
  "chat.memory.forgetMatched": "Erinnerung {id} fuer eine Vergessen-Aktion gefunden.",
  "chat.memory.forget": "Vergessen",
  "chat.memory.reviewForget": "Vergessen pruefen",
  "chat.memory.forgetPermanently": "Dauerhaft vergessen",
  "chat.memory.forgetCompleted": "MemoriaViva-Vergessen abgeschlossen.",
  "chat.memory.forgetError": "Erinnerung konnte nicht vergessen werden.",
  "chat.memory.proposalDeclined": "Speichervorschlag abgelehnt",
  "chat.memory.noReason": "Kein Grund angegeben",
  "chat.memory.actionNotCreated": "MemoriaViva-Aktion nicht erstellt",
  "chat.grounded.cancel": "Grounded-Anfrage abbrechen",
  "attachment.rejection.textOnly":
    "Das ausgewaehlte Modell kann diesen Anhangstyp nicht verarbeiten. Waehle ein Modell mit Bild- oder Dokumentunterstuetzung.",
  "attachment.rejection.unsupported":
    "Nicht unterstuetzter Dateityp{mime}. Unterstuetzte Typen: Bilder (image/*), PDF, Klartext, Markdown, JSON, YAML.",
  "attachment.rejection.oversized":
    "Die Datei ist groesser als das Limit von 8 MiB. Waehle eine kleinere Datei oder fasse den Inhalt als Text zusammen.",
  "attachment.rejection.empty": "Leere Datei. Fuege eine Datei mit Inhalt hinzu.",
  "attachment.remove": "Anhang {name} entfernen",
  "attachment.pending": "Ausstehende Anhaenge",
  "attachment.drop": "Dateien hier ablegen, um sie anzufuegen",
  "attachment.disabledDifferentModel":
    "Das ausgewaehlte Modell unterstuetzt keine Bild- oder Dokumenteingabe. Waehle ein anderes Modell, um Dateien anzufuegen.",
  "attachment.disabledNoModel":
    "Das ausgewaehlte Modell unterstuetzt keine Bild- oder Dokumenteingabe. Kein konfiguriertes Modell unterstuetzt aktuell Anhaenge.",
  "attachment.attachFile": "Datei anfuegen",
  "attachment.notSupported": "Anhaenge nicht unterstuetzt",
  "attachment.docsContext": "Dokumente als Kontext einbezogen",
  "attachment.docContextLabel": "Dokument als Kontext einbezogen:",
  "attachment.docsContextLabel": "Dokumente als Kontext einbezogen:",
  "attachment.truncated": " (gekuerzt)",
  "attachment.truncatedHint":
    "Ein Teil des Dokumenttexts wurde gekuerzt, damit er ins Kontextlimit passt.",
  "footer.status": "Arbeitsbereich-Status",
  "footer.version": "Keiko-Version {version}",
  "footer.versionLoading": "Version wird geladen",
  "footer.versionUnavailable": "Version nicht verfuegbar",
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
  "scope.pressure.exceeded": "Ueberschritten",
  "scope.budgetSummary": "Letzter Grounding-Lauf: {tokens} Token, {files} Dateien",
  "scope.connectedFolder": "Verbundener Ordner",
  "scope.folder": "Ordner: {name}",
  "scope.repository": "Repository-Bereich",
  "scope.connectedFile": "Verbundene Datei",
  "scope.file": "Datei: {name}",
  "scope.filesConnected": "{count} Dateien verbunden",
  "scope.boundary.repository":
    "Keiko darf nur das verbundene Repository pruefen; Safe-Read-Ausschluesse und Kontextbudget-Limits gelten vor jeder Antwort.",
  "scope.boundary.folder":
    "Keiko darf nur den verbundenen Ordner pruefen; Safe-Read-Ausschluesse und Kontextbudget-Limits gelten vor jeder Antwort.",
  "scope.boundary.file":
    "Keiko darf nur den verbundenen Dateibereich pruefen; Safe-Read-Ausschluesse und Kontextbudget-Limits gelten vor jeder Antwort.",
  "scope.disconnect": "{label} vom Chat trennen",
  "scope.disconnectWithPath": "{label} vom Chat trennen ({path})",
  "scope.disconnectError": "Bereich konnte nicht getrennt werden.",
  "settings.title": "Einstellungen",
  "settings.selfHosted": "Self-hosted",
  "settings.selfHostedTitle": "Laeuft in deinem Netzwerk",
  "settings.tabs.models": "Modelle",
  "settings.tabs.general": "Allgemein",
  "settings.tabs.security": "Sicherheit",
  "settings.language.title": "Sprache",
  "settings.language.description": "Waehle die Sprache fuer die Keiko-Browseroberflaeche.",
  "settings.language.label": "Oberflaechensprache",
  "settings.language.compactLabel": "Sprache",
  "settings.language.help": "Wird auf diesem Geraet gespeichert und sofort angewendet.",
  "settings.wallpaper.title": "Arbeitsbereich-Hintergrund",
  "settings.wallpaper.description":
    "Liquid Chrome - ein dezenter metallischer Verlauf hinter dem Raster, der auf Cursor und Klicks reagiert. Schalte ihn aus, um die WebGL-Animation vollstaendig zu stoppen.",
  "settings.wallpaper.toggle": "Liquid-Hintergrund",
  "settings.wallpaper.running": "Aktiv",
  "settings.wallpaper.stopped": "Gestoppt",
  "settings.wallpaper.opacity": "Hintergrund-Deckkraft",
  "settings.scale.off": "Aus",
  "settings.scale.full": "Voll",
  "settings.scale.base": "Basis",
  "settings.scale.lighter": "Heller",
  "settings.scale.subtle": "Dezent",
  "settings.scale.strong": "Stark",
  "settings.workspace.backgroundBrightness": "Arbeitsbereich-Helligkeit",
  "settings.workspace.gridStrength": "Rasterstaerke",
  "settings.workspace.borderStrength": "Rahmenstaerke",
  "settings.workspace.innerGlow": "Inneres Leuchten",
  "settings.models.gatewayTitle": "Modell-Gateway",
  "settings.models.gatewayDescription":
    "Zugangsdaten werden lokal vom Keiko-Loopback-Server gespeichert; Secrets werden nie an den Browser zurueckgegeben.",
  "settings.models.updateCredentials": "Zugangsdaten aktualisieren",
  "settings.models.connectGateway": "Gateway verbinden",
  "settings.models.setupRequired": "Gateway-Einrichtung erforderlich",
  "settings.models.connected": "Gateway verbunden",
  "settings.models.configured": "Gateway konfiguriert",
  "settings.models.detailSetup":
    "Gib Gateway-Basis-URL und API-Token ein, bevor du Chat- oder Agent-Workflows nutzt.",
  "settings.models.detailNoModels":
    "Das Gateway ist konfiguriert, aber aktuell sind keine dialogfaehigen Modelle verfuegbar.",
  "settings.models.detailNoChat":
    "Gateway verbunden, aber keines der gefundenen Modelle kann fuer Konversationen genutzt werden. Fuege ein chatfaehiges Deployment hinzu.",
  "settings.models.detailReady":
    "Keiko kann die konfigurierten Gateway-Modelle fuer Chat- und Agent-Workflows nutzen.",
  "settings.models.modelCount": "{count} Modelle",
  "settings.models.chatCount": "{count} Chat",
  "settings.models.statusConfigured": "Gateway konfiguriert",
  "settings.models.statusSetupRequired": "Einrichtung erforderlich",
  "settings.models.statusConversationEligible": "konversationsfaehig",
  "settings.models.statusEmbedding": "fuer Embeddings verfuegbar",
  "settings.models.statusNotSelectable": "nicht fuer Konversationen auswaehlbar",
  "settings.models.loadError":
    "Gateway-Einstellungen konnten nicht geladen werden - das lokale Keiko-Backend hat nicht geantwortet.",
  "settings.models.retry": "Erneut versuchen",
  "settings.models.loading": "Gateway-Modelle werden geladen...",
  "settings.models.emptyConfigured":
    "Aktuell sind keine dialogfaehigen Modelle verfuegbar. Pruefe die Gateway-Konfiguration oder die gefundenen Modelle.",
  "settings.models.emptyUnconfigured":
    "Noch sind keine Modelle konfiguriert. Verbinde das Gateway, um konfigurierte Modellfaehigkeiten zu laden.",
  "settings.models.eligibilityOk": "Konversationsfaehig",
  "settings.models.eligibilityOkAria": "Modelleignung: fuer Konversationen geeignet",
  "settings.models.eligibilityPrefix": "Modelleignung: {label}",
  "settings.models.embeddingLabel": "Embedding-bereit",
  "settings.models.embeddingAvailable":
    "Fuer Embeddings verfuegbar; nicht in der Chat-Modellauswahl sichtbar",
  "settings.models.ineligibleEmbedding":
    "Embedding-Modell - nicht fuer Textkonversationen auswaehlbar",
  "settings.models.ineligibleOcr": "Nur OCR/Vision - nicht fuer Textkonversationen auswaehlbar",
  "settings.models.ineligibleGeneric":
    "Kein Chat-Modell - nicht fuer Textkonversationen auswaehlbar",
  "settings.models.ineligibleShortOcr": "nur OCR/Vision",
  "settings.models.ineligibleShortGeneric": "kein Chat-Modell",
  "settings.models.notSelectable": "Nicht auswaehlbar - {reason}",
  "settings.models.voiceProviderAvailable":
    "Sprachanbieter - verfuegbar fuer {capabilities}{personas}",
  "settings.models.voiceProviderBadge": "Sprachanbieter - {label}",
  "settings.models.voiceCapabilitySpeechToText": "Speech-to-Text",
  "settings.models.voiceCapabilitySpeechOutput": "Sprachausgabe",
  "settings.models.voiceCapabilityRealtimeDialogue": "Echtzeitdialog",
  "settings.models.voiceCapabilityVoice": "Sprache",
  "settings.models.voicePersonas": "; Stimmen: {personas}",
  "settings.models.readinessError":
    "Bereitschaftspruefung fehlgeschlagen. Die Gateway-Konfiguration wurde nicht geaendert.",
  "settings.models.copyReport": "Bericht kopieren",
  "settings.models.copied": "Kopiert",
  "settings.models.reportCopied": "Bereitschaftsbericht kopiert.",
  "settings.models.reportCopyFailed":
    "Zugriff auf die Zwischenablage fehlgeschlagen. Waehle die Berichtdetails aus und kopiere sie manuell.",
  "settings.models.checkingReadiness": "Bereitschaftspruefung laeuft ({mode})...",
  "settings.models.readinessModeDeep": "tief",
  "settings.models.readinessModeBasic": "einfach",
  "settings.models.workingToday": "Heute funktionsfaehig",
  "settings.models.notVerified": "Nicht verifiziert",
  "settings.models.verifiedCapabilities": "Verifizierte Faehigkeiten",
  "settings.models.capabilityStreaming": "Streaming",
  "settings.models.capabilityTools": "Tools",
  "settings.models.capabilityJson": "JSON",
  "settings.models.capabilityReasoning": "Reasoning",
  "settings.models.capabilityImage": "Bild",
  "settings.models.capabilityPdf": "PDF",
  "settings.models.contextTokensShort": "{count} ctx",
  "settings.models.runReadiness": "Bereitschaft pruefen",
  "settings.models.deepProbes": "Tiefe Pruefungen",
  "settings.models.capabilitySummary":
    "Tools {tools} · strukturiert {structured} · {costClass}/{latencyClass}",
  "settings.models.yes": "ja",
  "settings.models.no": "nein",
  "settings.security.placeholder": "SSO · Audit-Log · Datenresidenz - bald verfuegbar.",
};

const MESSAGES: Record<Locale, Record<MessageKey, string>> = {
  en: EN_MESSAGES,
  de: DE_MESSAGES,
};

export type MessageKey = keyof typeof EN_MESSAGES;

export type MessageValues = Readonly<Record<string, string | number>>;
export type I18nTranslate = (key: MessageKey, values?: MessageValues) => string;

export function resolveLocale(input: string | null | undefined): Locale {
  if (input === null || input === undefined) return DEFAULT_LOCALE;
  const normalized = input.trim().toLowerCase().replace(/_/gu, "-");
  if (normalized.length === 0) return DEFAULT_LOCALE;
  if (normalized === "de" || normalized.startsWith("de-")) return "de";
  return DEFAULT_LOCALE;
}

export function translate(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  const template = MESSAGES[locale][key] ?? EN_MESSAGES[key];
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    return resolveLocale(window.localStorage.getItem(I18N_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

function persistLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(I18N_STORAGE_KEY, locale);
  } catch {
    /* ignore quota / private mode */
  }
}

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
}

interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: I18nTranslate;
}

const FALLBACK_CONTEXT: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  t: (key, values) => translate(DEFAULT_LOCALE, key, values),
};

const I18nContext = createContext<I18nContextValue>(FALLBACK_CONTEXT);

export function I18nProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

  useEffect(() => {
    applyDocumentLocale(locale);
    persistLocale(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale): void => {
    setLocaleState(next);
  }, []);

  const t = useCallback(
    (key: MessageKey, values?: MessageValues): string => translate(locale, key, values),
    [locale],
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
