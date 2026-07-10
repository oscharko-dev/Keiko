"use client";

import { useCallback } from "react";

import { useLocale, type MessageValues } from "@/lib/i18n";

import { FEEDBACK_DE_MESSAGES } from "./feedback-i18n-messages.de";
import { FEEDBACK_EN_MESSAGES, type FeedbackMessageKey } from "./feedback-i18n-messages.en";

export type FeedbackTranslate = (key: FeedbackMessageKey, values?: MessageValues) => string;

function interpolate(template: string, values: MessageValues): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function translateFeedback(
  locale: "en" | "de",
  key: FeedbackMessageKey,
  values: MessageValues = {},
): string {
  const catalog = locale === "de" ? FEEDBACK_DE_MESSAGES : FEEDBACK_EN_MESSAGES;
  return interpolate(catalog[key] ?? FEEDBACK_EN_MESSAGES[key], values);
}

export function useFeedbackTranslate(): FeedbackTranslate {
  const locale = useLocale();
  return useCallback((key, values) => translateFeedback(locale, key, values), [locale]);
}
