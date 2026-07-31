import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  I18N_STORAGE_KEY,
  I18nProvider,
  loadLocaleMessages,
  resetLoadedMessageCatalogs,
  resolveInitialLocale,
  resolveLocale,
  translate,
  useI18n,
  useSetLocale,
  useTranslate,
} from "./i18n";
import { ATTACHMENT_CLEANUP_DEFERRED_ERROR } from "./chat-session-error";
import { presentChatSessionError, translateOptionalWidget } from "./optional-widget-i18n";

const navigatorLanguageDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "language");

function setNavigatorLanguage(language: string): void {
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    value: language,
  });
}

function Probe(): ReactNode {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <p data-testid="locale">{locale}</p>
      <p data-testid="label">{t("settings.title")}</p>
      <button type="button" onClick={() => setLocale("de")}>
        German
      </button>
    </div>
  );
}

function TranslationProbe(): ReactNode {
  const t = useTranslate();
  return <p data-testid="split-label">{t("settings.title")}</p>;
}

function SetLocaleOnlyProbe(props: { readonly onRender: () => void }): ReactNode {
  const setLocale = useSetLocale();
  props.onRender();
  return (
    <button type="button" onClick={() => setLocale("de")}>
      Switch language
    </button>
  );
}

// Loaded catalogs live in i18n module scope, so any test that awaits the German catalog leaves it
// resolved for whatever runs next — and the lazy-transition test below asserts the synchronous state
// that only exists while German is still missing. Establish the precondition in `beforeEach` rather
// than in teardown: a test then depends on its own setup instead of on its predecessor's cleanup
// having run, which is what makes the assertion hold under any execution order.
beforeEach(() => {
  resetLoadedMessageCatalogs();
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-locale");
  if (navigatorLanguageDescriptor === undefined) {
    Reflect.deleteProperty(window.navigator, "language");
  } else {
    Object.defineProperty(window.navigator, "language", navigatorLanguageDescriptor);
  }
});

describe("resolveLocale", () => {
  it("keeps unsupported locales on the English baseline", () => {
    expect(resolveLocale("fr-FR")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
  });

  it("accepts German language tags", () => {
    expect(resolveLocale("de")).toBe("de");
    expect(resolveLocale("de-DE")).toBe("de");
    expect(resolveLocale("de_AT")).toBe("de");
  });

  it("uses the browser locale only when no explicit preference exists", () => {
    expect(resolveInitialLocale(null, "de-DE")).toBe("de");
    expect(resolveInitialLocale("en", "de-DE")).toBe("en");
    expect(resolveInitialLocale("fr-FR", "de-DE")).toBe(DEFAULT_LOCALE);
    expect(resolveInitialLocale(null, "fr-FR")).toBe(DEFAULT_LOCALE);
  });
});

describe("I18nProvider lazy catalog transition", () => {
  it("keeps locale and translated text on one catalog until German is ready", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("label")).toHaveTextContent("Settings");
    expect(document.documentElement.lang).toBe("en");
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("de");
    await waitFor(() => {
      expect(screen.getByTestId("locale")).toHaveTextContent("de");
      expect(screen.getByTestId("label")).toHaveTextContent("Einstellungen");
      expect(document.documentElement.lang).toBe("de");
    });
  });
});

