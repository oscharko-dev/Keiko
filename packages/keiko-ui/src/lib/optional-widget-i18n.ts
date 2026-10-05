"use client";

import { useCallback, useEffect, useReducer } from "react";
import { translate, useLocale, type Locale, type MessageValues } from "./i18n";
import type { MessageKey } from "./i18n-messages.en";
import {
  OPTIONAL_WIDGET_EN_MESSAGES,
  type OptionalWidgetMessageCatalog,
  type OptionalWidgetMessageKey,
} from "./i18n-messages.optional.en";
import { chatSessionErrorPresentation } from "./chat-session-error";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorEvidence } from "./client-error-evidence";

export type WidgetMessageKey = OptionalWidgetMessageKey | MessageKey;

export type OptionalWidgetTranslate = (key: WidgetMessageKey, values?: MessageValues) => string;

let germanCatalog: OptionalWidgetMessageCatalog | undefined;
let germanLoad: Promise<OptionalWidgetMessageCatalog> | undefined;

function catalogFor(locale: Locale): OptionalWidgetMessageCatalog {
  return locale === "de"
    ? (germanCatalog ?? OPTIONAL_WIDGET_EN_MESSAGES)
    : OPTIONAL_WIDGET_EN_MESSAGES;
}

export function loadOptionalWidgetMessages(locale: Locale): Promise<OptionalWidgetMessageCatalog> {
  if (locale === "en") return Promise.resolve(OPTIONAL_WIDGET_EN_MESSAGES);
  if (germanCatalog !== undefined) return Promise.resolve(germanCatalog);
  germanLoad ??= import("./i18n-messages.optional.de")
    .then((module) => {
      germanCatalog = module.OPTIONAL_WIDGET_DE_MESSAGES;
      return germanCatalog;
    })
    .catch((error: unknown) => {
      germanLoad = undefined;
      reportClientDiagnostic("widget-locale-load-failed", {
        kind: "other",
        errorEvidence: clientErrorEvidence(error),
      });
      return OPTIONAL_WIDGET_EN_MESSAGES;
    });
  return germanLoad;
}

/** Restore the product's English-only first-load state for isolated locale tests. */
export function resetLoadedOptionalWidgetMessages(): void {
  germanCatalog = undefined;
  germanLoad = undefined;
}

export function translateOptionalWidget(
  locale: Locale,
  key: WidgetMessageKey,
  values: MessageValues = {},
): string {
  return translateWithCatalog(catalogFor(locale), locale, key, values);
}

function translateWithCatalog(
  catalog: OptionalWidgetMessageCatalog,
  locale: Locale,
  key: WidgetMessageKey,
  values: MessageValues = {},
): string {
  if (!isOptionalWidgetKey(key)) return translate(locale, key, values);
  return catalog[key].replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

function isOptionalWidgetKey(key: WidgetMessageKey): key is OptionalWidgetMessageKey {
  return Object.hasOwn(OPTIONAL_WIDGET_EN_MESSAGES, key);
}

export function useOptionalWidgetTranslate(): OptionalWidgetTranslate {
  const locale = useLocale();
  const [, refreshCatalog] = useReducer((version: number): number => version + 1, 0);
  useEffect(() => {
    let cancelled = false;
    const previousCatalog = catalogFor(locale);
    void loadOptionalWidgetMessages(locale).then((loaded) => {
      if (!cancelled && loaded !== previousCatalog) refreshCatalog();
    });
    return (): void => {
      cancelled = true;
    };
  }, [locale]);
  return useCallback(
    (key: WidgetMessageKey, values?: MessageValues): string =>
      translateOptionalWidget(locale, key, values),
    [locale],
  );
}

export function presentChatSessionError(
  error: string | undefined,
  t: OptionalWidgetTranslate,
): string | undefined {
  const presentation = chatSessionErrorPresentation(error);
  switch (presentation.kind) {
    case "none":
      return undefined;
    case "attachment-cleanup-deferred":
      return t("attachment.cleanupDeferred");
    case "message":
      return presentation.message;
  }
}
