import { useCallback } from "react";

import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";
import {
  EN_CODING_WORKBENCH_MESSAGES,
  type CodingWorkbenchMessageCatalog,
  type CodingWorkbenchMessageKey,
} from "./coding-workbench-i18n.en";
import { DE_CODING_WORKBENCH_MESSAGES } from "./coding-workbench-i18n.de";

// Issue #2257 — Coding Workbench is registered through next/dynamic. Keep its feature-only
// catalog beside that boundary so the workspace shell does not preload these strings.
const CODING_WORKBENCH_MESSAGES: Record<Locale, CodingWorkbenchMessageCatalog> = {
  en: EN_CODING_WORKBENCH_MESSAGES,
  de: DE_CODING_WORKBENCH_MESSAGES,
};

export type CodingWorkbenchTranslate = (
  key: CodingWorkbenchMessageKey,
  values?: MessageValues,
) => string;

function formatCodingWorkbenchMessage(template: string, values: MessageValues = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function translateCodingWorkbench(
  locale: Locale,
  key: CodingWorkbenchMessageKey,
  values?: MessageValues,
): string {
  return formatCodingWorkbenchMessage(CODING_WORKBENCH_MESSAGES[locale][key], values);
}

export function useCodingWorkbenchTranslate(): CodingWorkbenchTranslate {
  const locale = useLocale();
  return useCallback(
    (key: CodingWorkbenchMessageKey, values?: MessageValues): string =>
      translateCodingWorkbench(locale, key, values),
    [locale],
  );
}
