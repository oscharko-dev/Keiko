import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const ENTITIES: readonly [string, CatalogJsonObject][] = [
  ["board", { entityType: "board", boardId: "7" }],
  ["sprint", { entityType: "sprint", sprintId: "9" }],
  ["comment", { entityType: "comment", issueId: "10001", issueKey: "SYN-1", commentId: "10002" }],
  ["dashboard_item", { entityType: "dashboard-item", dashboardId: "71", selectedItemId: "81" }],
  ["issue", { entityType: "issue", issueId: "10001", issueKey: "SYN-1" }],
  ["issue_type", { entityType: "issue-type", issueTypeId: "10001" }],
  ["project", { entityType: "project", projectId: "10000", projectKey: "SYN" }],
  ["user", { entityType: "user", userKey: "JIRAUSER10100", username: "Synthetic-User" }],
];
const NODES: readonly CatalogJsonObject[] = [
  { path: "", kind: "object", childCount: 7 }, { path: "/", kind: "null" },
  { path: "/a~1b~0c", kind: "string", textValue: "Kept private text" },
  { path: "/empty-object", kind: "object", childCount: 0 }, { path: "/empty-array", kind: "array", childCount: 0 },
  { path: "/empty-text", kind: "string", textValue: "" },
  { path: "/false", kind: "boolean", booleanValue: false }, { path: "/zero", kind: "number", numberValue: 0 },
];
function exchange(name: string, data: CatalogJsonObject): ChatToolExchange {
  return { call: { id: name, name, arguments: {} }, result: {
    schemaVersion: 1, invocationId: name, toolRef: null, projectionDigest: null, effectStarted: false,
    metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
    status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null },
    data: { outcome: "succeeded", ...data },
  } };
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("persisted typed Jira properties in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores all sixteen result groups with readable pointer positions and distinct null/empty values", async () => {
    const exchanges = ENTITIES.flatMap(([entity, context]) => [
      exchange(`jira_${entity}_property_keys`, { ...context, items: [{ key: "view.settings" }, { key: "a/b%" }], startAt: 0, total: 2 }),
      exchange(`jira_${entity}_property`, { ...context, propertyKey: "view.settings", items: NODES, nodeCount: NODES.length,
        self: "https://untrusted.invalid/property" }),
    ]);
    const restored = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> => render(<I18nProvider><JiraChatTools transcript={restored} turnState="completed" /></I18nProvider>);
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    const groups = locale === "en" ? [
      "Read Jira board property keys", "Read a Jira board property", "Read Jira sprint property keys", "Read a Jira sprint property",
      "Read Jira comment property keys", "Read a Jira comment property", "Read Jira dashboard item property keys", "Read a Jira dashboard item property",
      "Read Jira issue property keys", "Read a Jira issue property", "Read Jira issue type property keys", "Read a Jira issue type property",
      "Read Jira project property keys", "Read a Jira project property", "Read Jira user property keys", "Read a Jira user property",
    ] : [
      "Jira-Board-Property-Schlüssel lesen", "Jira-Board-Property lesen", "Jira-Sprint-Property-Schlüssel lesen", "Jira-Sprint-Property lesen",
      "Jira-Kommentar-Property-Schlüssel lesen", "Jira-Kommentar-Property lesen", "Jira-Dashboard-Element-Property-Schlüssel lesen", "Jira-Dashboard-Element-Property lesen",
      "Jira-Vorgangs-Property-Schlüssel lesen", "Jira-Vorgangs-Property lesen", "Jira-Vorgangstyp-Property-Schlüssel lesen", "Jira-Vorgangstyp-Property lesen",
      "Jira-Projekt-Property-Schlüssel lesen", "Jira-Projekt-Property lesen", "Jira-Benutzer-Property-Schlüssel lesen", "Jira-Benutzer-Property lesen",
    ];
    for (const name of groups) expect(screen.getByRole("group", { name })).toBeVisible();
    const issue = screen.getByRole("group", { name: locale === "en" ? "Read a Jira issue property" : "Jira-Vorgangs-Property lesen" });
    const emptyArray = within(issue).getByText(locale === "en" ? "Stored value: empty array" : "Gespeicherter Wert: leeres Array");
    expect(emptyArray).not.toBeVisible();
    fireEvent.click(within(issue).getByText(locale === "en" ? "Show 4 more results" : "4 weitere Ergebnisse anzeigen"));
    expect(emptyArray).toBeVisible();
    const expected = locale === "en" ? [
      "Root: the whole property value", "Stored value: JSON null", "Stored value: empty object",
      "Stored value: empty text", "Stored boolean: false", "Value: 0", "Requested dashboard item ID: 81",
    ] : [
      "Wurzel: der gesamte Property-Wert", "Gespeicherter Wert: JSON null", "Gespeicherter Wert: leeres Objekt",
      "Gespeicherter Wert: leerer Text", "Gespeicherter Wahrheitswert: falsch", "Wert: 0", "Angefragte Dashboard-Element-ID: 81",
    ];
    for (const value of [...expected, "JSON Pointer: /a~1b~0c", "JSON Pointer: /", "a/b%", "Kept private text"])
      expect(container.textContent).toContain(value);
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, a, img")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
