import { buttonsOutsideProgress } from "./jira-result.test-fixture";
import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const CASES: readonly [string, CatalogJsonObject][] = [
  ["jira_set_app_monitoring", { outcome: "succeeded", monitoringEnabled: true }],
  ["jira_set_ipd_monitoring", { outcome: "succeeded", monitoringEnabled: false }],
  ["jira_start_jmx_metrics", { outcome: "succeeded", jmxMetricsExposed: true }],
  ["jira_stop_jmx_metrics", { outcome: "succeeded", jmxMetricsExposed: false }],
  ["jira_set_app_monitoring", { outcome: "unknown", reason: "timeout", monitoringEnabled: false }],
  [
    "jira_stop_jmx_metrics",
    { outcome: "succeeded-unconfirmed", reason: "unavailable", jmxMetricsExposed: false },
  ],
  [
    "jira_set_ipd_monitoring",
    { outcome: "rejected", reason: "conflict", unchanged: true, monitoringEnabled: false },
  ],
  ["jira_start_jmx_metrics", { outcome: "rejected", reason: "permission-denied" }],
  ["jira_start_jmx_metrics", { outcome: "succeeded", jmxMetricsExposed: true }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("persistent monitoring write results in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores target and observed states without retry controls or a false confirmation", async () => {
    const exchanges = CASES.map(([name, data], index): ChatToolExchange => ({
      call: { id: `monitoring-${index}`, name, arguments: {} },
      // A stored journal outcome supersedes a stale optimistic result payload.
      ...(index === 8 ? { mutationOutcome: "unknown" as const } : {}),
      result: {
        schemaVersion: 1,
        invocationId: `monitoring-${index}`,
        toolRef: null,
        projectionDigest: null,
        effectStarted: data.outcome !== "rejected",
        metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
        status: "completed",
        reason: "none",
        page: { truncated: false, reason: "none", cursor: null },
        data: {
          ...data,
          metricsText: "Unrelated metric content",
          browseUrl: "https://untrusted.invalid/metrics",
        },
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
            app: "Change Jira application monitoring",
            ipd: "Change Jira in-product diagnostics monitoring",
            start: "Enable Jira JMX metric exposure",
            stop: "Disable Jira JMX metric exposure",
            confirmed: "An independent read confirmed the requested monitoring state.",
            observedFalse: "Confirmed state: disabled",
            requestedFalse: "Requested target: disabled",
            unknown: "Jira outcome unknown",
            unconfirmed: "Jira accepted the change; confirmation incomplete",
            unchanged: "Already up to date",
            noState: "No valid monitoring state was recorded.",
            pending:
              "The saved value is only the requested target. The current monitoring state has not been confirmed.",
          }
        : {
            app: "Jira-Anwendungsüberwachung ändern",
            ipd: "Jira-Überwachung der Produktdiagnostik ändern",
            start: "Jira-JMX-Metrikbereitstellung aktivieren",
            stop: "Jira-JMX-Metrikbereitstellung deaktivieren",
            confirmed:
              "Eine unabhängige Leseabfrage hat den angeforderten Überwachungszustand bestätigt.",
            observedFalse: "Bestätigter Zustand: deaktiviert",
            requestedFalse: "Angeforderter Zielzustand: deaktiviert",
            unknown: "Ausgang der Jira-Aktion unbekannt",
            unconfirmed: "Jira hat die Änderung angenommen; Bestätigung unvollständig",
            unchanged: "Bereits aktuell",
            noState: "Es wurde kein gültiger Überwachungszustand gespeichert.",
            pending:
              "Der gespeicherte Wert ist nur der angeforderte Zielzustand. Der aktuelle Überwachungszustand wurde nicht bestätigt.",
          };
    for (const name of [labels.app, labels.ipd, labels.start, labels.stop])
      expect(screen.getAllByRole("group", { name })).toHaveLength(name === labels.start ? 3 : 2);
    expect(screen.getAllByText(labels.confirmed, { exact: true })).toHaveLength(4);
    for (const [name, status] of [
      [labels.app, labels.unknown],
      [labels.stop, labels.unconfirmed],
    ] as const) {
      const group = screen
        .getAllByRole("group", { name })
        .find((entry) => within(entry).queryByText(status) !== null);
      if (group === undefined) throw new TypeError("Missing uncertain monitoring result");
      expect(within(group).getByText(labels.pending)).toBeVisible();
      expect(within(group).getByText(labels.requestedFalse)).toBeVisible();
      expect(within(group).queryByText(labels.confirmed)).toBeNull();
      expect(within(group).queryByText(labels.observedFalse)).toBeNull();
    }
    expect(screen.getByText(labels.unchanged, { exact: true })).toBeVisible();
    expect(screen.getByText(labels.noState, { exact: true })).toBeVisible();
    expect(container.querySelector("pre, a, img")).toBeNull();
    expect(buttonsOutsideProgress(container)).toEqual([]);
    expect(container.textContent).not.toContain("Unrelated metric content");
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(await axe(container)).toHaveNoViolations();
  });
});
