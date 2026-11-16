import { render, screen } from "@testing-library/react";
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
    "jira_global_version_page",
    {
      items: [{ versionId: "81", name: "Next release", released: false, projectId: "10000" }],
      startAt: 0,
      nextStartAt: 1,
    },
  ],
  [
    "jira_component_page",
    {
      items: [{ id: "71", name: "Delivery module", project: "SYN", deleted: false }],
      startAt: 0,
      nextStartAt: 1,
    },
  ],
  ["jira_link_type", { id: "31", name: "Blocks", inward: "is blocked by", outward: "blocks" }],
  [
    "jira_accessibility_settings",
    {
      settingsScope: "connected-user",
      items: [{ key: "underline-links", enabled: false }, { key: "keyboard-settings" }],
      startAt: 0,
      total: 2,
    },
  ],
  [
    "jira_system_columns",
    {
      layoutScope: "system",
      columnsAvailable: true,
      items: [{ value: "summary", label: "Summary" }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira_user_columns",
    {
      layoutScope: "named-user",
      selectedUsername: "Review + QA",
      columnsAvailable: true,
      items: [],
      startAt: 0,
      total: 0,
    },
  ],
  [
    "jira_filter_columns",
    {
      layoutScope: "filter",
      selectedFilterId: "42",
      columnConfig: "EXPLICIT",
      columnsAvailable: true,
      items: [
        {
          id: "summary",
          position: -1,
          columnHeadingKey: "native.summary",
          self: "https://untrusted.invalid",
        },
      ],
      startAt: 0,
      total: 1,
    },
  ],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved metadata pages and view settings in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores seven readable results with requested layout context and unknown preference flags", async () => {
    const exchanges = CASES.map(([name, data]): ChatToolExchange => ({
      call: { id: name, name, arguments: {} },
      result: {
        schemaVersion: 1,
        invocationId: name,
        toolRef: null,
        projectionDigest: null,
        effectStarted: false,
        metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
        status: "completed",
        reason: "none",
        page: partialJiraReadPage(name),
        data: { outcome: "succeeded", ...data },
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
    for (const name of locale === "en"
      ? ["Read Jira accessibility settings", "Read Jira filter columns", "Read a Jira version page"]
      : [
          "Jira-Barrierefreiheitseinstellungen lesen",
          "Jira-Filterspalten lesen",
          "Jira-Versionsseite lesen",
        ])
      expect(screen.getByRole("group", { name })).toBeVisible();
    const expected =
      locale === "en"
        ? [
            "Settings for the connected Jira account",
            "Reported enabled flag: false",
            "Enabled flag: unknown",
            "Requested Jira user: Review + QA",
            "Native column position: -1",
            "Component reported not deleted",
          ]
        : [
            "Einstellungen des verbundenen Jira-Kontos",
            "Gemeldetes Aktivierungsflag: falsch",
            "Aktivierungsflag: unbekannt",
            "Angefragter Jira-Benutzer: Review + QA",
            "Native Spaltenposition: -1",
            "Komponente als nicht gelöscht gemeldet",
          ];
    for (const value of [
      ...expected,
      "Next release",
      "Delivery module",
      "is blocked by",
      "native.summary",
    ])
      expect(container.textContent).toContain(value);
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, a, img")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
