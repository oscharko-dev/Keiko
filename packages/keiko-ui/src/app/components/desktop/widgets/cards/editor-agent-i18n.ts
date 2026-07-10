import { useCallback } from "react";

import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

const EN_EDITOR_AGENT_MESSAGES = {
  "chat.codeApply.action": "Apply to editor",
  "chat.codeApply.preparing": "Preparing",
  "chat.codeApply.queued": "Queued for review",
  "chat.codeApply.conflict": "Conflict: {code}",
  "chat.codeApply.unavailable": "Editor unavailable",
  "chat.codeApply.outcomeUnknown": "Outcome unknown",
  "chat.codeApply.outcomeUnknownStatus": "Outcome unknown. Check the editor.",
  "editor.askSelection.selectText": "Select text in the active editor before asking Keiko.",
  "editor.askSelection.chatUnavailable": "Chat is unavailable for this workspace.",
  "editor.askSelection.openFailed": "Could not open chat for this selection.",
  "editor.agentReview.ready": "Editor changes are ready for review.",
  "editor.agentReview.applying": "Confirming the editor review.",
  "editor.agentReview.rejected": "The editor changes were rejected.",
  "editor.agentReview.timedOut": "The editor review expired. Request the change again.",
  "editor.agentReview.conflict": "The editor review conflicts with the current target.",
  "editor.agentReview.failed": "The editor review was not completed.",
  "editor.agentReview.unexpectedSuccess":
    "The editor review ended without a matching local decision.",
  "editor.agentReview.stale": "The editor changed during review. No local changes were applied.",
  "editor.agentReview.reconcileFailed":
    "The committed changes could not be refreshed in the editor.",
  "editor.agentReview.unconfirmed":
    "The review decision was not accepted. No local changes were applied.",
  "editor.agentReview.awaitingResult":
    "The review result is unknown. Waiting for authoritative editor status.",
  "conflict.title.dirty": "Unsaved changes conflict",
  "conflict.title.versionMismatch": "File version mismatch",
  "conflict.title.contentHashMismatch": "File content mismatch",
  "conflict.title.invalidEdits": "Invalid agent edits",
  "conflict.title.outOfScope": "Action out of scope",
  "conflict.title.noActiveSession": "No active editor session",
  "conflict.title.noActiveBridge": "No live editor bridge",
  "conflict.title.preconditionRequired": "Missing write precondition",
  "conflict.title.policyDenied": "Action denied by policy",
  "conflict.title.approvalRequired": "Action approval required",
  "conflict.reload": "Reload",
  // Issue #2120: agent-presence-indicator labels (previously hardcoded English literals).
  "presence.detached": "Agent not attached - no recent activity",
  "presence.idle": "Agent attached - idle",
  "presence.active.one": "Agent attached - 1 action in progress",
  "presence.active.many": "Agent attached - {count} actions in progress",
  "presence.review.active": "Agent attached - review required",
  "presence.review.idle": "Agent review required - no recent activity",
  "actions.panelLabel": "Recent agent editor actions",
  "actions.title": "Recent agent actions",
  "actions.filterGroup": "Filter recent agent actions",
  "actions.filter.actionType": "Action type",
  "actions.filter.disposition": "Disposition",
  "actions.filter.timeRange": "Time range",
  "actions.action.all": "All action types",
  "actions.action.openFile": "Open file",
  "actions.action.focusTab": "Focus tab",
  "actions.action.moveTab": "Move tab",
  "actions.action.splitPane": "Split pane",
  "actions.action.setSelection": "Set selection",
  "actions.action.format": "Format",
  "actions.action.save": "Save",
  "actions.action.applyTextEdits": "Apply text edits",
  "actions.action.applyPatch": "Apply patch",
  "actions.action.applyChangeset": "Apply changeset",
  "actions.disposition.all": "All dispositions",
  "actions.disposition.allowed": "Allowed",
  "actions.disposition.reviewRequired": "Review required",
  "actions.disposition.denied": "Denied",
  "actions.timeRange.all": "All time",
  "actions.timeRange.pastHour": "Past hour",
  "actions.timeRange.pastDay": "Past 24 hours",
  "actions.timeRange.pastWeek": "Past 7 days",
  "actions.loadError": "Unable to load recent agent actions.",
  "actions.empty": "No recent agent editor actions.",
  "actions.noMatch": "No agent editor actions match the current filters.",
  "actions.rowTarget": " on {path}",
  "actions.rowReason": " ({reason})",
  "actions.rowSummary": "{action}{target}: {disposition}, {outcome}{reason}",
} as const;

export type EditorAgentMessageKey = keyof typeof EN_EDITOR_AGENT_MESSAGES;
type EditorAgentMessageCatalog = Readonly<Record<EditorAgentMessageKey, string>>;

