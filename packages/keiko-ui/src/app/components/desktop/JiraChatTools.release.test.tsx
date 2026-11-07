import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { jiraToolOutcomeView } from "./jira-tool-outcome";

const CASES: readonly [string, CatalogJsonObject, string, string][] = [
  ["jira_component_related_issue_counts", { componentId: "71", countScope: "jira-response", issueCount: 0 },
    "Read Jira component issue counts", "Vorgangszahlen einer Jira-Komponente lesen"],
  ["jira_version_related_issue_counts", {
    versionId: "81", countScope: "jira-response", issuesFixedCount: 0,
    customFieldNames: [{ customFieldId: "10001", fieldName: "Delivery", issueCountWithVersionInCustomField: 0 },
      { customFieldId: "9223372036854775807", fieldName: "Audit" }],
  }, "Read Jira version issue counts", "Vorgangszahlen einer Jira-Version lesen"],
  ["jira_version_unresolved_issue_count", { versionId: "81", countScope: "jira-response" },
    "Read Jira version unresolved issue count", "Zahl ungelöster Vorgänge einer Jira-Version lesen"],
  ["jira_project_version_page", {
    projectId: "10000", projectKey: "SYN", startAt: 0, nextStartAt: 1,
    items: [{ versionId: "81", name: "Release", released: false, releaseDate: "2026-11-07" }],
  }, "Read a Jira project version page", "Eine Seite mit Versionen eines Jira-Projekts lesen"],
];
function exchange(name: string, data: CatalogJsonObject): ChatToolExchange {
  return {
    call: { id: name, name, arguments: {} },
    result: {
      schemaVersion: 1, invocationId: name, toolRef: null, projectionDigest: null, effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null },
      data: { outcome: "succeeded", ...data },
    },
  };
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved Jira release observations in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores four cards with independent native count dimensions and unknown values", async () => {
    const restored = JSON.parse(JSON.stringify({ schemaVersion: 1,
      exchanges: CASES.map(([name, data]) => exchange(name, { ...data, self: "https://untrusted.invalid/resource" })),
    })) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> => render(
      <I18nProvider><JiraChatTools transcript={restored} turnState="completed" /></I18nProvider>,
    );
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    for (const [, , en, de] of CASES)
      expect(screen.getByRole("group", { name: locale === "en" ? en : de })).toBeVisible();
    for (const value of ["Delivery", "Audit", "9223372036854775807", "Release", "SYN"])
      expect(container.textContent).toContain(value);
    const expected = locale === "en" ? [
      "Related issues reported by Jira: 0", "Issues using the fix version: 0",
      "Issues using the version in this field: 0", "Custom fields returned: 2",
      "Some requested counts were not provided; missing counts are unknown.",
      "Counts from Jira's response, without an independent JQL comparison.",
      "Partial Jira result. Some available data is not included.",
    ] : [
      "Von Jira gemeldete zugehörige Vorgänge: 0", "Vorgänge mit dieser Lösungsversion: 0",
      "Vorgänge mit dieser Version in diesem Feld: 0", "Gelieferte benutzerdefinierte Felder: 2",
      "Einige angeforderte Zählwerte wurden nicht bereitgestellt; fehlende Werte bleiben unbekannt.",
      "Zählwerte aus der Jira-Antwort ohne unabhängigen JQL-Abgleich.",
      "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
    ];
    for (const value of expected) expect(container.textContent).toContain(value);
    expect(container.textContent).not.toContain(locale === "en"
      ? "Unresolved issues reported by Jira: 0" : "Von Jira gemeldete ungelöste Vorgänge: 0");
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, img, a")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("does not invent a native version-page total or unknown issue counts", () => {
    const page = jiraToolOutcomeView(exchange("jira_project_version_page", {
      projectId: "10000", projectKey: "SYN", startAt: 0, nextStartAt: 1,
      items: [{ versionId: "81", name: "Release" }],
    }));
    expect(page).toMatchObject({ returnedCount: 1, total: undefined, unreadableCount: 0 });
    const counts = jiraToolOutcomeView(exchange("jira_version_related_issue_counts", {
      versionId: "81", countScope: "jira-response", customFieldNames: [],
    }));
    expect(counts.items[0]?.facts).toContainEqual({ label: "chat.jira.release.customFieldCount", value: "0" });
    expect(counts.items[0]?.facts.some(({ label }) => label === "chat.jira.release.fixedIssues")).toBe(false);
    expect(counts.items[0]?.labels).toContain("chat.jira.release.countsUnknown");
  });
});
