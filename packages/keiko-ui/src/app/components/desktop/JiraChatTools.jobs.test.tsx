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
  ["jira_reindex_status", { taskSelection: "active-or-latest" }],
  [
    "jira_reindex_progress",
    {
      taskSelection: "selected-task",
      selectedTaskId: "9223372036854775807",
      currentProgress: 0,
      success: false,
      currentSubTask: "Native step",
    },
  ],
  ["jira_reindex_request", { id: "7", status: "COMPLETE", type: "BACKGROUND" }],
  [
    "jira_reindex_requests",
    {
      requestScope: "selected-requests",
      requestedRequestIds: ["7", "8"],
      unreturnedRequestIds: ["8"],
      items: [{ id: "7", status: "PENDING" }],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira_upgrade_result",
    {
      upgradeState: "result",
      upgradeOutcome: "FAILED",
      duration: 0,
      message: "Synthetic upgrade result",
    },
  ],
  [
    "jira_index_snapshots",
    {
      items: [
        { absolutePath: "/server/snapshots/synthetic.zip", timestamp: 0 },
        { absolutePath: "/server/snapshots/other.zip" },
      ],
      startAt: 0,
      total: 2,
    },
  ],
  ["jira_app_monitoring", { enabled: false }],
  ["jira_ipd_monitoring", {}],
  ["jira_jmx_metrics", { metricsText: "metric.one\nmetric.two <native description>" }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("persistent Jira maintenance observations in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores nine accessible read results without inventing units, task failure or file links", async () => {
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
    const groups =
      locale === "en"
        ? [
            "Read Jira reindex status",
            "Read Jira reindex progress",
            "Read a Jira reindex request",
            "Read selected Jira reindex requests",
            "Read the Jira upgrade result",
            "Read Jira index snapshot metadata",
            "Read Jira application monitoring settings",
            "Read Jira in-product diagnostics settings",
            "Read Jira JMX metric descriptions",
          ]
        : [
            "Jira-Reindexierungsstatus lesen",
            "Jira-Reindexierungsfortschritt lesen",
            "Jira-Reindexierungsanfrage lesen",
            "Ausgewählte Jira-Reindexierungsanfragen lesen",
            "Jira-Upgrade-Ergebnis lesen",
            "Jira-Index-Snapshot-Metadaten lesen",
            "Jira-Anwendungsüberwachung lesen",
            "Jira-Einstellungen zur Produktdiagnose lesen",
            "Jira-JMX-Metrikbeschreibungen lesen",
          ];
    for (const name of groups) expect(screen.getByRole("group", { name })).toBeVisible();
    const expected =
      locale === "en"
        ? [
            "Native progress value: 0",
            "Native success flag: false; this alone does not establish task failure.",
            "The native progress value was not provided.",
            "Native duration value: 0",
            "The duration unit was not established; the native value is unchanged.",
            "Native monitoring enabled flag: false",
            "Native monitoring enabled flag: unknown",
            "Requested IDs not returned by Jira: 8",
            "The snapshot timestamp was not provided.",
          ]
        : [
            "Nativer Fortschrittswert: 0",
            "Natives Erfolgsflag: falsch; daraus allein folgt kein Fehlschlag der Aufgabe.",
            "Der native Fortschrittswert wurde nicht angegeben.",
            "Nativer Dauerwert: 0",
            "Die Einheit der Dauer wurde nicht bestimmt; der native Wert bleibt unverändert.",
            "Natives Überwachungsflag: falsch",
            "Natives Überwachungsflag: unbekannt",
            "Von Jira nicht zurückgegebene angefragte IDs: 8",
            "Der Snapshot-Zeitstempel wurde nicht angegeben.",
          ];
    for (const value of [
      ...expected,
      "9223372036854775807",
      "FAILED",
      "/server/snapshots/synthetic.zip",
      "metric.two <native description>",
    ])
      expect(container.textContent).toContain(value);
    expect(container.textContent).not.toContain("0%");
    expect(container.querySelector("pre, a, img, native")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
