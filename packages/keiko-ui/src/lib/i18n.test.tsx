import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  I18N_STORAGE_KEY,
  I18nProvider,
  resolveLocale,
  translate,
  useI18n,
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

describe("translate", () => {
  it("interpolates named values", () => {
    expect(translate("en", "settings.models.modelCount", { count: 3 })).toBe("3 models");
    expect(translate("de", "settings.models.modelCount", { count: 3 })).toBe("3 Modelle");
  });
});

describe("I18nProvider", () => {
  it("uses the stored locale, updates document metadata, and persists changes", () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de-DE");

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId("locale")).toHaveTextContent("de");
    expect(screen.getByTestId("label")).toHaveTextContent("Einstellungen");
    expect(document.documentElement.lang).toBe("de");
    expect(document.documentElement.dataset.locale).toBe("de");
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("de");
  });

  it("applies user language changes immediately", () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId("label")).toHaveTextContent("Settings");

    fireEvent.click(screen.getByRole("button", { name: "German" }));

    expect(screen.getByTestId("label")).toHaveTextContent("Einstellungen");
    expect(document.documentElement.lang).toBe("de");
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("de");
  });
});