describe("translate", () => {
  it("interpolates named values from the default catalog", () => {
    expect(translate("en", "workspace.selection.many", { count: 3 })).toBe(
      "3 workspace windows selected",
    );
  });

  it("loads the non-default catalog on demand", async () => {
    await expect(loadLocaleMessages("de")).resolves.toBeTruthy();
    expect(translate("de", "workspace.selection.many", { count: 3 })).toBe(
      "3 Arbeitsbereichsfenster ausgewählt",
    );
  });

  it("translates the remediated widget surfaces from the German catalog", async () => {
    await loadLocaleMessages("de");

    expect(translateOptionalWidget("de", "quickAccess.title")).toBe("Schnellzugriff");
    expect(translateOptionalWidget("de", "browserWidget.action.open")).toBe("Sitzung öffnen");
    expect(translateOptionalWidget("de", "documentationBrowser.action.prepareIndexing")).toBe(
      "Indizierung vorbereiten",
    );
    expect(translateOptionalWidget("de", "gitDelivery.state.ready-to-execute")).toBe(
      "Bereit zur Ausführung",
    );
    expect(translateOptionalWidget("de", "promptEnhancer.action.enhance")).toBe(
      "Prompt verbessern",
    );
    expect(
      translateOptionalWidget("de", "terminalWidget.result.finished", {
        code: 0,
        duration: 12,
        truncated: "",
        timedOut: "",
      }),
    ).toBe("Befehl abgeschlossen: Exit-Code 0, 12 ms");
  });

  it("presents content-free chat session errors in both locales", () => {
    expect(
      presentChatSessionError(ATTACHMENT_CLEANUP_DEFERRED_ERROR, (key, values) =>
        translateOptionalWidget("en", key, values),
      ),
    ).toBe(
      "The image was delivered. Its encrypted local copy could not be removed now and will expire automatically.",
    );
    expect(
      presentChatSessionError(ATTACHMENT_CLEANUP_DEFERRED_ERROR, (key, values) =>
        translateOptionalWidget("de", key, values),
      ),
    ).toBe(
      "Das Bild wurde übertragen. Die verschlüsselte lokale Kopie konnte jetzt nicht entfernt werden und läuft automatisch ab.",
    );
    expect(
      presentChatSessionError("opaque-session-error", (key, values) =>
        translateOptionalWidget("en", key, values),
      ),
    ).toBe("opaque-session-error");
    expect(
      presentChatSessionError(undefined, (key, values) =>
        translateOptionalWidget("en", key, values),
      ),
    ).toBeUndefined();
  });
});

describe("I18nProvider", () => {
  it("uses a supported browser language when no user locale has been stored", async () => {
    setNavigatorLanguage("de-DE");

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("label")).toHaveTextContent("Einstellungen"));
    expect(screen.getByTestId("locale")).toHaveTextContent("de");
    expect(document.documentElement.lang).toBe("de");
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("de");
  });

  it("keeps an explicit English preference authoritative in a German browser", () => {
    setNavigatorLanguage("de-DE");
    window.localStorage.setItem(I18N_STORAGE_KEY, "en");

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId("label")).toHaveTextContent("Settings");
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(document.documentElement.lang).toBe("en");
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("en");
  });

  it("uses the stored locale, updates document metadata, and persists changes", async () => {
    // A precondition, not decoration. This test is about resolution, document metadata and
    // persistence with a catalog that is already available, so it has to say so: `I18nProvider`
    // renders the English baseline until the requested catalog resolves, and the synchronous "de"
    // assertions below describe only the warm case. The cold case belongs to the lazy-transition
    // test above. Before the module reset seam existed this line was unnecessary purely by
    // accident — some earlier test had usually warmed the catalog already.
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de-DE");

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId("locale")).toHaveTextContent("de");
    await waitFor(() => expect(screen.getByTestId("label")).toHaveTextContent("Einstellungen"));
    expect(document.documentElement.lang).toBe("de");
    expect(document.documentElement.dataset.locale).toBe("de");
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("de");
  });

  it("persists user language changes immediately and applies the catalog when ready", async () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId("label")).toHaveTextContent("Settings");

    fireEvent.click(screen.getByRole("button", { name: "German" }));

    // These three were inverted from "de" to the English baseline. The old expectation was not the
    // product's behaviour on a cold catalog at all — it passed only when some earlier test had
    // already resolved German into module scope, which the reset seam now prevents. With a cold
    // catalog the provider deliberately splits the two halves this test is named after: the
    // preference is persisted at once, while the rendered locale and the document language stay on
    // the English baseline until the catalog arrives. Asserting that split — and then asserting the
    // flip below — is strictly more than the old version checked, which only ever saw one state.
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(document.documentElement.lang).toBe("en");
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("de");

    await waitFor(() => expect(screen.getByTestId("label")).toHaveTextContent("Einstellungen"));
    expect(screen.getByTestId("locale")).toHaveTextContent("de");
    expect(document.documentElement.lang).toBe("de");
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("de");
  });

  it("keeps locale setter consumers stable when only translated text changes", async () => {
    let setterRenders = 0;
    render(
      <I18nProvider>
        <SetLocaleOnlyProbe
          onRender={() => {
            setterRenders += 1;
          }}
        />
        <TranslationProbe />
      </I18nProvider>,
    );

    expect(screen.getByTestId("split-label")).toHaveTextContent("Settings");
    expect(setterRenders).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));

    await waitFor(() =>
      expect(screen.getByTestId("split-label")).toHaveTextContent("Einstellungen"),
    );
    expect(setterRenders).toBe(1);
  });
});
