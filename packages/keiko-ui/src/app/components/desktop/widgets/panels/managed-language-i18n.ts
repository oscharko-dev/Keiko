"use client";

import { useMemo } from "react";

import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

const EN = {
  title: "Language intelligence",
  description:
    "Manage workspace language servers, negotiated capabilities, health, and restart state.",
  noWorkspace: "Select a workspace to manage language intelligence.",
  loading: "Loading language intelligence...",
  loadFailed: "Language intelligence could not be loaded.",
  retry: "Retry",
  retryIntent: "Retry requested change",
  conflict:
    "The workspace changed on the server. Current state was reloaded; your requested change is still available to retry.",
  mutationFailed: "The requested change was not applied. Server state remains authoritative.",
  applying: "Applying workspace language change...",
  enabled: "Enable {language}",
  disabled: "Disable {language}",
  restart: "Restart {language}",
  reset: "Reset {language}",
  confirmTitle: "Confirm disruptive language change",
  confirmBody: "{action} may interrupt language features for open files in this workspace.",
  confirm: "Confirm {action}",
  cancel: "Cancel",
  actionEnable: "enable",
  actionDisable: "disable",
  actionRestart: "restart",
  actionReset: "reset",
  stateDisabled: "Disabled",
  stateDisabledByPolicy: "Disabled by policy",
  stateNotProvisioned: "Not provisioned",
  stateAvailable: "Available",
  stateStarting: "Starting",
  stateActive: "Active",
  stateDegraded: "Degraded",
  stateUnhealthy: "Unhealthy",
  stateRestartRequired: "Restart required",
  languagePython: "Python",
  languageGo: "Go",
  languageShell: "Shell",
  languageJava: "Java",
  languageRust: "Rust",
  capabilities: "Negotiated capabilities",
  noCapabilities: "No executable capabilities were negotiated.",
  moreCapabilities: "{count} more capabilities",
  health: "Runtime health",
  healthSummary:
    "{status}; {success} successful requests; {failures} failures; maximum latency {latency} ms.",
  healthUnavailable: "No runtime health sample is available yet.",
  configuration: "Runtime settings",
  configured: "Configured",
  notConfigured: "Using governed defaults",
  source: "Settings source: {source}",
  sourceWorkspace: "workspace",
  sourceOperatorProvisioning: "operator provisioning",
  sourceBuiltInDefault: "built-in default",
  providerConfigurationSource: "Detected project configuration: {source}",
  restartImpact: "Restart impact: {fields}",
  restartRuntime: "runtime",
  restartSettings: "settings",
  pythonSettings:
    "Type checking: {mode}; interpreter: {interpreter}; virtual environment: {venv}; precedence: {precedence}; additional workspace paths: {count}.",
  goSettings: "Static analysis: {staticcheck}; build tags: {count}; target: {target}.",
  shellSettings:
    "Dialect: {dialect}; ShellCheck: {shellcheck}; severity: {severity}; exclusions: {exclusions}; workspace source paths: {paths}.",
  javaSettings: "Java source {source}, target {target}; project roots: {count}.",
  rustSettings: "Features: {count}; target: {target}; Cargo metadata: {metadata}.",
  valueEnabled: "enabled",
  valueDisabled: "disabled",
  valueDefault: "default",
  editTypeChecking: "Type-checking mode",
  editStaticcheck: "Enable static analysis",
  editDialect: "Shell dialect",
  editJavaSource: "Java source level",
  editJavaTarget: "Java target level",
  editRustTarget: "Rust target triple",
  saveSettings: "Save settings",
  unsaved: "Unsaved workspace settings",
  invalidTarget:
    "Use an empty target or a target triple containing only letters, digits, dots, underscores, and hyphens.",
  guidancePolicy: "An operator policy prevents activation. No change can be sent from this screen.",
  guidanceProvisioning:
    "Provision the approved language server outside the workspace, then retry status refresh.",
  guidanceUnavailable: "Language settings are temporarily unavailable and remain disabled.",
  reasonProductUnsupported: "This language is not supported by this Keiko build.",
  reasonPolicyDenied: "Deployment policy denied activation.",
  reasonLegacyDisabled: "The compatibility environment policy disabled this provider.",
  reasonNotProvisioned: "The approved language server is not provisioned.",
  reasonWorkspaceDisabled: "This workspace disabled the provider.",
  reasonWorkspaceUnset: "This workspace has not enabled the provider.",
  reasonAvailable: "The provider is provisioned and can be enabled.",
  reasonStarting: "The server is starting and negotiating capabilities.",
  reasonCapabilityMissing: "A required live capability was not negotiated.",
  reasonHealthUnknown: "Runtime health has not been established.",
  reasonDegraded: "The runtime reported degraded service.",
  reasonUnhealthy: "The runtime is unhealthy.",
  reasonRestartRequired: "Changed runtime settings require a controlled restart.",
  reasonActive: "The server is active with negotiated capabilities.",
  reasonStateUnavailable: "Server-owned settings could not be read safely.",
  reasonInvalid: "The server rejected an invalid state.",
  announcedApplied: "{action} completed for {language}.",
} as const;

