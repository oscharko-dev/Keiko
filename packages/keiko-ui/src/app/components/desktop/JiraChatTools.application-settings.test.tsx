import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { partialJiraReadPage } from "./jira-result.test-fixture";

const CASES: readonly [string, CatalogJsonObject][] = [
  [
    "jira_application_properties",
    {
      settingsScope: "application-properties",
      permissionLevel: "ADMIN",
      startAt: 1,
      total: 7,
      nextStartAt: 6,
      items: [
        {
          key: "jira.option.voting",
          valueState: "observed",
          valueType: "boolean",
          booleanValue: false,
        },
        {
          key: "jira.option.watching",
          valueState: "observed",
          valueType: "boolean",
          booleanValue: true,
        },
        { key: "jira.clone.prefix", valueState: "observed", valueType: "string", stringValue: "" },
        {
          key: "jira.option.timetracking",
          valueState: "unknown",
          valueType: "boolean",
          booleanValue: true,
        },
        {
          key: "plugin.private.setting",
          valueState: "withheld",
          stringValue: "Withheld fixture value",
          defaultValue: "Excluded default",
          example: "Excluded example",
        },
      ],
    },
  ],
  [
    "jira_advanced_settings",
    { settingsScope: "advanced-settings", items: [], startAt: 0, total: 0 },
  ],
  ["jira_advanced_settings", { settingsScope: "advanced-settings" }],
  [
    "jira_my_preference",
    {
      settingsScope: "current-user-preference",
      key: "user.issues.per.page",
      valueState: "observed",
      valueType: "integer",
      integerValue: 0,
    },
  ],
  [
    "jira_my_preference",
    {
      settingsScope: "current-user-preference",
      key: "jira.user.locale",
      valueState: "observed",
      valueType: "string",
      stringValue: "0",
    },
  ],
  [
    "jira_my_preference",
    {
      settingsScope: "current-user-preference",
      key: "jira.user.timezone",
      valueState: "observed",
      valueType: "string",
      stringValue: "<b>literal native text</b>",
    },
  ],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved application settings in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores typed observations and uncertainty without exposing withheld data or making changes", async () => {
    const exchanges = CASES.map(([name, data], index): ChatToolExchange => ({
      call: { id: `setting-${index}`, name, arguments: {} },
      result: {
        schemaVersion: 1,
        invocationId: `setting-${index}`,
        toolRef: null,
        projectionDigest: null,
        effectStarted: false,
        metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
        status: "completed",
        reason: "none",
        page: partialJiraReadPage(name),
        data: { outcome: "succeeded", ...data, browseUrl: "https://untrusted.invalid/settings" },
      },
    }));
    const restored = JSON.parse(
      JSON.stringify({ schemaVersion: 1, exchanges }),
    ) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> =>
      render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    const labels =
      locale === "en"
        ? {
            application: "Read Jira application properties",
            advanced: "Read Jira advanced settings",
            preference: "Read a preference of the connected Jira user",
            integer: "Observed integer: 0",
            text: "Observed text: 0",
            false: "Observed boolean: false",
            true: "Observed boolean: true",
            empty: "Observed text: empty",
            unknown: "The setting value is unknown. No default value is assumed.",
            withheld:
              "The setting value was withheld because this key is not approved for value disclosure.",
            emptyList: "No settings were returned in this collection.",
            listUnknown: "The settings collection was not provided.",
            filter: "Requested native permission filter: ADMIN",
            partial: "Partial Jira result. Some available data is not included.",
          }
        : {
            application: "Jira-Anwendungseigenschaften lesen",
            advanced: "Erweiterte Jira-Einstellungen lesen",
            preference: "Einstellung des verbundenen Jira-Kontos lesen",
            integer: "Beobachtete Ganzzahl: 0",
            text: "Beobachteter Text: 0",
            false: "Beobachteter Wahrheitswert: falsch",
            true: "Beobachteter Wahrheitswert: wahr",
            empty: "Beobachteter Text: leer",
            unknown: "Der Einstellungswert ist unbekannt. Es wird kein Standardwert angenommen.",
            withheld:
              "Der Einstellungswert wurde zurückgehalten, weil dieser Schlüssel nicht zur Offenlegung von Werten freigegeben ist.",
            emptyList: "In dieser Sammlung wurden keine Einstellungen zurückgegeben.",
            listUnknown: "Die Sammlung der Einstellungen wurde nicht angegeben.",
            filter: "Angeforderter nativer Berechtigungsfilter: ADMIN",
            partial: "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
          };
    const application = screen.getByRole("group", { name: labels.application });
    fireEvent.click(
      within(application).getByText(
        locale === "en" ? "Show 1 more result" : "1 weiteres Ergebnis anzeigen",
      ),
    );
    for (const value of [
      labels.false,
      labels.true,
      labels.empty,
      labels.unknown,
      labels.withheld,
      labels.filter,
      labels.partial,
    ])
      expect(within(application).getByText(value)).toBeVisible();
    expect(screen.getAllByRole("group", { name: labels.advanced })).toHaveLength(2);
    expect(screen.getAllByRole("group", { name: labels.preference })).toHaveLength(3);
    for (const value of [labels.integer, labels.text, labels.emptyList, labels.listUnknown])
      expect(screen.getByText(value)).toBeVisible();
    expect(container.textContent).toContain("<b>literal native text</b>");
    expect(container.textContent).not.toMatch(
      /Withheld fixture value|Excluded default|Excluded example|untrusted\.invalid/u,
    );
    expect(container.querySelector("pre, a, img, b")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /retry|repeat|apply|erneut|wiederholen|anwenden/iu }),
    ).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
