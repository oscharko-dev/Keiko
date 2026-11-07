import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const CASES: readonly [string, CatalogJsonObject][] = [
  ["jira_jql_autocomplete", { category: "fields", metadataScope: "visible-fields", items: [{
    value: "cf[10001]", cfid: "cf[10001]", auto: false, searchable: true, operators: [], types: ["User"], displayName: "<b>Ignored highlight</b>",
  }], startAt: 0, total: 1 }],
  ["jira_jql_autocomplete", { category: "functions", metadataScope: "visible-functions", items: [{ value: "currentUser()" }], startAt: 0, total: 1 }],
  ["jira_jql_autocomplete", { category: "reserved-words", metadataScope: "reserved-words", items: [{ value: "empty" }], startAt: 0, total: 1 }],
  ["jira_jql_suggestions", { category: "suggestions", metadataScope: "native-suggestions",
    fieldName: "project", fieldValue: "", predicateName: "from", predicateValue: "Old & new",
    items: [{ value: "Exact & token", displayName: "<b>Ignored suggestion</b>", self: "https://untrusted.invalid" }], startAt: 0, total: 1,
  }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved JQL metadata in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores scoped autocomplete and exact suggestion tokens without native HTML or execution claims", async () => {
    const exchanges = CASES.map(([name, data], index): ChatToolExchange => ({
      call: { id: `${name}-${String(index)}`, name, arguments: {} }, result: {
        schemaVersion: 1, invocationId: `${name}-${String(index)}`, toolRef: null, projectionDigest: null, effectStarted: false,
        metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
        status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null },
        data: { outcome: "succeeded", ...data },
      },
    }));
    const restored = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> => render(
      <I18nProvider><JiraChatTools transcript={restored} turnState="completed" /></I18nProvider>,
    );
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    expect(screen.getAllByRole("group", { name: locale === "en"
      ? "Read Jira JQL autocomplete metadata" : "Jira-Metadaten zur JQL-Vervollständigung lesen" })).toHaveLength(3);
    expect(screen.getByRole("group", { name: locale === "en"
      ? "Read Jira JQL value suggestions" : "Jira-Wertvorschläge für JQL lesen" })).toBeVisible();
    for (const value of ["cf[10001]", "currentUser()", "empty", "Exact & token", "Old & new"])
      expect(container.textContent).toContain(value);
    const expected = locale === "en" ? [
      "Visible JQL field metadata", "Visible JQL function metadata", "JQL reserved words", "Native JQL value suggestions",
      "Reported operators returned: 0", "Native auto flag: false", "Orderable: unknown", "Type metadata was not provided.",
      "Empty field value prefix", "Counts refer to these entries, not issues; no JQL validation or permission check was performed.",
    ] : [
      "Sichtbare JQL-Feldmetadaten", "Sichtbare JQL-Funktionsmetadaten", "Reservierte JQL-Wörter", "Native JQL-Wertvorschläge",
      "Gelieferte Operatorangaben: 0", "Natives Auto-Flag: falsch", "Sortierbar: unbekannt", "Typmetadaten wurden nicht bereitgestellt.",
      "Leeres Feldwertpräfix", "Zählwerte beziehen sich auf diese Einträge, nicht auf Vorgänge; eine JQL-Validierung oder Berechtigungsprüfung wurde nicht durchgeführt.",
    ];
    for (const value of expected) expect(container.textContent).toContain(value);
    expect(container.textContent).not.toMatch(/Ignored highlight|Ignored suggestion|untrusted.invalid/u);
    expect(container.querySelector("pre, img, a, b")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