type Key = keyof typeof EN;
type Catalog = Readonly<Record<Key, string>>;

const DE: Catalog = {
  title: "Sprachintelligenz",
  description:
    "Verwalte Workspace-Sprachserver, ausgehandelte Funktionen, Zustand und Neustartstatus.",
  noWorkspace: "Wähle einen Workspace aus, um die Sprachintelligenz zu verwalten.",
  loading: "Sprachintelligenz wird geladen...",
  loadFailed: "Die Sprachintelligenz konnte nicht geladen werden.",
  retry: "Erneut versuchen",
  retryIntent: "Angeforderte Änderung erneut versuchen",
  conflict:
    "Der Workspace wurde auf dem Server geändert. Der aktuelle Zustand wurde neu geladen; deine angeforderte Änderung kann erneut versucht werden.",
  mutationFailed:
    "Die angeforderte Änderung wurde nicht angewendet. Der Serverzustand bleibt maßgeblich.",
  applying: "Workspace-Sprachänderung wird angewendet...",
  enabled: "{language} aktivieren",
  disabled: "{language} deaktivieren",
  restart: "{language} neu starten",
  reset: "{language} zurücksetzen",
  confirmTitle: "Unterbrechende Sprachänderung bestätigen",
  confirmBody:
    "{action} kann Sprachfunktionen für geöffnete Dateien in diesem Workspace unterbrechen.",
  confirm: "{action} bestätigen",
  cancel: "Abbrechen",
  actionEnable: "Aktivieren",
  actionDisable: "Deaktivieren",
  actionRestart: "Neustart",
  actionReset: "Zurücksetzen",
  stateDisabled: "Deaktiviert",
  stateDisabledByPolicy: "Durch Richtlinie deaktiviert",
  stateNotProvisioned: "Nicht bereitgestellt",
  stateAvailable: "Verfügbar",
  stateStarting: "Wird gestartet",
  stateActive: "Aktiv",
  stateDegraded: "Eingeschränkt",
  stateUnhealthy: "Fehlerhaft",
  stateRestartRequired: "Neustart erforderlich",
  languagePython: "Python",
  languageGo: "Go",
  languageShell: "Shell",
  languageJava: "Java",
  languageRust: "Rust",
  capabilities: "Ausgehandelte Funktionen",
  noCapabilities: "Es wurden keine ausführbaren Funktionen ausgehandelt.",
  moreCapabilities: "{count} weitere Funktionen",
  health: "Laufzeitzustand",
  healthSummary:
    "{status}; {success} erfolgreiche Anfragen; {failures} Fehler; maximale Latenz {latency} ms.",
  healthUnavailable: "Es ist noch kein Laufzeitzustand verfügbar.",
  configuration: "Laufzeiteinstellungen",
  configured: "Konfiguriert",
  notConfigured: "Regulierte Standardwerte werden verwendet",
  source: "Einstellungsquelle: {source}",
  sourceWorkspace: "Workspace",
  sourceOperatorProvisioning: "Operator-Bereitstellung",
  sourceBuiltInDefault: "integrierter Standard",
  providerConfigurationSource: "Erkannte Projektkonfiguration: {source}",
  restartImpact: "Neustartauswirkung: {fields}",
  restartRuntime: "Laufzeit",
  restartSettings: "Einstellungen",
  pythonSettings:
    "Typprüfung: {mode}; Interpreter: {interpreter}; virtuelle Umgebung: {venv}; Reihenfolge: {precedence}; zusätzliche Workspace-Pfade: {count}.",
  goSettings: "Statische Analyse: {staticcheck}; Build-Tags: {count}; Ziel: {target}.",
  shellSettings:
    "Dialekt: {dialect}; ShellCheck: {shellcheck}; Schweregrad: {severity}; Ausschlüsse: {exclusions}; Workspace-Quellpfade: {paths}.",
  javaSettings: "Java-Quelle {source}, Ziel {target}; Projektwurzeln: {count}.",
  rustSettings: "Features: {count}; Ziel: {target}; Cargo-Metadaten: {metadata}.",
  valueEnabled: "aktiviert",
  valueDisabled: "deaktiviert",
  valueDefault: "Standard",
  editTypeChecking: "Typprüfungsmodus",
  editStaticcheck: "Statische Analyse aktivieren",
  editDialect: "Shell-Dialekt",
  editJavaSource: "Java-Quelllevel",
  editJavaTarget: "Java-Ziellevel",
  editRustTarget: "Rust-Ziel-Tripel",
  saveSettings: "Einstellungen speichern",
  unsaved: "Ungespeicherte Workspace-Einstellungen",
  invalidTarget:
    "Verwende ein leeres Ziel oder ein Ziel-Tripel nur aus Buchstaben, Ziffern, Punkten, Unterstrichen und Bindestrichen.",
  guidancePolicy:
    "Eine Operator-Richtlinie verhindert die Aktivierung. Dieser Bildschirm sendet keine Änderung.",
  guidanceProvisioning:
    "Stelle den freigegebenen Sprachserver außerhalb des Workspace bereit und aktualisiere danach den Status.",
  guidanceUnavailable:
    "Die Spracheinstellungen sind vorübergehend nicht verfügbar und bleiben deaktiviert.",
  reasonProductUnsupported: "Diese Sprache wird von diesem Keiko-Build nicht unterstützt.",
  reasonPolicyDenied: "Die Bereitstellungsrichtlinie hat die Aktivierung abgelehnt.",
  reasonLegacyDisabled: "Die Kompatibilitäts-Umgebungsrichtlinie hat diesen Provider deaktiviert.",
  reasonNotProvisioned: "Der freigegebene Sprachserver ist nicht bereitgestellt.",
  reasonWorkspaceDisabled: "Dieser Workspace hat den Provider deaktiviert.",
  reasonWorkspaceUnset: "Dieser Workspace hat den Provider nicht aktiviert.",
  reasonAvailable: "Der Provider ist bereitgestellt und kann aktiviert werden.",
  reasonStarting: "Der Server startet und handelt Funktionen aus.",
  reasonCapabilityMissing: "Eine erforderliche Live-Funktion wurde nicht ausgehandelt.",
  reasonHealthUnknown: "Der Laufzeitzustand wurde noch nicht ermittelt.",
  reasonDegraded: "Die Laufzeit meldet eingeschränkten Betrieb.",
  reasonUnhealthy: "Die Laufzeit ist fehlerhaft.",
  reasonRestartRequired: "Geänderte Laufzeiteinstellungen erfordern einen kontrollierten Neustart.",
  reasonActive: "Der Server ist mit ausgehandelten Funktionen aktiv.",
  reasonStateUnavailable: "Servereigene Einstellungen konnten nicht sicher gelesen werden.",
  reasonInvalid: "Der Server hat einen ungültigen Zustand abgelehnt.",
  announcedApplied: "{action} für {language} abgeschlossen.",
};

export type ManagedLanguageTranslate = (key: Key, values?: MessageValues) => string;

function interpolate(template: string, values: MessageValues = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

function catalog(locale: Locale): Catalog {
  return locale === "de" ? DE : EN;
}

export function useManagedLanguageTranslate(): ManagedLanguageTranslate {
  const locale = useLocale();
  return useMemo(() => {
    const messages = catalog(locale);
    return (key, values) => interpolate(messages[key], values);
  }, [locale]);
}
