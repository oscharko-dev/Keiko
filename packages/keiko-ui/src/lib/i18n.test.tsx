import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  I18N_STORAGE_KEY,
  I18nProvider,
  loadLocaleMessages,
  resolveLocale,
  translate,
  useI18n,
  useSetLocale,
  useTranslate,
} from "./i18n";

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

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-locale");
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
});

describe("I18nProvider", () => {
  it("uses the stored locale, updates document metadata, and persists changes", async () => {
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

    expect(screen.getByTestId("locale")).toHaveTextContent("de");
    expect(document.documentElement.lang).toBe("de");
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("de");
    await waitFor(() => expect(screen.getByTestId("label")).toHaveTextContent("Einstellungen"));
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
