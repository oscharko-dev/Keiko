import { useCallback } from "react";

import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

// Issue #2213 (Epic #2092, ADR-0126) — Problems panel message catalog. Mirrors editor-agent-i18n.ts:
// EN/DE catalogs, a `satisfies`-checked German catalog, dotted keys, `{placeholder}` interpolation.
const EN_PROBLEMS_MESSAGES = {
  "problems.panelLabel": "Problems",
  "problems.title": "Problems",
  "problems.filterGroup": "Filter problems",
  "problems.filter.severity": "Severity",
  "problems.filter.source": "Source",
  "problems.severity.all": "All severities",
  "problems.severity.error": "Errors",
  "problems.severity.warning": "Warnings",
  "problems.severity.info": "Info",
  "problems.source.all": "All sources",
  "problems.source.diagnostic": "Diagnostics",
  "problems.source.verification": "Verification",
  "problems.empty": "No problems in the currently open files.",
  "problems.noMatch": "No problems match the current filter.",
  "problems.truncated": "Showing {shown} of {total}.",
  "problems.openFilesOnly": "Language diagnostics cover currently open files only.",
  "problems.jumpTo": "Open {file} at line {line}",
  "problems.noLocation": "No location available",
} as const;

export type ProblemsMessageKey = keyof typeof EN_PROBLEMS_MESSAGES;
type ProblemsMessageCatalog = Readonly<Record<ProblemsMessageKey, string>>;

const DE_PROBLEMS_MESSAGES = {
  "problems.panelLabel": "Probleme",
  "problems.title": "Probleme",
  "problems.filterGroup": "Probleme filtern",
  "problems.filter.severity": "Schweregrad",
  "problems.filter.source": "Quelle",
  "problems.severity.all": "Alle Schweregrade",
  "problems.severity.error": "Fehler",
  "problems.severity.warning": "Warnungen",
  "problems.severity.info": "Info",
  "problems.source.all": "Alle Quellen",
  "problems.source.diagnostic": "Diagnosen",
  "problems.source.verification": "Verifikation",
  "problems.empty": "Keine Probleme in den aktuell geöffneten Dateien.",
  "problems.noMatch": "Keine Probleme entsprechen dem aktuellen Filter.",
  "problems.truncated": "Zeige {shown} von {total}.",
  "problems.openFilesOnly": "Sprachdiagnosen decken nur aktuell geöffnete Dateien ab.",
  "problems.jumpTo": "{file} in Zeile {line} öffnen",
  "problems.noLocation": "Kein Ort verfügbar",
} satisfies ProblemsMessageCatalog;

const PROBLEMS_MESSAGES: Record<Locale, ProblemsMessageCatalog> = {
  en: EN_PROBLEMS_MESSAGES,
  de: DE_PROBLEMS_MESSAGES,
};

export type ProblemsTranslate = (key: ProblemsMessageKey, values?: MessageValues) => string;

function formatProblemsMessage(template: string, values: MessageValues = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function translateProblems(
  locale: Locale,
  key: ProblemsMessageKey,
  values?: MessageValues,
): string {
  return formatProblemsMessage(PROBLEMS_MESSAGES[locale][key], values);
}

export function useProblemsTranslate(): ProblemsTranslate {
  const locale = useLocale();
  return useCallback(
    (key: ProblemsMessageKey, values?: MessageValues): string =>
      translateProblems(locale, key, values),
    [locale],
  );
}
