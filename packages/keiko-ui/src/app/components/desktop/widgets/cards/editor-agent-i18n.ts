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
  "editor.ui.keepLocal": "Keep local",
  "editor.ui.reload": "Reload",
  "editor.ui.reloadExternal": "Reload external changes",
  "editor.ui.closeCompare": "Close compare",
  "editor.ui.compare": "Compare",
  "editor.ui.useDisk": "Use disk",
  "editor.ui.cancel": "Cancel",
  "editor.ui.srExternal":
    "Side-by-side comparison of the latest file on disk and the local editor buffer. Keep local preserves your buffer; reload replaces it with the file on disk.",
  "editor.ui.srRecovery":
    "Side-by-side comparison of the file on disk and the recovered unsaved changes. Keep local restores the recovered changes; use disk keeps the file on disk.",
  "editor.ui.loadingFile": "Loading file…",
  "editor.ui.openDocuments": "Open documents",
  "editor.ui.hiddenDocuments": "Hidden open documents",
  "editor.ui.discardTitle": "Discard unsaved changes?",
  "editor.ui.discardReload": "Discard and reload",
  "editor.ui.recoveredDiskChanged":
    "Recovered editor changes are available, and the disk file changed.",
  "editor.ui.recovered": "Recovered unsaved editor changes are available.",
  "editor.ui.restoreUnsaved": "Restore unsaved changes",
  "editor.ui.discard": "Discard",
  "editor.ui.reloadWarning":
    "Reloading from disk replaces this buffer with the saved file and discards your unsaved editor changes{location}.",
  "editor.ui.inFile": "in {file}",
  "editor.ui.unsavedTitle": "Unsaved editor changes",
  "editor.ui.unsavedHint": "Choose how to handle these files before continuing.",
  "editor.ui.saving": "Saving...",
  "editor.ui.save": "Save",
  "editor.ui.splitControls": "Editor split controls",
  "editor.ui.splitRight": "Split {file} right",
  "editor.ui.splitDown": "Split {file} down",
  "editor.ui.closeSplit": "Close split {file}",
  "editor.ui.editor": "editor",
  "editor.ui.resizeSplit": "Resize editor split",
  "editor.ui.showTree": "Show project tree",
  "editor.ui.hideTree": "Hide project tree",
  "editor.ui.files": "Editor files",
  "editor.ui.resizeTree": "Resize project tree",
  "editor.ui.breadcrumbs": "Editor breadcrumbs",
  "editor.ui.fileSymbols": "Current file symbols",
  "editor.ui.dropTab": "Drop tab {zone}",
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
  "editor.ui.keepLocal": "Lokale Version behalten",
  "editor.ui.reload": "Neu laden",
  "editor.ui.reloadExternal": "Externe Änderungen neu laden",
  "editor.ui.closeCompare": "Vergleich schließen",
  "editor.ui.compare": "Vergleichen",
  "editor.ui.useDisk": "Datenträger-Version verwenden",
  "editor.ui.cancel": "Abbrechen",
  "editor.ui.srExternal":
    "Gegenüberstellung der neuesten Datei auf dem Datenträger und des lokalen Editor-Puffers. „Lokale Version behalten“ erhält Ihren Puffer; „Neu laden“ ersetzt ihn durch die Datei auf dem Datenträger.",
  "editor.ui.srRecovery":
    "Gegenüberstellung der Datei auf dem Datenträger und der wiederhergestellten ungespeicherten Änderungen. „Lokale Version behalten“ stellt die wiederhergestellten Änderungen her; „Datenträger-Version verwenden“ behält die Datei auf dem Datenträger.",
  "editor.ui.loadingFile": "Datei wird geladen…",
  "editor.ui.openDocuments": "Geöffnete Dokumente",
  "editor.ui.hiddenDocuments": "Ausgeblendete geöffnete Dokumente",
  "editor.ui.discardTitle": "Ungespeicherte Änderungen verwerfen?",
  "editor.ui.discardReload": "Verwerfen und neu laden",
  "editor.ui.recoveredDiskChanged":
    "Wiederhergestellte Editor-Änderungen sind verfügbar, und die Datei auf dem Datenträger hat sich geändert.",
  "editor.ui.recovered": "Wiederhergestellte ungespeicherte Editor-Änderungen sind verfügbar.",
  "editor.ui.restoreUnsaved": "Ungespeicherte Änderungen wiederherstellen",
  "editor.ui.discard": "Verwerfen",
  "editor.ui.reloadWarning":
    "Das Neuladen vom Datenträger ersetzt diesen Puffer durch die gespeicherte Datei und verwirft Ihre ungespeicherten Editor-Änderungen{location}.",
  "editor.ui.inFile": "in {file}",
  "editor.ui.unsavedTitle": "Ungespeicherte Editor-Änderungen",
  "editor.ui.unsavedHint":
    "Wählen Sie, wie mit diesen Dateien verfahren werden soll, bevor es weitergeht.",
  "editor.ui.saving": "Wird gespeichert...",
  "editor.ui.save": "Speichern",
  "editor.ui.splitControls": "Steuerung der Editor-Teilung",
  "editor.ui.splitRight": "{file} nach rechts teilen",
  "editor.ui.splitDown": "{file} nach unten teilen",
  "editor.ui.closeSplit": "Teilung {file} schließen",
  "editor.ui.editor": "Editor",
  "editor.ui.resizeSplit": "Editor-Teilung anpassen",
  "editor.ui.showTree": "Projektbaum anzeigen",
  "editor.ui.hideTree": "Projektbaum ausblenden",
  "editor.ui.files": "Editor-Dateien",
  "editor.ui.resizeTree": "Projektbaum anpassen",
  "editor.ui.breadcrumbs": "Editor-Brotkrümelnavigation",
  "editor.ui.fileSymbols": "Symbole der aktuellen Datei",
  "editor.ui.dropTab": "Tab ablegen: {zone}",
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
