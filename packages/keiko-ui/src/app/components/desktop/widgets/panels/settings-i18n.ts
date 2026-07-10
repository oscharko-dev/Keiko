"use client";

import { useMemo } from "react";
import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

const SETTINGS_EN_MESSAGES = {
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
  "settings.selfHosted": "Self-hosted",
  "settings.selfHostedTitle": "Runs inside your network",
  "settings.tabs.models": "Models",
  "settings.tabs.general": "General",
  "settings.tabs.security": "Security",
  "settings.language.title": "Language",
  "settings.language.description": "Choose the language used by the Keiko browser interface.",
  "settings.language.label": "Interface language",
  "settings.language.help": "Saved on this device and applied immediately.",
  "settings.voice.title": "Assistant voice",
  "settings.voice.description": "Choose the voice used by Voice Dialogue.",
  "settings.voice.label": "Voice",
  "settings.voice.help": "Saved on this device and used the next time Voice Dialogue speaks.",
  "settings.voice.unavailable":
    "Voice choices become available after a configured voice provider exposes speech output.",
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
  "settings.workspace.cameraAnimation": "Workspace camera smoothness",
  "settings.workspace.cameraAnimationMinimal": "Minimal",
  "settings.workspace.cameraAnimationSmooth": "Smooth",
  "settings.workspace.cameraAnimationHelp":
    "Move right to make pan and zoom transitions softer. Minimal applies changes immediately.",
  "settings.workspace.borderStrength": "Workspace border strength",
  "settings.workspace.innerGlow": "Workspace inner glow",
  "settings.updates.title": "Updates",
  "settings.updates.description": "Check for Keiko updates and install them when available.",
  "settings.updates.open": "Review updates",
  "settings.security.placeholder": "SSO · audit log · data residency - coming soon.",
} as const;

