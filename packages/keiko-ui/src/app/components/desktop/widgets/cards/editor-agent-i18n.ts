import { useCallback } from "react";

import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

const EN_EDITOR_AGENT_MESSAGES = {
  "chat.creation.openFailed": "Could not open chat.",
  "chat.creation.titleSaveFailed": "The chat opened, but its title could not be saved.",
  "chat.restoration.opening": "Opening chat...",
  "chat.restoration.notFoundTitle": "Chat not found",
  "chat.restoration.notFoundBody": "This conversation was deleted or is no longer available.",
  "chat.restoration.chooseLabel": "Conversations this window may have shown",
  "chat.restoration.chooseBody":
    "This window's saved conversation cannot be identified. If it is one of these, open it here:",
  "chat.restoration.chooseOpen": "Open {title}, last active {updated}",
  "chat.restoration.chooseOpenReference": "{label}, reference {reference}",
  "chat.restoration.choiceNotice":
    "You chose this conversation for this window. Keep it, or choose another if it is not the one this window showed.",
  "chat.restoration.choicePendingNotice":
    "You chose this conversation for this window. Check it once it opens, or choose another.",
  "chat.restoration.choiceMissingNotice":
    "The conversation you chose for this window is no longer available.",
  "chat.restoration.choiceKeep": "Keep",
  "chat.restoration.choiceAnother": "Choose another",
  // A rename changeset the language service capped or could not complete. Applying part of a rename
  // leaves the remaining references pointing at the old name, so the counts are stated and Apply is
  // refused rather than presenting the capped result as the finished rename.
  "editor.rename.incomplete":
    "Incomplete rename: only {files} of {totalFiles} file(s) and {edits} of {totalEdits} reference(s) were returned. Applying it would rename part of the symbol and leave the rest pointing at the old name, so Apply is disabled. Rename the symbol in a narrower scope and try again.",
  "editor.rename.incompleteUnreadable": "{count} file(s) could not be read and carry no changes.",
  "editor.rename.incompleteRefused": "This rename is incomplete and was not applied.",
  "conflict.title.dirty": "Unsaved changes conflict",
  "conflict.title.versionMismatch": "File version mismatch",
  "conflict.title.contentHashMismatch": "File content mismatch",
  "conflict.title.invalidEdits": "Invalid edits",
  "conflict.title.outOfScope": "Action out of scope",
  "conflict.title.noActiveSession": "No active editor session",
  "conflict.title.noActiveBridge": "No live editor bridge",
  "conflict.title.preconditionRequired": "Missing write precondition",
  "conflict.title.policyDenied": "Action denied by policy",
  "conflict.title.approvalRequired": "Action approval required",
  "conflict.reload": "Reload",
} as const;

export type EditorAgentMessageKey = keyof typeof EN_EDITOR_AGENT_MESSAGES;
type EditorAgentMessageCatalog = Readonly<Record<EditorAgentMessageKey, string>>;

const DE_EDITOR_AGENT_MESSAGES = {
  "chat.creation.openFailed": "Der Chat konnte nicht geöffnet werden.",
  "chat.creation.titleSaveFailed":
    "Der Chat wurde geöffnet, aber sein Titel konnte nicht gespeichert werden.",
  "chat.restoration.opening": "Der Chat wird geöffnet…",
  "chat.restoration.notFoundTitle": "Chat nicht gefunden",
  "chat.restoration.notFoundBody":
    "Diese Unterhaltung wurde gelöscht oder ist nicht mehr verfügbar.",
  "chat.restoration.chooseLabel": "Unterhaltungen, die dieses Fenster gezeigt haben könnte",
  "chat.restoration.chooseBody":
    "Die gespeicherte Unterhaltung dieses Fensters lässt sich nicht bestimmen. Falls es eine dieser ist, öffne sie hier:",
  "chat.restoration.chooseOpen": "{title} öffnen, zuletzt aktiv am {updated}",
  "chat.restoration.chooseOpenReference": "{label}, Referenz {reference}",
  "chat.restoration.choiceNotice":
    "Du hast diese Unterhaltung für dieses Fenster gewählt. Behalte sie, oder wähle eine andere, falls es nicht die ist, die dieses Fenster gezeigt hat.",
  "chat.restoration.choicePendingNotice":
    "Du hast diese Unterhaltung für dieses Fenster gewählt. Prüfe sie, sobald sie geöffnet ist, oder wähle eine andere.",
  "chat.restoration.choiceMissingNotice":
    "Die Unterhaltung, die du für dieses Fenster gewählt hast, ist nicht mehr verfügbar.",
  "chat.restoration.choiceKeep": "Behalten",
  "chat.restoration.choiceAnother": "Andere wählen",
  "editor.rename.incomplete":
    "Unvollständige Umbenennung: Es wurden nur {files} von {totalFiles} Datei(en) und {edits} von {totalEdits} Verweis(en) zurückgegeben. Beim Anwenden würde nur ein Teil des Symbols umbenannt, der Rest würde weiter auf den alten Namen verweisen. Anwenden ist deshalb deaktiviert. Benenne das Symbol in einem kleineren Bereich um.",
  "editor.rename.incompleteUnreadable":
    "{count} Datei(en) konnten nicht gelesen werden und enthalten keine Änderungen.",
  "editor.rename.incompleteRefused":
    "Diese Umbenennung ist unvollständig und wurde nicht angewendet.",
  "conflict.title.dirty": "Konflikt mit ungespeicherten Änderungen",
  "conflict.title.versionMismatch": "Abweichende Dateiversion",
  "conflict.title.contentHashMismatch": "Abweichender Dateiinhalt",
  "conflict.title.invalidEdits": "Ungültige Änderungen",
  "conflict.title.outOfScope": "Aktion außerhalb des zulässigen Bereichs",
  "conflict.title.noActiveSession": "Keine aktive Editorsitzung",
  "conflict.title.noActiveBridge": "Keine aktive Editorverbindung",
  "conflict.title.preconditionRequired": "Schreibvorbedingung fehlt",
  "conflict.title.policyDenied": "Aktion durch Richtlinie abgelehnt",
  "conflict.title.approvalRequired": "Aktion muss genehmigt werden",
  "conflict.reload": "Neu laden",
} satisfies EditorAgentMessageCatalog;

const EDITOR_AGENT_MESSAGES: Record<Locale, EditorAgentMessageCatalog> = {
  en: EN_EDITOR_AGENT_MESSAGES,
  de: DE_EDITOR_AGENT_MESSAGES,
};

export type EditorAgentTranslate = (key: EditorAgentMessageKey, values?: MessageValues) => string;

function formatEditorAgentMessage(template: string, values: MessageValues = {}): string {
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
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
