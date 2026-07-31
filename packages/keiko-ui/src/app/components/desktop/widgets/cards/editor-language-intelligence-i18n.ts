/**
 * Wording for the editor's language-intelligence status field.
 *
 * The editor package classifies each bridge outcome (`ok` / `empty` / `capped` / `failed`) but owns no
 * user-facing text — exactly like the merge-conflict and Git-gutter labels. This catalog supplies the
 * localized sentence for the one honest status the surface shows, so a failed hover, a timed-out
 * diagnostics run and a capped reference search stop rendering as "nothing found".
 *
 * Every operation has its own noun so the message names the surface the user actually invoked; the
 * `.more` variants cover several simultaneously affected surfaces without listing them all.
 */
import { useCallback } from "react";

import type {
  EditorLanguageIntelligenceNotice,
  EditorLanguageOperation,
  EditorStatusLanguageIntelligence,
} from "@oscharko-dev/keiko-editor";

import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

const EN_MESSAGES = {
  "operation.completion": "Completions",
  "operation.inline-completion": "Inline suggestions",
  "operation.hover": "Quick info",
  "operation.symbols": "Outline",
  "operation.formatting": "Formatting",
  "operation.definition": "Go to definition",
  "operation.type-definition": "Go to type definition",
  "operation.implementation": "Go to implementation",
  "operation.references": "Find references",
  "operation.code-actions": "Quick fixes",
  "operation.signature-help": "Parameter hints",
  "operation.inlay-hints": "Inlay hints",
  "operation.call-hierarchy": "Call hierarchy",
  "operation.diagnostics": "Problems",
  "failed.one": "{operation} unavailable",
  "failed.more": "{operation} and {others} more unavailable",
  "failed.oneAria": "{operation} did not answer. Results shown may be incomplete or absent.",
  "failed.moreAria":
    "{operation} and {others} more language features did not answer. Results shown may be incomplete or absent.",
  "capped.one": "{operation} partial",
  "capped.more": "{operation} and {others} more partial",
  "capped.oneAria": "{operation} returned a partial result because a result limit was reached.",
  "capped.moreAria":
    "{operation} and {others} more language features returned partial results because a result limit was reached.",
} as const;

export type EditorLanguageIntelligenceMessageKey = keyof typeof EN_MESSAGES;
type MessageCatalog = Readonly<Record<EditorLanguageIntelligenceMessageKey, string>>;

const DE_MESSAGES = {
  "operation.completion": "Vervollständigungen",
  "operation.inline-completion": "Inline-Vorschläge",
  "operation.hover": "Kurzinfo",
  "operation.symbols": "Gliederung",
  "operation.formatting": "Formatierung",
  "operation.definition": "Zur Definition",
  "operation.type-definition": "Zur Typdefinition",
  "operation.implementation": "Zur Implementierung",
  "operation.references": "Verweise suchen",
  "operation.code-actions": "Schnellkorrekturen",
  "operation.signature-help": "Parameterhinweise",
  "operation.inlay-hints": "Inline-Hinweise",
  "operation.call-hierarchy": "Aufrufhierarchie",
  "operation.diagnostics": "Probleme",
  "failed.one": "{operation} nicht verfügbar",
  "failed.more": "{operation} und {others} weitere nicht verfügbar",
  "failed.oneAria":
    "{operation} hat nicht geantwortet. Angezeigte Ergebnisse können unvollständig oder nicht vorhanden sein.",
  "failed.moreAria":
    "{operation} und {others} weitere Sprachfunktionen haben nicht geantwortet. Angezeigte Ergebnisse können unvollständig oder nicht vorhanden sein.",
  "capped.one": "{operation} unvollständig",
  "capped.more": "{operation} und {others} weitere unvollständig",
  "capped.oneAria":
    "{operation} hat ein unvollständiges Ergebnis geliefert, weil eine Ergebnisgrenze erreicht wurde.",
  "capped.moreAria":
    "{operation} und {others} weitere Sprachfunktionen haben unvollständige Ergebnisse geliefert, weil eine Ergebnisgrenze erreicht wurde.",
} satisfies MessageCatalog;

const MESSAGES: Record<Locale, MessageCatalog> = { en: EN_MESSAGES, de: DE_MESSAGES };

function format(template: string, values: MessageValues = {}): string {
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function translateEditorLanguageIntelligence(
  locale: Locale,
  key: EditorLanguageIntelligenceMessageKey,
  values?: MessageValues,
): string {
  return format(MESSAGES[locale][key], values);
}

export type EditorLanguageIntelligenceTranslate = (
  key: EditorLanguageIntelligenceMessageKey,
  values?: MessageValues,
) => string;

export function useEditorLanguageIntelligenceTranslate(): EditorLanguageIntelligenceTranslate {
  const locale = useLocale();
  return useCallback(
    (key: EditorLanguageIntelligenceMessageKey, values?: MessageValues): string =>
      translateEditorLanguageIntelligence(locale, key, values),
    [locale],
  );
}

/** The catalog key naming one Monaco language-intelligence surface. */
export function operationMessageKey(
  operation: EditorLanguageOperation,
): EditorLanguageIntelligenceMessageKey {
  return `operation.${operation}`;
}

/**
 * Turn the editor-derived notice into the localized status-bar field, or `undefined` when every
 * observed operation answered in full. The editor decides *whether* and *what* to say; this decides
 * *how* it reads in the active locale.
 */
export function editorLanguageIntelligenceStatus(
  notice: EditorLanguageIntelligenceNotice | null,
  t: EditorLanguageIntelligenceTranslate,
): EditorStatusLanguageIntelligence | undefined {
  if (notice === null) return undefined;
  const others = notice.operationCount - 1;
  const suffix = others > 0 ? "more" : "one";
  const values = { operation: t(operationMessageKey(notice.operation)), others };
  return {
    status: notice.status,
    label: t(`${notice.status}.${suffix}`, values),
    ariaLabel: t(`${notice.status}.${suffix}Aria`, values),
  };
}
