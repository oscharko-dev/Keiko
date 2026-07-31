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

const SUPPORTED_LOCALES = ["en", "de"] as const;
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

// The baseline a freshly loaded module starts from: English is bundled, every other locale arrives
// lazily. Kept as a factory so the test seam below can restore it without a dynamic `delete`.
function englishOnlyCatalogs(): Partial<Record<Locale, MessageCatalog>> {
  return { en: EN_MESSAGES };
}

let loadedMessageCatalogs = englishOnlyCatalogs();

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
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
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

/**
 * Drop every lazily loaded catalog and in-flight load, restoring the English-only baseline.
 * Tests use this; product code does not.
 *
 * WHY this seam exists: the two stores above are module state, and `I18nProvider` reads them
 * synchronously on its very first render (`activeLocale = ready && catalogReady ? locale : …`). So a
 * test that resolves the German catalog silently changes what a later, `de`-seeded provider renders
 * on that first pass — the English transition state simply stops existing. No storage or DOM
 * teardown can reach this, which is why the reset has to be offered by the module that owns it
 * rather than reconstructed per test file.
 */
export function resetLoadedMessageCatalogs(): void {
  loadedMessageCatalogs = englishOnlyCatalogs();
  catalogLoads.clear();
}

export function resolveLocale(input: string | null | undefined): Locale {
  if (input === null || input === undefined) return DEFAULT_LOCALE;
  const normalized = input.trim().toLowerCase().replaceAll("_", "-");
  if (normalized.length === 0) return DEFAULT_LOCALE;
  if (normalized === "de" || normalized.startsWith("de-")) return "de";
  return DEFAULT_LOCALE;
}

export function resolveInitialLocale(
  storedLocale: string | null,
  browserLocale: string | null | undefined,
): Locale {
  return resolveLocale(storedLocale ?? browserLocale);
}

export function translate(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  return translateFromCatalog(messageCatalogFor(locale), key, values);
}

function readBrowserLocale(): string | undefined {
  try {
    return window.navigator.language;
  } catch {
    return undefined;
  }
}

function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const browserLocale = readBrowserLocale();
  try {
    return resolveInitialLocale(window.localStorage.getItem(I18N_STORAGE_KEY), browserLocale);
  } catch {
    return resolveLocale(browserLocale);
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
  const catalogReady = isLocaleReady(locale);
  const activeLocale = ready && catalogReady ? locale : DEFAULT_LOCALE;
  const localeLoadState = useMemo(() => ({ catalogReady, locale }), [catalogReady, locale]);

  useEffect(() => {
    applyDocumentLocale(activeLocale);
    persistLocale(locale);
  }, [activeLocale, locale]);

  useEffect(() => {
    const requestedLocale = localeLoadState.locale;
    if (localeLoadState.catalogReady) {
      if (!ready) {
        setState((current) =>
          current.locale === requestedLocale ? { locale: current.locale, ready: true } : current,
        );
      }
      return;
    }
    let cancelled = false;
    void loadLocaleMessages(requestedLocale)
      .catch(() => EN_MESSAGES)
      .then(() => {
        if (cancelled) return;
        setState((current) =>
          current.locale === requestedLocale ? { locale: current.locale, ready: true } : current,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [localeLoadState, ready]);

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
