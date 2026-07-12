"use client";

import { useMemo } from "react";
import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";
import settingsMessages from "./settings-i18n.messages.json";

type SettingsMessages = typeof settingsMessages;

export type SettingsMessageKey = keyof SettingsMessages;
export type I18nTranslate = (key: SettingsMessageKey, values?: MessageValues) => string;

function messageFor(locale: Locale, key: SettingsMessageKey): string {
  const message = settingsMessages[key];
  return message[locale] ?? message.en;
}

function interpolate(template: string, values: MessageValues = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function useSettingsTranslate(): I18nTranslate {
  const locale = useLocale();
  return useMemo<I18nTranslate>(() => {
    return (key, values) => interpolate(messageFor(locale, key), values);
  }, [locale]);
}
