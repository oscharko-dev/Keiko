"use client";

import { useCallback } from "react";
import { useLocale, type Locale, type MessageValues } from "./i18n";
import {
  OPTIONAL_WIDGET_EN_MESSAGES,
  type OptionalWidgetMessageCatalog,
  type OptionalWidgetMessageKey,
} from "./i18n-messages.optional.en";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "./i18n-messages.optional.de";

export type OptionalWidgetTranslate = (
  key: OptionalWidgetMessageKey,
  values?: MessageValues,
) => string;

function catalogFor(locale: Locale): OptionalWidgetMessageCatalog {
  return locale === "de" ? OPTIONAL_WIDGET_DE_MESSAGES : OPTIONAL_WIDGET_EN_MESSAGES;
}

export function translateOptionalWidget(
  locale: Locale,
  key: OptionalWidgetMessageKey,
  values: MessageValues = {},
): string {
  return catalogFor(locale)[key].replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function useOptionalWidgetTranslate(): OptionalWidgetTranslate {
  const locale = useLocale();
  return useCallback(
    (key: OptionalWidgetMessageKey, values?: MessageValues): string =>
      translateOptionalWidget(locale, key, values),
    [locale],
  );
}
