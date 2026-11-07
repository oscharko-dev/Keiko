import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { jiraToolOutcomeView } from "./jira-tool-outcome";

const ROLE = { id: "37", name: "Reviewers" };
const ACTOR = { id: "9007199254740993", name: "review-team", displayName: "Review team", type: "atlassian-group-role-actor" };
const PROJECT = { projectId: "10000", projectKey: "SYN" };
const CASES: readonly [string, CatalogJsonObject, string, string][] = [
  ["jira_roles", { actorsScope: "role-configuration", items: [ROLE], startAt: 0, total: 1 }, "Read Jira roles", "Jira-Rollen lesen"],
  ["jira_role", { actorsScope: "role-configuration", ...ROLE, actors: [ACTOR] }, "Read Jira role", "Jira-Rolle lesen"],
  ["jira_role_default_actors", { roleId: "37", actorsScope: "role-defaults", items: [], startAt: 0, total: 0 }, "Read Jira role defaults", "Standardakteure einer Jira-Rolle lesen"],
  ["jira_project_roles", { ...PROJECT, items: [{ name: "Reviewers" }], startAt: 0, total: 1 }, "Read Jira project role names", "Rollennamen eines Jira-Projekts lesen"],
  ["jira_project_role", { ...PROJECT, actorsScope: "project-membership", ...ROLE, actors: [ACTOR] }, "Read Jira project role membership", "Rollenmitgliedschaft eines Jira-Projekts lesen"],
  ["jira_priority_schemes", { items: [{ id: "49", name: "Unknown priorities" }], startAt: 0, total: 2, nextStartAt: 1 }, "Read Jira priority schemes", "Jira-Prioritätsschemata lesen"],
  ["jira_priority_scheme", { id: "50", name: "Empty priorities", defaultScheme: false, optionIds: [] }, "Read Jira priority scheme", "Jira-Prioritätsschema lesen"],
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
describe.each(["en", "de"] as const)("saved role configuration in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores seven named cards with separate role scopes and no invented links", async () => {
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
    for (const value of ["Review team", "9007199254740993", "SYN", "Unknown priorities", "Empty priorities"])
      expect(container.textContent).toContain(value);
    const expected = locale === "en" ? [
      "Role configuration. Effective permissions have not been determined.",
      "These defaults do not establish membership in a particular project or effective permissions.",
      "The current user's membership and effective permissions have not been determined.",
      "Project role names only. Role IDs and members were not returned.",
      "Role actor details were not provided.", "Configured priority count: 0",
    ] : [
      "Rollenkonfiguration. Wirksame Berechtigungen wurden nicht ermittelt.",
      "Diese Vorgaben belegen weder die Mitgliedschaft in einem bestimmten Projekt noch wirksame Berechtigungen.",
      "Die Mitgliedschaft und wirksamen Berechtigungen des aktuellen Benutzers wurden nicht ermittelt.",
      "Nur Projektrollennamen. Rollen-IDs und Mitglieder wurden nicht geliefert.",
      "Details der Rollenakteure wurden nicht bereitgestellt.", "Anzahl konfigurierter Prioritäten: 0",
    ];
    for (const value of expected) expect(container.textContent).toContain(value);
    expect(container.querySelector("pre, img, a")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("preserves unknown default actor collections and missing legacy priority totals", () => {
    const absent = jiraToolOutcomeView(exchange("jira_role_default_actors", { roleId: "37", actorsScope: "role-defaults" }));
    expect(absent).toMatchObject({ returnedCount: undefined, total: undefined, unreadableCount: 0 });
    expect(absent.items[0]?.labels).toContain("chat.jira.role.actorsUnknown");
    const empty = jiraToolOutcomeView(exchange("jira_role_default_actors", { roleId: "37", actorsScope: "role-defaults", items: [], startAt: 0, total: 0 }));
    expect(empty).toMatchObject({ returnedCount: 0, total: 0, unreadableCount: 0 });
    const page = jiraToolOutcomeView(exchange("jira_priority_schemes", { items: [{ id: "49", name: "Priorities" }], startAt: 0, nextStartAt: 1 }));
    expect(page).toMatchObject({ returnedCount: 1, total: undefined, unreadableCount: 0 });
  });
});