const DE_EDITOR_AGENT_MESSAGES = {
  "chat.codeApply.action": "Im Editor anwenden",
  "chat.codeApply.preparing": "Wird vorbereitet",
  "chat.codeApply.queued": "Zur Prüfung vorgemerkt",
  "chat.codeApply.conflict": "Konflikt: {code}",
  "chat.codeApply.unavailable": "Editor nicht verfügbar",
  "chat.codeApply.outcomeUnknown": "Ergebnis unbekannt",
  "chat.codeApply.outcomeUnknownStatus": "Ergebnis unbekannt. Prüfe den Editor.",
  "editor.askSelection.selectText": "Wähle Text im aktiven Editor aus, bevor du Keiko fragst.",
  "editor.askSelection.chatUnavailable": "Der Chat ist für diesen Arbeitsbereich nicht verfügbar.",
  "editor.askSelection.openFailed": "Der Chat für diese Auswahl konnte nicht geöffnet werden.",
  "editor.agentReview.ready": "Editor-Änderungen können geprüft werden.",
  "editor.agentReview.applying": "Die Editor-Prüfung wird bestätigt.",
  "editor.agentReview.rejected": "Die Editor-Änderungen wurden abgelehnt.",
  "editor.agentReview.timedOut":
    "Die Editor-Prüfung ist abgelaufen. Fordere die Änderung erneut an.",
  "editor.agentReview.conflict": "Die Editor-Prüfung steht im Konflikt mit dem aktuellen Ziel.",
  "editor.agentReview.failed": "Die Editor-Prüfung wurde nicht abgeschlossen.",
  "editor.agentReview.unexpectedSuccess":
    "Die Editor-Prüfung endete ohne passende lokale Entscheidung.",
  "editor.agentReview.stale":
    "Der Editor wurde während der Prüfung geändert. Es wurden keine lokalen Änderungen angewendet.",
  "editor.agentReview.reconcileFailed":
    "Die übernommenen Änderungen konnten im Editor nicht aktualisiert werden.",
  "editor.agentReview.unconfirmed":
    "Die Prüfentscheidung wurde nicht akzeptiert. Es wurden keine lokalen Änderungen angewendet.",
  "editor.agentReview.awaitingResult":
    "Das Prüfungsergebnis ist unbekannt. Der Editor wartet auf einen verbindlichen Status.",
  "conflict.title.dirty": "Konflikt mit ungespeicherten Änderungen",
  "conflict.title.versionMismatch": "Abweichende Dateiversion",
  "conflict.title.contentHashMismatch": "Abweichender Dateiinhalt",
  "conflict.title.invalidEdits": "Ungültige Agentenänderungen",
  "conflict.title.outOfScope": "Aktion außerhalb des zulässigen Bereichs",
  "conflict.title.noActiveSession": "Keine aktive Editorsitzung",
  "conflict.title.noActiveBridge": "Keine aktive Editorverbindung",
  "conflict.title.preconditionRequired": "Schreibvorbedingung fehlt",
  "conflict.title.policyDenied": "Aktion durch Richtlinie abgelehnt",
  "conflict.title.approvalRequired": "Aktion muss genehmigt werden",
  "conflict.reload": "Neu laden",
  // Issue #2120: agent-presence-indicator labels (previously hardcoded English literals).
  "presence.detached": "Agent nicht verbunden - keine aktuelle Aktivität",
  "presence.idle": "Agent verbunden - inaktiv",
  "presence.active.one": "Agent verbunden - 1 Aktion in Bearbeitung",
  "presence.active.many": "Agent verbunden - {count} Aktionen in Bearbeitung",
  "presence.review.active": "Agent verbunden - Prüfung erforderlich",
  "presence.review.idle": "Prüfung erforderlich - keine aktuelle Aktivität",
  "actions.panelLabel": "Letzte Agentenaktionen im Editor",
  "actions.title": "Letzte Agentenaktionen",
  "actions.filterGroup": "Letzte Agentenaktionen filtern",
  "actions.filter.actionType": "Aktionstyp",
  "actions.filter.disposition": "Einstufung",
  "actions.filter.timeRange": "Zeitraum",
  "actions.action.all": "Alle Aktionstypen",
  "actions.action.openFile": "Datei öffnen",
  "actions.action.focusTab": "Tab fokussieren",
  "actions.action.moveTab": "Tab verschieben",
  "actions.action.splitPane": "Bereich teilen",
  "actions.action.setSelection": "Auswahl setzen",
  "actions.action.format": "Formatieren",
  "actions.action.save": "Speichern",
  "actions.action.applyTextEdits": "Textänderungen anwenden",
  "actions.action.applyPatch": "Patch anwenden",
  "actions.action.applyChangeset": "Änderungssatz anwenden",
  "actions.disposition.all": "Alle Einstufungen",
  "actions.disposition.allowed": "Zugelassen",
  "actions.disposition.reviewRequired": "Prüfung erforderlich",
  "actions.disposition.denied": "Abgelehnt",
  "actions.timeRange.all": "Gesamter Zeitraum",
  "actions.timeRange.pastHour": "Letzte Stunde",
  "actions.timeRange.pastDay": "Letzte 24 Stunden",
  "actions.timeRange.pastWeek": "Letzte 7 Tage",
  "actions.loadError": "Letzte Agentenaktionen konnten nicht geladen werden.",
  "actions.empty": "Keine letzten Agentenaktionen im Editor.",
  "actions.noMatch": "Keine Agentenaktion entspricht den aktuellen Filtern.",
  "actions.rowTarget": " in {path}",
  "actions.rowReason": " ({reason})",
  "actions.rowSummary": "{action}{target}: {disposition}, {outcome}{reason}",
} satisfies EditorAgentMessageCatalog;

const EDITOR_AGENT_MESSAGES: Record<Locale, EditorAgentMessageCatalog> = {
  en: EN_EDITOR_AGENT_MESSAGES,
  de: DE_EDITOR_AGENT_MESSAGES,
};

export type EditorAgentTranslate = (key: EditorAgentMessageKey, values?: MessageValues) => string;

function formatEditorAgentMessage(template: string, values: MessageValues = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function translateEditorAgent(
  locale: Locale,
  key: EditorAgentMessageKey,
  values?: MessageValues,
): string {
  return formatEditorAgentMessage(EDITOR_AGENT_MESSAGES[locale][key], values);
}

export function useEditorAgentTranslate(): EditorAgentTranslate {
  const locale = useLocale();
  return useCallback(
    (key: EditorAgentMessageKey, values?: MessageValues): string =>
      translateEditorAgent(locale, key, values),
    [locale],
  );
}
