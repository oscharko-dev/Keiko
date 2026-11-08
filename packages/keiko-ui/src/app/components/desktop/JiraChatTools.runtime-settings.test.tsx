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
  ["jira_jmx_metrics_exposed", { exposed: false }],
  ["jira_search_max_aggregation_buckets", { limit: 0 }],
  ["jira_search_max_result_window", { limit: -1 }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved scalar runtime settings in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores false and signed values without unlimited, authority or side-effect claims", async () => {
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
      ? [
          "Read Jira JMX metric exposure",
          "Read Jira's search aggregation bucket limit",
          "Read Jira's search result window limit",
        ]
      : [
          "Jira-Bereitstellung von JMX-Metriken lesen",
          "Jira-Grenze für Suchaggregations-Buckets lesen",
          "Jira-Grenze für Suchergebnisfenster lesen",
        ])
      expect(screen.getByRole("group", { name })).toBeVisible();
    const expected =
      locale === "en"
        ? [
            "JMX metrics reported not exposed",
            "Reported maximum aggregation buckets: 0",
            "Reported maximum result window: -1",
            "Keiko's search budgets and permissions remain separate.",
          ]
        : [
            "JMX-Metriken laut Jira nicht bereitgestellt",
            "Gemeldete maximale Aggregations-Buckets: 0",
            "Gemeldetes maximales Ergebnisfenster: -1",
            "Keikos Suchbudgets und Berechtigungen bleiben getrennt.",
          ];
    for (const value of expected) expect(container.textContent).toContain(value);
    expect(container.textContent).not.toMatch(/unlimited|unbegrenzt/iu);
    expect(container.querySelector("pre, a, img")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
