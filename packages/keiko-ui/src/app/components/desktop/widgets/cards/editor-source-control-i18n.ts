import { useCallback } from "react";

import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

const EN_MESSAGES = {
  "gitGutter.staged": "Staged change",
  "gitGutter.unstaged": "Unstaged change",
  "gitGutter.added": "Added",
  "gitGutter.modified": "Modified",
  "gitGutter.deleted": "Deleted",
  "gitGutter.openHunk": "Open change hunk",
  "gitGutter.peekTitle": "Change preview",
  "gitGutter.closePeek": "Close change preview",
  "gitGutter.truncated": "This hunk was truncated by the bounded Git read.",
  "gitGutter.refresh": "Changes",
  "gitGutter.refreshLabel": "Refresh editor change indicators",
  "gitGutter.hunkHeader": "Hunk header",
  "gitGutter.addedLine": "Added line",
  "gitGutter.deletedLine": "Deleted line",
  "gitGutter.contextLine": "Context line",
  "gitGutter.metadataLine": "Diff metadata",
  "blame.toggle": "Toggle line blame",
  "blame.openCommit": "Open line commit in Git",
  "blame.dirtyNotice": "Blame reflects HEAD; unsaved changes are not included.",
  "blame.truncated": "More blame lines are unavailable because the bounded read was truncated.",
  "blame.line": "{author}, {age}, commit {commit}",
  "gitDiff.open": "Open diff",
  "gitDiff.openLabel": "Show this file's diff in Git",
  "conflicts.next": "Go to next merge conflict",
  "conflicts.previous": "Go to previous merge conflict",
  "conflicts.ours": "Accept current change",
  "conflicts.theirs": "Accept incoming change",
  "conflicts.both": "Accept both changes",
  "conflicts.stale": "The conflict changed. Review the updated block and try again.",
  "conflicts.status": "{count} conflicts",
  "conflicts.statusAria": "{count} merge conflicts",
} as const;

export type EditorSourceControlMessageKey = keyof typeof EN_MESSAGES;
type MessageCatalog = Readonly<Record<EditorSourceControlMessageKey, string>>;

const DE_MESSAGES = {
  "gitGutter.staged": "Vorgemerkte Änderung",
  "gitGutter.unstaged": "Nicht vorgemerkte Änderung",
  "gitGutter.added": "Hinzugefügt",
  "gitGutter.modified": "Geändert",
  "gitGutter.deleted": "Gelöscht",
  "gitGutter.openHunk": "Änderungsabschnitt öffnen",
  "gitGutter.peekTitle": "Änderungsvorschau",
  "gitGutter.closePeek": "Änderungsvorschau schließen",
  "gitGutter.truncated": "Dieser Abschnitt wurde durch den begrenzten Git-Lesezugriff gekürzt.",
  "gitGutter.refresh": "Änderungen",
  "gitGutter.refreshLabel": "Änderungsmarkierungen im Editor aktualisieren",
  "gitGutter.hunkHeader": "Abschnittskopf",
  "gitGutter.addedLine": "Hinzugefügte Zeile",
  "gitGutter.deletedLine": "Gelöschte Zeile",
  "gitGutter.contextLine": "Kontextzeile",
  "gitGutter.metadataLine": "Diff-Metadaten",
  "blame.toggle": "Zeilenherkunft ein-/ausblenden",
  "blame.openCommit": "Zeilen-Commit in Git öffnen",
  "blame.dirtyNotice":
    "Die Zeilenherkunft bezieht sich auf HEAD; ungespeicherte Änderungen sind nicht enthalten.",
  "blame.truncated":
    "Weitere Zeilen sind nicht verfügbar, weil der begrenzte Lesezugriff gekürzt wurde.",
  "blame.line": "{author}, {age}, Commit {commit}",
  "gitDiff.open": "Diff öffnen",
  "gitDiff.openLabel": "Diff dieser Datei in Git anzeigen",
  "conflicts.next": "Zum nächsten Merge-Konflikt",
  "conflicts.previous": "Zum vorherigen Merge-Konflikt",
  "conflicts.ours": "Aktuelle Änderung übernehmen",
  "conflicts.theirs": "Eingehende Änderung übernehmen",
  "conflicts.both": "Beide Änderungen übernehmen",
  "conflicts.stale": "Der Konflikt wurde geändert. Prüfe den aktualisierten Block erneut.",
  "conflicts.status": "{count} Konflikte",
  "conflicts.statusAria": "{count} Merge-Konflikte",
} satisfies MessageCatalog;

const MESSAGES: Record<Locale, MessageCatalog> = { en: EN_MESSAGES, de: DE_MESSAGES };

function format(template: string, values: MessageValues = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function useEditorSourceControlTranslate(): (
  key: EditorSourceControlMessageKey,
  values?: MessageValues,
) => string {
  const locale = useLocale();
  return useCallback(
    (key: EditorSourceControlMessageKey, values?: MessageValues): string =>
      translateEditorSourceControl(locale, key, values),
    [locale],
  );
}

export function translateEditorSourceControl(
  locale: Locale,
  key: EditorSourceControlMessageKey,
  values?: MessageValues,
): string {
  return format(MESSAGES[locale][key], values);
}
