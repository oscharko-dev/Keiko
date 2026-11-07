import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const CASES: readonly [string, CatalogJsonObject][] = [
  ["jira_screens", { items: [{ id: "71", name: "Issue details", deletable: false }], startAt: 0, total: 1 }],
  ["jira_workflows", { items: [{ name: "Review workflow", steps: 0, isDefault: false, lastModifiedDate: "07/Nov/26" }], startAt: 0, total: 1 }],
  ["jira_custom_fields", { items: [{ id: "customfield_10001", name: "Delivery", isLocked: false, projectIds: [], issuesWithValue: 0,
    schema: { self: "https://untrusted.invalid" } }], startAt: 0, total: 1 }],
  ["jira_custom_field_options", { customFieldId: "10001", optionsScope: "native-context-options", page: 2, nextPage: 3,
    items: [{ id: "91", value: "", disabled: false, childrenIds: [] }] }],
  ["jira_terminology", { items: [{ originalName: "Sprint", originalNamePlural: "Sprints", newName: "Iteration", newNamePlural: "Iterations", isDefault: false }], startAt: 0, total: 1 }],
  ["jira_terminology_entry", { originalName: "Epic" }],
  ["jira_read_only_mode", { message: "", endTime: "07/Nov/26 21:30", timeZone: "Europe/Berlin" }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved administrative metadata in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores seven named configuration results without permission or enforcement inference", async () => {
    const exchanges = CASES.map(([name, data]): ChatToolExchange => ({ call: { id: name, name, arguments: {} }, result: {
      schemaVersion: 1, invocationId: name, toolRef: null, projectionDigest: null, effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null },
      data: { outcome: "succeeded", ...data },
    } }));
    const restored = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> => render(<I18nProvider><JiraChatTools transcript={restored} turnState="completed" /></I18nProvider>);
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    expect(screen.getByRole("group", { name: locale === "en" ? "Read Jira screens" : "Jira-Masken lesen" })).toBeVisible();
    expect(screen.getByRole("group", { name: locale === "en" ? "Read Jira read-only mode settings" : "Jira-Einstellungen zum Nur-Lese-Modus lesen" })).toBeVisible();
    const expected = locale === "en" ? [
      "Reported deletable flag: false", "Reported workflow steps: 0", "Reported issues with a value: 0",
      "Managed flag: unknown", "Option page: 2", "Read-only setting: unknown", "Jira supplied an empty message.",
      "They do not establish edit permission or prove that a rule is enforced.",
    ] : [
      "Gemeldetes Löschbarkeitsflag: falsch", "Gemeldete Workflow-Schritte: 0", "Gemeldete Vorgänge mit Wert: 0",
      "Verwaltungsflag: unbekannt", "Optionsseite: 2", "Nur-Lese-Einstellung: unbekannt", "Jira lieferte eine leere Nachricht.",
      "Sie belegen weder eine Bearbeitungsberechtigung noch die Durchsetzung einer Regel.",
    ];
    for (const value of [...expected, "Iteration", "Epic", "07/Nov/26 21:30", "Europe/Berlin"])
      expect(container.textContent).toContain(value);
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, img, a")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
