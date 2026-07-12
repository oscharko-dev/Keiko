"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { EN_MESSAGES, type MessageCatalog, type MessageKey } from "./i18n-messages.en";

export const I18N_STORAGE_KEY = "keiko.locale";

export const SUPPORTED_LOCALES = ["en", "de"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
};

export type MessageValues = Readonly<Record<string, string | number>>;
export type I18nTranslate = (key: MessageKey, values?: MessageValues) => string;

type I18nState = {
  readonly locale: Locale;
  readonly ready: boolean;
};

const loadedMessageCatalogs: Partial<Record<Locale, MessageCatalog>> = {
  en: EN_MESSAGES,
};

const catalogLoads = new Map<Locale, Promise<MessageCatalog>>();

function messageCatalogFor(locale: Locale): MessageCatalog {
  return loadedMessageCatalogs[locale] ?? EN_MESSAGES;
}

function translateFromCatalog(
  catalog: MessageCatalog,
  key: MessageKey,
  values: MessageValues = {},
): string {
  const template = catalog[key] ?? EN_MESSAGES[key];
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

function isLocaleReady(locale: Locale): boolean {
  return loadedMessageCatalogs[locale] !== undefined;
}

export function loadLocaleMessages(locale: Locale): Promise<MessageCatalog> {
  const loaded = loadedMessageCatalogs[locale];
  if (loaded !== undefined) return Promise.resolve(loaded);
  const inflight = catalogLoads.get(locale);
  if (inflight !== undefined) return inflight;
  const promise = import("./i18n-messages.de").then((module) => {
    loadedMessageCatalogs.de = module.DE_MESSAGES;
    return module.DE_MESSAGES;
  });
  catalogLoads.set(locale, promise);
  return promise;
}

export function resolveLocale(input: string | null | undefined): Locale {
  if (input === null || input === undefined) return DEFAULT_LOCALE;
  const normalized = input.trim().toLowerCase().replace(/_/gu, "-");
  if (normalized.length === 0) return DEFAULT_LOCALE;
  if (normalized === "de" || normalized.startsWith("de-")) return "de";
  return DEFAULT_LOCALE;
}

export function translate(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  return translateFromCatalog(messageCatalogFor(locale), key, values);
}

function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    return resolveLocale(window.localStorage.getItem(I18N_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

function persistLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(I18N_STORAGE_KEY, locale);
  } catch {
    /* ignore quota / private mode */
  }
}

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
}

interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: I18nTranslate;
}

const FALLBACK_CONTEXT: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  t: (key, values) => translate(DEFAULT_LOCALE, key, values),
};

const LocaleContext = createContext<Locale>(FALLBACK_CONTEXT.locale);
const SetLocaleContext = createContext<(locale: Locale) => void>(FALLBACK_CONTEXT.setLocale);
const TranslateContext = createContext<I18nTranslate>(FALLBACK_CONTEXT.t);

export function I18nProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [state, setState] = useState<I18nState>(() => {
    const locale = readStoredLocale();
    return { locale, ready: isLocaleReady(locale) };
  });
  const { locale, ready } = state;
  const activeLocale = ready ? locale : DEFAULT_LOCALE;

  useEffect(() => {
    applyDocumentLocale(activeLocale);
    persistLocale(locale);
  }, [activeLocale, locale]);

  useEffect(() => {
    if (ready || isLocaleReady(locale)) {
      if (!ready) {
        setState((current) =>
          current.locale === locale ? { locale: current.locale, ready: true } : current,
        );
      }
      return;
    }
    let cancelled = false;
    void loadLocaleMessages(locale)
      .catch(() => EN_MESSAGES)
      .then(() => {
        if (cancelled) return;
        setState((current) =>
          current.locale === locale ? { locale: current.locale, ready: true } : current,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [locale, ready]);

  const setLocale = useCallback((next: Locale): void => {
    setState((current) => {
      const nextReady = isLocaleReady(next);
      if (current.locale === next && current.ready === nextReady) return current;
      return { locale: next, ready: nextReady };
    });
  }, []);

  const catalog = messageCatalogFor(locale);
  const t = useCallback(
    (key: MessageKey, values?: MessageValues): string => translateFromCatalog(catalog, key, values),
    [catalog],
  );

  return (
    <LocaleContext.Provider value={activeLocale}>
      <SetLocaleContext.Provider value={setLocale}>
        <TranslateContext.Provider value={t}>{children}</TranslateContext.Provider>
      </SetLocaleContext.Provider>
    </LocaleContext.Provider>
  );
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useSetLocale(): (locale: Locale) => void {
  return useContext(SetLocaleContext);
}

export function useTranslate(): I18nTranslate {
  return useContext(TranslateContext);
}

export function useI18n(): I18nContextValue {
  const locale = useLocale();
  const setLocale = useSetLocale();
  const t = useTranslate();
  return useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
}
