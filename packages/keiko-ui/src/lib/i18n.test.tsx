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

  it("localizes every assistant code-apply state", async () => {
    await loadLocaleMessages("de");

    expect([
      translate("en", "chat.codeApply.action"),
      translate("en", "chat.codeApply.preparing"),
      translate("en", "chat.codeApply.queued"),
      translate("en", "chat.codeApply.conflict", { code: "DIRTY" }),
      translate("en", "chat.codeApply.unavailable"),
      translate("en", "chat.codeApply.retry"),
      translate("en", "chat.codeApply.outcomeUnknown"),
      translate("en", "chat.codeApply.outcomeUnknownStatus"),
    ]).toEqual([
      "Apply to editor",
      "Preparing",
      "Queued for review",
      "Conflict: DIRTY",
      "Editor unavailable",
      "Retry",
      "Outcome unknown",
      "Outcome unknown. Check the editor.",
    ]);
    expect([
      translate("de", "chat.codeApply.action"),
      translate("de", "chat.codeApply.preparing"),
      translate("de", "chat.codeApply.queued"),
      translate("de", "chat.codeApply.conflict", { code: "DIRTY" }),
      translate("de", "chat.codeApply.unavailable"),
      translate("de", "chat.codeApply.retry"),
      translate("de", "chat.codeApply.outcomeUnknown"),
      translate("de", "chat.codeApply.outcomeUnknownStatus"),
    ]).toEqual([
      "Im Editor anwenden",
      "Wird vorbereitet",
      "Zur Prüfung vorgemerkt",
      "Konflikt: DIRTY",
      "Editor nicht verfügbar",
      "Erneut versuchen",
      "Ergebnis unbekannt",
      "Ergebnis unbekannt. Prüfe den Editor.",
    ]);
  });

  it("localizes editor selection handoff notices", async () => {
    await loadLocaleMessages("de");

    expect([
      translate("en", "editor.askSelection.selectText"),
      translate("en", "editor.askSelection.chatUnavailable"),
      translate("en", "editor.askSelection.openFailed"),
    ]).toEqual([
      "Select text in the active editor before asking Keiko.",
      "Chat is unavailable for this workspace.",
      "Could not open chat for this selection.",
    ]);
    expect([
      translate("de", "editor.askSelection.selectText"),
      translate("de", "editor.askSelection.chatUnavailable"),
      translate("de", "editor.askSelection.openFailed"),
    ]).toEqual([
      "Wähle Text im aktiven Editor aus, bevor du Keiko fragst.",
      "Der Chat ist für diesen Arbeitsbereich nicht verfügbar.",
      "Der Chat für diese Auswahl konnte nicht geöffnet werden.",
    ]);
  });

  it("localizes content-free editor review lifecycle notices", async () => {
    await loadLocaleMessages("de");

    expect([
      translate("en", "editor.agentReview.applying"),
      translate("en", "editor.agentReview.timedOut"),
      translate("en", "editor.agentReview.conflict"),
      translate("en", "editor.agentReview.awaitingResult"),
    ]).toEqual([
      "Confirming the editor review.",
      "The editor review expired. Request the change again.",
      "The editor review conflicts with the current target.",
      "The review result is unknown. Waiting for authoritative editor status.",
    ]);
    expect([
      translate("de", "editor.agentReview.applying"),
      translate("de", "editor.agentReview.timedOut"),
      translate("de", "editor.agentReview.conflict"),
      translate("de", "editor.agentReview.awaitingResult"),
    ]).toEqual([
      "Die Editor-Prüfung wird bestätigt.",
      "Die Editor-Prüfung ist abgelaufen. Fordere die Änderung erneut an.",
      "Die Editor-Prüfung steht im Konflikt mit dem aktuellen Ziel.",
      "Das Prüfungsergebnis ist unbekannt. Der Editor wartet auf einen verbindlichen Status.",
    ]);
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
