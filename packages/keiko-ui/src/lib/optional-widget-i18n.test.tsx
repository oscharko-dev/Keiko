import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EN_MESSAGES } from "./i18n-messages.en";
import { DE_MESSAGES } from "./i18n-messages.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "./i18n-messages.optional.en";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "./i18n-messages.optional.de";
import { I18nProvider, loadLocaleMessages, resetLoadedMessageCatalogs, useSetLocale } from "./i18n";
import {
  translateOptionalWidget,
  useOptionalWidgetTranslate,
  loadOptionalWidgetMessages,
} from "./optional-widget-i18n";

function WidgetProbe(): ReactNode {
  const t = useOptionalWidgetTranslate();
  const setLocale = useSetLocale();
  const [clicks, setClicks] = useState(0);
  return (
    <>
      <button type="button" aria-label={t("common.close")} onClick={() => setClicks(clicks + 1)}>
        {t("memoria.approve")}
      </button>
      <p>{t("managedLanguage.title")}</p>
      <output aria-label="Clicks">{clicks}</output>
      <button type="button" onClick={() => setLocale("de")}>
        German
      </button>
    </>
  );
}

beforeEach(() => {
  resetLoadedMessageCatalogs();
  window.localStorage.setItem("keiko.locale", "en");
});

afterEach(() => {
  window.localStorage.clear();
});

describe("optional widget catalog ownership", () => {
  it.each([
    "memoria.approve",
    "atlassianConnectors.title",
    "managedLanguage.title",
    "context.details.title",
  ])("keeps the lazy-only %s copy out of both core catalogs", (key) => {
    expect(EN_MESSAGES).not.toHaveProperty(key);
    expect(DE_MESSAGES).not.toHaveProperty(key);
    expect(Object.hasOwn(OPTIONAL_WIDGET_EN_MESSAGES, key)).toBe(true);
    expect(Object.hasOwn(OPTIONAL_WIDGET_DE_MESSAGES, key)).toBe(true);
  });

  it("keeps English widget opening independent of German locale loading", async () => {
    await loadOptionalWidgetMessages("en");
    expect(translateOptionalWidget("de", "memoria.approve")).toBe("Approve");
    const first = loadOptionalWidgetMessages("de");
    expect(loadOptionalWidgetMessages("de")).toBe(first);
    await first;
    expect(translateOptionalWidget("de", "memoria.approve")).toBe("Akzeptieren");
    expect(await loadOptionalWidgetMessages("de")).toBe(await first);
  });

  it("preserves exact optional English/German key parity", () => {
    expect(Object.keys(OPTIONAL_WIDGET_DE_MESSAGES).sort()).toEqual(
      Object.keys(OPTIONAL_WIDGET_EN_MESSAGES).sort(),
    );
  });

  it("uses the existing core English fallback until the requested core locale is loaded", async () => {
    expect(translateOptionalWidget("de", "common.close")).toBe("Close");
    await loadLocaleMessages("de");
    expect(translateOptionalWidget("de", "common.close")).toBe("Schließen");
  });

  it("renders widget and shared core text through locale switches without replacing its state", async () => {
    render(
      <I18nProvider>
        <WidgetProbe />
      </I18nProvider>,
    );
    const action = screen.getByRole("button", { name: "Close" });
    expect(action).toHaveTextContent("Approve");
    expect(screen.getByText("Language intelligence")).toBeInTheDocument();
    fireEvent.click(action);
    expect(screen.getByLabelText("Clicks")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "German" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Schließen" })).toHaveTextContent("Akzeptieren"),
    );
    expect(screen.getByText("Sprachintelligenz")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.getByLabelText("Clicks")).toHaveTextContent("2");
  });
});