const SETTINGS_DE_MESSAGES: SettingsMessageCatalog = {
  "settings.models.gatewayTitle": "Modell-Gateway",
  "settings.models.gatewayDescription":
    "Zugangsdaten werden lokal vom Keiko-Loopback-Server gespeichert; Secrets werden nie an den Browser zurückgegeben.",
  "settings.models.updateCredentials": "Zugangsdaten aktualisieren",
  "settings.models.connectGateway": "Gateway verbinden",
  "settings.models.setupRequired": "Gateway-Einrichtung erforderlich",
  "settings.models.connected": "Gateway verbunden",
  "settings.models.configured": "Gateway konfiguriert",
  "settings.models.detailSetup":
    "Gib Gateway-Basis-URL und API-Token ein, bevor du Chat- oder Agent-Workflows nutzt.",
  "settings.models.detailNoModels":
    "Das Gateway ist konfiguriert, aber aktuell sind keine dialogfähigen Modelle verfügbar.",
  "settings.models.detailNoChat":
    "Gateway verbunden, aber keines der gefundenen Modelle kann für Konversationen genutzt werden. Füge ein chatfähiges Deployment hinzu.",
  "settings.models.detailReady":
    "Keiko kann die konfigurierten Gateway-Modelle für Chat- und Agent-Workflows nutzen.",
  "settings.models.modelCount": "{count} Modelle",
  "settings.models.chatCount": "{count} Chat",
  "settings.models.statusConfigured": "Gateway konfiguriert",
  "settings.models.statusSetupRequired": "Einrichtung erforderlich",
  "settings.models.statusConversationEligible": "konversationsfähig",
  "settings.models.statusEmbedding": "für Embeddings verfügbar",
  "settings.models.statusNotSelectable": "nicht für Konversationen auswählbar",
  "settings.models.loadError":
    "Gateway-Einstellungen konnten nicht geladen werden - das lokale Keiko-Backend hat nicht geantwortet.",
  "settings.models.retry": "Erneut versuchen",
  "settings.models.loading": "Gateway-Modelle werden geladen…",
  "settings.models.emptyConfigured":
    "Aktuell sind keine dialogfähigen Modelle verfügbar. Prüfe die Gateway-Konfiguration oder die gefundenen Modelle.",
  "settings.models.emptyUnconfigured":
    "Noch sind keine Modelle konfiguriert. Verbinde das Gateway, um konfigurierte Modellfähigkeiten zu laden.",
  "settings.models.eligibilityOk": "Konversationsfähig",
  "settings.models.eligibilityOkAria": "Modelleignung: für Konversationen geeignet",
  "settings.models.eligibilityPrefix": "Modelleignung: {label}",
  "settings.models.embeddingLabel": "Embedding-bereit",
  "settings.models.embeddingAvailable":
    "Für Embeddings verfügbar; nicht in der Chat-Modellauswahl sichtbar",
  "settings.models.ineligibleEmbedding":
    "Embedding-Modell - nicht für Textkonversationen auswählbar",
  "settings.models.ineligibleOcr": "Nur OCR/Vision - nicht für Textkonversationen auswählbar",
  "settings.models.ineligibleGeneric": "Kein Chat-Modell - nicht für Textkonversationen auswählbar",
  "settings.models.ineligibleShortOcr": "nur OCR/Vision",
  "settings.models.ineligibleShortGeneric": "kein Chat-Modell",
  "settings.models.notSelectable": "Nicht auswählbar - {reason}",
  "settings.models.voiceProviderAvailable":
    "Sprachanbieter - verfügbar für {capabilities}{personas}",
  "settings.models.voiceProviderBadge": "Sprachanbieter - {label}",
  "settings.models.voiceCapabilitySpeechToText": "Speech-to-Text",
  "settings.models.voiceCapabilitySpeechOutput": "Sprachausgabe",
  "settings.models.voiceCapabilityRealtimeDialogue": "Echtzeitdialog",
  "settings.models.voiceCapabilityVoice": "Sprache",
  "settings.models.voicePersonas": "; Stimmen: {personas}",
  "settings.models.readinessError":
    "Bereitschaftsprüfung fehlgeschlagen. Die Gateway-Konfiguration wurde nicht geändert.",
  "settings.models.copyReport": "Bericht kopieren",
  "settings.models.copied": "Kopiert",
  "settings.models.reportCopied": "Bereitschaftsbericht kopiert.",
  "settings.models.reportCopyFailed":
    "Zugriff auf die Zwischenablage fehlgeschlagen. Wähle die Berichtdetails aus und kopiere sie manuell.",
  "settings.models.checkingReadiness": "Bereitschaftsprüfung läuft ({mode})…",
  "settings.models.readinessModeDeep": "tief",
  "settings.models.readinessModeBasic": "einfach",
  "settings.models.workingToday": "Heute funktionsfähig",
  "settings.models.notVerified": "Nicht verifiziert",
  "settings.models.verifiedCapabilities": "Verifizierte Fähigkeiten",
  "settings.models.capabilityStreaming": "Streaming",
  "settings.models.capabilityTools": "Tools",
  "settings.models.capabilityJson": "JSON",
  "settings.models.capabilityReasoning": "Reasoning",
  "settings.models.capabilityImage": "Bild",
  "settings.models.capabilityPdf": "PDF",
  "settings.models.contextTokensShort": "{count} ctx",
  "settings.models.runReadiness": "Bereitschaft prüfen",
  "settings.models.deepProbes": "Tiefe Prüfungen",
  "settings.models.capabilitySummary":
    "Tools {tools} · strukturiert {structured} · {costClass}/{latencyClass}",
  "settings.models.yes": "ja",
  "settings.models.no": "nein",
  "settings.selfHosted": "Self-hosted",
  "settings.selfHostedTitle": "Läuft in deinem Netzwerk",
  "settings.tabs.models": "Modelle",
  "settings.tabs.general": "Allgemein",
  "settings.tabs.security": "Sicherheit",
  "settings.language.title": "Sprache",
  "settings.language.description": "Wähle die Sprache der Keiko-Oberfläche.",
  "settings.language.label": "Sprache der Oberfläche",
  "settings.language.help": "Wird auf diesem Gerät gespeichert und sofort angewendet.",
  "settings.voice.title": "Assistenzstimme",
  "settings.voice.description": "Wähle die Stimme für den Sprachdialog.",
  "settings.voice.label": "Stimme",
  "settings.voice.help":
    "Wird auf diesem Gerät gespeichert und beim nächsten Sprachdialog genutzt.",
  "settings.voice.unavailable":
    "Stimmen sind verfügbar, sobald ein verbundener Sprachanbieter Sprachausgabe bereitstellt.",
  "settings.wallpaper.title": "Arbeitsbereich-Hintergrund",
  "settings.wallpaper.description":
    "Liquid Chrome ist ein dezenter metallischer Hintergrund hinter dem Raster, der auf Cursor und Klicks reagiert. Schalte ihn aus, um die WebGL-Animation vollständig zu stoppen.",
  "settings.wallpaper.toggle": "Liquid-Hintergrund",
  "settings.wallpaper.running": "Aktiv",
  "settings.wallpaper.stopped": "Gestoppt",
  "settings.wallpaper.opacity": "Deckkraft des Hintergrunds",
  "settings.scale.off": "Aus",
  "settings.scale.full": "Voll",
  "settings.scale.base": "Basis",
  "settings.scale.lighter": "Heller",
  "settings.scale.subtle": "Dezent",
  "settings.scale.strong": "Stark",
  "settings.workspace.backgroundBrightness": "Helligkeit des Arbeitsbereichs",
  "settings.workspace.gridStrength": "Rasterstärke",
  "settings.workspace.cameraAnimation": "Kamera-Animation",
  "settings.workspace.cameraAnimationMinimal": "Minimal",
  "settings.workspace.cameraAnimationSmooth": "Sanft",
  "settings.workspace.cameraAnimationHelp":
    "Weiter rechts werden Schwenken und Zoomen weicher animiert. Minimal wendet Änderungen direkt an.",
  "settings.workspace.borderStrength": "Rahmenstärke",
  "settings.workspace.innerGlow": "Inneres Leuchten",
  "settings.updates.title": "Updates",
  "settings.updates.description": "Prüfe verfügbare Keiko-Updates und installiere sie bei Bedarf.",
  "settings.updates.open": "Updates prüfen",
  "settings.security.placeholder": "SSO · Audit-Log · Datenresidenz - bald verfügbar.",
};

export type SettingsMessageKey = keyof typeof SETTINGS_EN_MESSAGES;
export type I18nTranslate = (key: SettingsMessageKey, values?: MessageValues) => string;
type SettingsMessageCatalog = Readonly<Record<SettingsMessageKey, string>>;

function catalogFor(locale: Locale): SettingsMessageCatalog {
  return locale === "de" ? SETTINGS_DE_MESSAGES : SETTINGS_EN_MESSAGES;
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
    const catalog = catalogFor(locale);
    return (key, values) => interpolate(catalog[key] ?? SETTINGS_EN_MESSAGES[key], values);
  }, [locale]);
}
