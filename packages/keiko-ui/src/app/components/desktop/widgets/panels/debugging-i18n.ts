import type { Locale } from "@/lib/i18n";

const EN_MESSAGES = {
  title: "Governed debugging",
  description:
    "Enable Node.js and TypeScript debugging only when deployment policy and approved provisioning allow it.",
  noWorkspace: "Select a workspace before changing debugging access.",
  loading: "Loading debugging status...",
  loadFailed: "Debugging status could not be loaded and remains unavailable.",
  retry: "Retry",
  mutationFailed: "The debugging preference was not changed. Server state remains authoritative.",
  applying: "Applying debugging preference...",
  appliedEnable: "Debugging was enabled for this workspace.",
  appliedDisable: "Debugging was disabled for this workspace.",
  optInLabel: "Enable debugging for this workspace",
  optInHelp: "This local-human opt-in can start no session by itself.",
  stateDisabled: "Disabled",
  stateDisabledByPolicy: "Disabled by policy",
  stateNotProvisioned: "Not provisioned",
  stateAvailable: "Available",
  stateUnavailable: "Status unavailable",
  reasonProductUnsupported: "This Keiko build does not support governed debugging.",
  reasonPolicyDenied: "Deployment policy denies debugging.",
  reasonPolicyUnavailable: "Deployment policy status is unavailable, so debugging is denied.",
  reasonWorkspaceDisabled: "Workspace debugging is disabled.",
  reasonWorkspaceUnset: "Workspace debugging has not been enabled.",
  reasonNotProvisioned: "The approved debugging runtime is not provisioned.",
  reasonAvailable: "All debugging prerequisites are currently satisfied.",
  reasonUnavailable: "A trusted debugging activation summary is unavailable.",
  guidanceProductUnsupported: "Debugging remains unavailable in this product build.",
  guidancePolicy: "An operator policy prevents activation. This screen cannot override it.",
  guidanceOptIn: "Enable this workspace opt-in to request governed debugging.",
  guidanceProvisioning: "Ask an operator to provision the approved runtime outside the workspace.",
  guidanceAvailable:
    "A local human may start a governed debugging session when the editor surface is available.",
  guidanceUnavailable: "No change can be sent until a trusted server summary is available.",
  confirmTitle: "Confirm debugging deactivation",
  confirmBody:
    "Disabling debugging revokes any active governed debugging session in this workspace.",
  confirmDisable: "Disable debugging",
  cancel: "Cancel",
} as const;

const DE_MESSAGES: Record<keyof typeof EN_MESSAGES, string> = {
  title: "Gesteuertes Debugging",
  description:
    "Aktiviere Node.js- und TypeScript-Debugging nur, wenn Deployment-Richtlinie und freigegebene Bereitstellung es zulassen.",
  noWorkspace: "Wähle einen Workspace, bevor du Debugging-Zugriff änderst.",
  loading: "Debugging-Status wird geladen...",
  loadFailed: "Der Debugging-Status konnte nicht geladen werden und bleibt nicht verfügbar.",
  retry: "Erneut versuchen",
  mutationFailed:
    "Die Debugging-Einstellung wurde nicht geändert. Der Serverzustand bleibt maßgeblich.",
  applying: "Debugging-Einstellung wird angewendet...",
  appliedEnable: "Debugging wurde für diesen Workspace aktiviert.",
  appliedDisable: "Debugging wurde für diesen Workspace deaktiviert.",
  optInLabel: "Debugging für diesen Workspace aktivieren",
  optInHelp: "Diese lokale menschliche Freigabe startet selbst keine Sitzung.",
  stateDisabled: "Deaktiviert",
  stateDisabledByPolicy: "Durch Richtlinie deaktiviert",
  stateNotProvisioned: "Nicht bereitgestellt",
  stateAvailable: "Verfügbar",
  stateUnavailable: "Status nicht verfügbar",
  reasonProductUnsupported: "Dieser Keiko-Build unterstützt kein gesteuertes Debugging.",
  reasonPolicyDenied: "Die Deployment-Richtlinie verweigert Debugging.",
  reasonPolicyUnavailable:
    "Der Status der Deployment-Richtlinie ist nicht verfügbar; Debugging wird verweigert.",
  reasonWorkspaceDisabled: "Debugging im Workspace ist deaktiviert.",
  reasonWorkspaceUnset: "Debugging im Workspace wurde noch nicht aktiviert.",
  reasonNotProvisioned: "Die freigegebene Debugging-Laufzeit ist nicht bereitgestellt.",
  reasonAvailable: "Alle Debugging-Voraussetzungen sind derzeit erfüllt.",
  reasonUnavailable:
    "Eine vertrauenswürdige Debugging-Aktivierungszusammenfassung ist nicht verfügbar.",
  guidanceProductUnsupported: "Debugging bleibt in diesem Produkt-Build nicht verfügbar.",
  guidancePolicy:
    "Eine Operator-Richtlinie verhindert die Aktivierung. Dieser Bildschirm kann sie nicht überschreiben.",
  guidanceOptIn: "Aktiviere diese Workspace-Freigabe, um gesteuertes Debugging anzufordern.",
  guidanceProvisioning:
    "Bitte einen Operator, die freigegebene Laufzeit außerhalb des Workspace bereitzustellen.",
  guidanceAvailable:
    "Ein lokaler Mensch kann eine gesteuerte Debugging-Sitzung starten, wenn die Editor-Oberfläche verfügbar ist.",
  guidanceUnavailable:
    "Bis eine vertrauenswürdige Serverzusammenfassung vorliegt, kann keine Änderung gesendet werden.",
  confirmTitle: "Deaktivierung von Debugging bestätigen",
  confirmBody:
    "Das Deaktivieren von Debugging widerruft jede aktive gesteuerte Debugging-Sitzung in diesem Workspace.",
  confirmDisable: "Debugging deaktivieren",
  cancel: "Abbrechen",
};

type DebuggingMessages = Readonly<Record<keyof typeof EN_MESSAGES, string>>;

const MESSAGES: Readonly<Record<Locale, DebuggingMessages>> = {
  en: EN_MESSAGES,
  de: DE_MESSAGES,
};

export type DebuggingTranslate = (key: keyof typeof EN_MESSAGES) => string;

export function debuggingTranslate(locale: Locale): DebuggingTranslate {
  return (key) => MESSAGES[locale][key];
}
