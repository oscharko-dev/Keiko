import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { jiraToolOutcomeView } from "./jira-tool-outcome";

const USER = { key: "U1", name: "Synthetic", displayName: "Synthetic User", active: false,
  emailAddress: "private@example.invalid", avatarUrl: "https://untrusted.invalid/user" };
const CASES: readonly [string, CatalogJsonObject, string, string][] = [
  ["jira_multi_project_assignable_users", { items: [USER], searchLimit: 100 }, "Find assignable users across Jira projects", "Zuweisbare Benutzer mehrerer Jira-Projekte suchen"],
  ["jira_permission_users", { items: [USER], searchLimit: 100, startAt: 0, nextStartAt: 1 }, "Find Jira users by permission", "Jira-Benutzer nach Berechtigung suchen"],
  ["jira_browse_permission_users", { items: [USER], searchLimit: 100 }, "Find Jira users with browse permission", "Jira-Benutzer mit Anzeigeberechtigung suchen"],
  ["jira_group_user_picker", { users: [USER], usersTotal: 9, groups: [], groupsTotal: 0 }, "Suggest Jira users and groups", "Jira-Benutzer und -Gruppen vorschlagen"],
  ["jira_project_picker", { items: [{ id: "10000", key: "SYN", name: "Delivery" }] }, "Suggest Jira projects", "Jira-Projekte vorschlagen"],
  ["jira_fields", { items: [{ id: "customfield_10001", name: "Delivery field", custom: true, searchable: false,
    clauseNames: [], schema: { type: "array", items: "string", customId: "9223372036854775807" } }], startAt: 0, total: 1 },
    "Read Jira field definitions", "Jira-Felddefinitionen lesen"],
  ["jira_custom_field_option", { id: "91", value: "", disabled: false, childrenIds: [] }, "Read Jira custom field option", "Option eines benutzerdefinierten Jira-Felds lesen"],
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
describe.each(["en", "de"] as const)("saved scoped directory and field results in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores seven named cards with distinct picker populations and truthful field metadata", async () => {
    const restored = JSON.parse(JSON.stringify({ schemaVersion: 1,
      exchanges: CASES.map(([name, data]) => exchange(name, data)),
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
    const expected = locale === "en" ? [
      "This search covers at most the first 100 matching users.", "User suggestions returned: 1", "Reported user matches: 9",
      "Group suggestions returned: 0", "Reported group matches: 0", "Searchable: no", "Orderable: unknown",
      "JQL clause names returned: 0", "Empty option value", "Child options returned: 0",
      "Requiredness and editability for a particular issue have not been determined.",
    ] : [
      "Diese Suche umfasst höchstens die ersten 100 passenden Benutzer.", "Gelieferte Benutzervorschläge: 1", "Gemeldete Benutzertreffer: 9",
      "Gelieferte Gruppenvorschläge: 0", "Gemeldete Gruppentreffer: 0", "Durchsuchbar: nein", "Sortierbar: unbekannt",
      "Gelieferte JQL-Klauselnamen: 0", "Leerer Optionswert", "Gelieferte untergeordnete Optionen: 0",
      "Pflichtangabe und Bearbeitbarkeit für einen bestimmten Vorgang wurden nicht ermittelt.",
    ];
    for (const value of expected) expect(container.textContent).toContain(value);
    expect(container.textContent).toContain("9223372036854775807");
    expect(container.textContent).not.toMatch(/private@example.invalid|untrusted.invalid/u);
    expect(container.querySelector("pre, img, a")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("preserves missing picker branches without a combined total or invented empty users", () => {
    const view = jiraToolOutcomeView(exchange("jira_group_user_picker", { groups: [] }));
    expect(view).toMatchObject({ returnedCount: undefined, total: undefined });
    expect(view.items[0]?.labels).toContain("chat.jira.lookup.usersUnknown");
    expect(view.items[1]?.facts).toEqual([{ label: "chat.jira.lookup.groupsReturned", value: "0" }]);
  });
});
