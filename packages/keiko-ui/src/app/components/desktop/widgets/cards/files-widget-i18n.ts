import { useCallback } from "react";

import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

const EN_FILES_WIDGET_MESSAGES = {
  "git.change.modified": "Git modified: {path}",
  "git.change.added": "Git added: {path}",
  "git.change.deleted": "Git deleted: {path}",
  "git.change.renamed": "Git renamed: {path}",
  "git.change.copied": "Git copied: {path}",
  "git.change.untracked": "Git untracked: {path}",
  "git.change.conflicted": "Git conflict: {path}",
  "git.change.unknown": "Git changed: {path}",
  "git.folder.changed": "Folder contains {count} Git changes",
  "git.folder.conflicted": "Folder contains {count} Git changes, including conflicts",
  "git.folder.deleted": "Folder contains {count} Git changes, including deleted files",
  "git.ignored": "Ignored by Git",
  "git.decorationsIncomplete":
    "Git decorations incomplete: showing only the first {count} changes.",
} as const;

export type FilesWidgetMessageKey = keyof typeof EN_FILES_WIDGET_MESSAGES;
type FilesWidgetMessageCatalog = Readonly<Record<FilesWidgetMessageKey, string>>;

const DE_FILES_WIDGET_MESSAGES = {
  "git.change.modified": "Von Git geändert: {path}",
  "git.change.added": "Zu Git hinzugefügt: {path}",
  "git.change.deleted": "In Git gelöscht: {path}",
  "git.change.renamed": "In Git umbenannt: {path}",
  "git.change.copied": "In Git kopiert: {path}",
  "git.change.untracked": "Nicht von Git verfolgt: {path}",
  "git.change.conflicted": "Git-Konflikt: {path}",
  "git.change.unknown": "In Git geändert: {path}",
  "git.folder.changed": "Ordner enthält {count} Git-Änderungen",
  "git.folder.conflicted": "Ordner enthält {count} Git-Änderungen, einschließlich Konflikten",
  "git.folder.deleted": "Ordner enthält {count} Git-Änderungen, einschließlich gelöschter Dateien",
  "git.ignored": "Von Git ignoriert",
  "git.decorationsIncomplete":
    "Git-Dekorationen unvollständig: Nur die ersten {count} Änderungen werden angezeigt.",
} satisfies FilesWidgetMessageCatalog;

const FILES_WIDGET_MESSAGES: Record<Locale, FilesWidgetMessageCatalog> = {
  en: EN_FILES_WIDGET_MESSAGES,
  de: DE_FILES_WIDGET_MESSAGES,
};

export type FilesWidgetTranslate = (key: FilesWidgetMessageKey, values?: MessageValues) => string;

function formatFilesWidgetMessage(template: string, values: MessageValues = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function translateFilesWidget(
  locale: Locale,
  key: FilesWidgetMessageKey,
  values?: MessageValues,
): string {
  return formatFilesWidgetMessage(FILES_WIDGET_MESSAGES[locale][key], values);
}

export function useFilesWidgetTranslate(): FilesWidgetTranslate {
  const locale = useLocale();
  return useCallback(
    (key: FilesWidgetMessageKey, values?: MessageValues): string =>
      translateFilesWidget(locale, key, values),
    [locale],
  );
}
