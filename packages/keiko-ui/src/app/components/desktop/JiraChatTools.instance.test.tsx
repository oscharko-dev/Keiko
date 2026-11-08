import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { partialJiraReadPage } from "./jira-result.test-fixture";

const CASES: readonly [string, CatalogJsonObject, string, string][] = [
  [
    "jira_server_info",
    {
      version: "11.4-SNAPSHOT",
      versionNumbers: [11, 4, 0],
      serverTitle: "Synthetic Jira",
      deploymentType: "Data Center",
      buildNumber: "9007199254740993",
      databaseBuildNumber: "0",
      baseUrl: "https://untrusted.invalid/instance",
    },
    "Read Jira server information",
    "Jira-Serverinformationen lesen",
  ],
  [
    "jira_instance_configuration",
    {
      watchingEnabled: false,
      votingEnabled: true,
      timeTrackingEnabled: false,
      timeTrackingConfiguration: {
        workingHoursPerDay: 0,
        workingDaysPerWeek: 4.5,
        defaultUnit: "hour",
      },
    },
    "Read Jira instance configuration",
    "Konfiguration der Jira-Instanz lesen",
  ],
  [
    "jira_permission_definitions",
    {
      permissionsScope: "definitions",
      startAt: 0,
      total: 1,
      items: [
        {
          key: "EDIT_ISSUE",
          nativeKey: "EDIT_ISSUES",
          id: "12",
          name: "Edit issues",
          type: "PROJECT",
          havePermission: true,
        },
      ],
    },
    "Read Jira permission definitions",
    "Jira-Berechtigungsdefinitionen lesen",
  ],
  [
    "jira_myself",
    {
      key: "U1",
      name: "Synthetic",
      displayName: "Synthetic User",
      active: false,
      emailAddress: "private@example.invalid",
      self: "https://untrusted.invalid/user",
    },
    "Read the current Jira account",
    "Das aktuelle Jira-Konto lesen",
  ],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved Jira instance observations in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores four accessible cards without inventing verification, grants or missing settings", async () => {
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
    for (const [, , en, de] of CASES)
      expect(screen.getByRole("group", { name: locale === "en" ? en : de })).toBeVisible();
    for (const value of [
      "11.4-SNAPSHOT",
      "9007199254740993",
      "Synthetic User",
      "EDIT_ISSUE",
      "EDIT_ISSUES",
    ])
      expect(container.textContent).toContain(value);
    const expected =
      locale === "en"
        ? [
            "Watching: disabled",
            "Voting: enabled",
            "Attachments: setting unknown",
            "Time tracking: disabled",
            "Working hours per day: 0",
            "Working days per week: 4.5",
            "Some time-tracking settings were not provided.",
            "Effective permissions for the current user have not been determined.",
            "This read does not verify the connection or establish which operations are supported.",
          ]
        : [
            "Beobachten: deaktiviert",
            "Abstimmungen: aktiviert",
            "Anhänge: Einstellung unbekannt",
            "Zeiterfassung: deaktiviert",
            "Arbeitsstunden pro Tag: 0",
            "Arbeitstage pro Woche: 4.5",
            "Einige Einstellungen zur Zeiterfassung wurden nicht bereitgestellt.",
            "Wirksame Berechtigungen des aktuellen Benutzers wurden nicht ermittelt.",
            "Dieser Abruf verifiziert weder die Verbindung noch die Unterstützung einzelner Operationen.",
          ];
    for (const value of expected) expect(container.textContent).toContain(value);
    expect(container.textContent).not.toMatch(/private@example.invalid|untrusted.invalid/u);
    expect(container.querySelector("pre, img, a")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
