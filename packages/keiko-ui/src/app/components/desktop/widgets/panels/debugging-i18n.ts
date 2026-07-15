import { useMemo } from "react";
import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

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
  panelLabel: "Debug",
  unavailableByPolicy: "Debugging is unavailable until enabled by policy.",
  unavailableWithoutWorkspace:
    "Debugging is unavailable until the host supplies a canonical workspace identity.",
  noActiveSession: "No active debug session.",
  sessionStatus: "Session is {status}.",
  statusReserved: "reserved",
  statusStarting: "starting",
  statusRunning: "running",
  statusPaused: "paused",
  statusStopping: "stopping",
  statusStopped: "stopped",
  statusFailed: "failed",
  statusRevoked: "revoked",
  exceptionDescription: "Exception: {description}",
  startCurrentFile: "Start debugging current file",
  controlsLabel: "Debug controls",
  continue: "Continue",
  pause: "Pause",
  stepOver: "Step over",
  stepInto: "Step into",
  stepOut: "Step out",
  stop: "Stop debugging",
  actionFailed: "The debug action failed. The server state remains authoritative.",
  exceptionBreakpoints: "Exception breakpoints",
  noExceptionFilters: "No exception filters are available.",
  filterCaught: "Caught exceptions",
  filterUncaught: "Uncaught exceptions",
  callStack: "Call stack",
  pauseForStack: "Pause a session to inspect its stack.",
  variables: "Variables",
  omittedVariables: "More values omitted ({count})",
  noPausedFrame: "No paused frame is selected.",
  pausedVariableEditor: "Paused variable editor",
  setVariableHelp:
    "Saving this value mutates the live paused debuggee and may alter program behavior.",
  newVariableValue: "New variable value",
  save: "Save",
  watch: "Watch",
  watchHelp: "Watches are explicit local-human expressions and may have debuggee side effects.",
  evaluateWatch: "Evaluate {expression}",
  edit: "Edit",
  addWatch: "Add watch",
  watchEditor: "Watch expression editor",
  watchExpression: "Watch expression",
  consoleHeading: "Debug console output",
  consoleHelp:
    "Output and registered-watch results only. This console never evaluates typed input.",
  debugOutput: "Debug output",
  watchResults: "Registered watch results",
  notEvaluated: "Not evaluated",
  gutterToggle: "Toggle breakpoint",
  gutterConditional: "Set conditional breakpoint",
  gutterLogpoint: "Set logpoint",
  gutterEnable: "Enable breakpoint",
  gutterDisable: "Disable breakpoint",
  gutterCurrentLine: "Current execution line",
  breakpointConditionPrompt: "Breakpoint condition",
  logpointMessagePrompt: "Logpoint message",
  breakpointMenu: "Breakpoint actions for line {line}",
  breakpointsHeading: "Breakpoints",
  noBreakpoints: "No breakpoints are set.",
  breakpointLocation: "{fileId}, line {line}",
  breakpointKindLine: "Line breakpoint",
  breakpointKindConditional: "Conditional breakpoint",
  breakpointKindLogpoint: "Logpoint",
  breakpointRemove: "Remove breakpoint",
  commandStartContinue: "Debug: Start or Continue",
  commandPause: "Debug: Pause",
  commandStepOver: "Debug: Step Over",
  commandStepInto: "Debug: Step Into",
  commandStepOut: "Debug: Step Out",
  commandStop: "Debug: Stop",
  pausedValues: "Paused debug values",
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
  panelLabel: "Debuggen",
  unavailableByPolicy: "Debugging ist nicht verfügbar, bis es per Richtlinie aktiviert wurde.",
  unavailableWithoutWorkspace:
    "Debugging ist nicht verfügbar, bis der Host eine kanonische Workspace-Identität bereitstellt.",
  noActiveSession: "Keine aktive Debugging-Sitzung.",
  sessionStatus: "Sitzungsstatus: {status}.",
  statusReserved: "reserviert",
  statusStarting: "wird gestartet",
  statusRunning: "läuft",
  statusPaused: "pausiert",
  statusStopping: "wird beendet",
  statusStopped: "beendet",
  statusFailed: "fehlgeschlagen",
  statusRevoked: "widerrufen",
  exceptionDescription: "Ausnahme: {description}",
  startCurrentFile: "Aktuelle Datei debuggen",
  controlsLabel: "Debugging-Steuerung",
  continue: "Fortsetzen",
  pause: "Anhalten",
  stepOver: "Überspringen",
  stepInto: "Hineinspringen",
  stepOut: "Herausspringen",
  stop: "Debugging beenden",
  actionFailed: "Die Debugging-Aktion ist fehlgeschlagen. Der Serverzustand bleibt maßgeblich.",
  exceptionBreakpoints: "Ausnahme-Haltepunkte",
  noExceptionFilters: "Es sind keine Ausnahmefilter verfügbar.",
  filterCaught: "Abgefangene Ausnahmen",
  filterUncaught: "Nicht abgefangene Ausnahmen",
  callStack: "Aufrufliste",
  pauseForStack: "Halte eine Sitzung an, um ihre Aufrufliste zu untersuchen.",
  variables: "Variablen",
  omittedVariables: "Weitere Werte ausgelassen ({count})",
  noPausedFrame: "Es ist kein angehaltener Frame ausgewählt.",
  pausedVariableEditor: "Editor für angehaltene Variable",
  setVariableHelp:
    "Das Speichern dieses Werts verändert den laufenden, angehaltenen Debuggee und kann das Programmverhalten ändern.",
  newVariableValue: "Neuer Variablenwert",
  save: "Speichern",
  watch: "Überwachen",
  watchHelp:
    "Überwachungen sind explizite Ausdrücke eines lokalen Menschen und können Seiteneffekte im Debuggee haben.",
  evaluateWatch: "{expression} auswerten",
  edit: "Bearbeiten",
  addWatch: "Überwachung hinzufügen",
  watchEditor: "Editor für Überwachungsausdruck",
  watchExpression: "Überwachungsausdruck",
  consoleHeading: "Ausgabe der Debug-Konsole",
  consoleHelp:
    "Nur Ausgabe und Ergebnisse registrierter Überwachungen. Diese Konsole wertet niemals eingegebenen Text aus.",
  debugOutput: "Debug-Ausgabe",
  watchResults: "Ergebnisse registrierter Überwachungen",
  notEvaluated: "Nicht ausgewertet",
  gutterToggle: "Haltepunkt umschalten",
  gutterConditional: "Bedingten Haltepunkt setzen",
  gutterLogpoint: "Protokollpunkt setzen",
  gutterEnable: "Haltepunkt aktivieren",
  gutterDisable: "Haltepunkt deaktivieren",
  gutterCurrentLine: "Aktuelle Ausführungszeile",
  breakpointConditionPrompt: "Haltepunktbedingung",
  logpointMessagePrompt: "Nachricht des Protokollpunkts",
  breakpointMenu: "Haltepunktaktionen für Zeile {line}",
  breakpointsHeading: "Haltepunkte",
  noBreakpoints: "Es sind keine Haltepunkte gesetzt.",
  breakpointLocation: "{fileId}, Zeile {line}",
  breakpointKindLine: "Zeilenhaltepunkt",
  breakpointKindConditional: "Bedingter Haltepunkt",
  breakpointKindLogpoint: "Protokollpunkt",
  breakpointRemove: "Haltepunkt entfernen",
  commandStartContinue: "Debuggen: Starten oder fortsetzen",
  commandPause: "Debuggen: Anhalten",
  commandStepOver: "Debuggen: Überspringen",
  commandStepInto: "Debuggen: Hineinspringen",
  commandStepOut: "Debuggen: Herausspringen",
  commandStop: "Debuggen: Beenden",
  pausedValues: "Pausierte Debug-Werte",
};

type DebuggingMessages = Readonly<Record<keyof typeof EN_MESSAGES, string>>;

const MESSAGES: Readonly<Record<Locale, DebuggingMessages>> = {
  en: EN_MESSAGES,
  de: DE_MESSAGES,
};

export type DebuggingTranslate = (key: keyof typeof EN_MESSAGES, values?: MessageValues) => string;

function interpolate(template: string, values: MessageValues = {}): string {
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function debuggingTranslate(locale: Locale): DebuggingTranslate {
  return (key, values) => interpolate(MESSAGES[locale][key], values);
}

export function useDebuggingTranslate(): DebuggingTranslate {
  const locale = useLocale();
  return useMemo(() => debuggingTranslate(locale), [locale]);
}

export function debugSessionStatus(
  t: DebuggingTranslate,
  status:
    "reserved" | "starting" | "running" | "paused" | "stopping" | "stopped" | "failed" | "revoked",
): string {
  const key = {
    reserved: "statusReserved",
    starting: "statusStarting",
    running: "statusRunning",
    paused: "statusPaused",
    stopping: "statusStopping",
    stopped: "statusStopped",
    failed: "statusFailed",
    revoked: "statusRevoked",
  } as const;
  return t(key[status]);
}
