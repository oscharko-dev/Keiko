import { say } from "./jira-result.test-fixture";
import { buttonsOutsideProgress } from "./jira-result.test-fixture";
import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const ENTITIES = [
  { tool: "board", en: "board", de: "Board", context: { boardId: "7" } },
  { tool: "sprint", en: "sprint", de: "Sprint", context: { sprintId: "9" } },
  {
    tool: "comment",
    en: "comment",
    de: "Kommentar",
    context: { issueId: "10001", issueKey: "SYN-1", commentId: "10002" },
  },
  {
    tool: "dashboard_item",
    en: "dashboard item",
    de: "Dashboard-Element",
    context: { dashboardId: "71", selectedItemId: "81" },
  },
  { tool: "issue", en: "issue", de: "Vorgangs", context: { issueId: "10001", issueKey: "SYN-1" } },
  { tool: "issue_type", en: "issue type", de: "Vorgangstyp", context: { issueTypeId: "10001" } },
  {
    tool: "project",
    en: "project",
    de: "Projekt",
    context: { projectId: "10000", projectKey: "SYN" },
  },
  {
    tool: "user",
    en: "user",
    de: "Benutzer",
    context: { userKey: "JIRAUSER10100", username: "Synthetic-User" },
  },
] as const;
interface SavedCase {
  readonly name: string;
  readonly data: CatalogJsonObject;
  readonly mutationOutcome?: ChatToolExchange["mutationOutcome"];
  readonly omitPropertyKey?: boolean;
}
const EXTRA: readonly SavedCase[] = [
  {
    name: "jira_set_issue_property",
    data: {
      outcome: "unknown",
      reason: "timeout",
      issueId: "10001",
      issueKey: "SYN-1",
      propertyPresent: true,
    },
  },
  {
    name: "jira_delete_project_property",
    data: {
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
      projectId: "10000",
      projectKey: "SYN",
      propertyPresent: false,
    },
  },
  {
    name: "jira_set_board_property",
    data: {
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
      boardId: "7",
      propertyPresent: true,
    },
  },
  {
    name: "jira_delete_sprint_property",
    data: { outcome: "rejected", reason: "permission-denied", sprintId: "9" },
  },
  {
    name: "jira_delete_issue_property",
    data: { outcome: "succeeded", issueId: "10001", issueKey: "SYN-1", propertyPresent: false },
    mutationOutcome: "unknown",
  },
  {
    name: "jira_set_issue_property",
    data: { outcome: "succeeded", issueId: "10001", issueKey: "SYN-1", propertyPresent: true },
    omitPropertyKey: true,
  },
  {
    name: "jira_set_issue_property",
    data: { outcome: "succeeded", issueKey: "SYN-1", propertyPresent: true },
  },
  {
    name: "jira_set_issue_property",
    data: { outcome: "succeeded", issueId: "10001", propertyPresent: true },
  },
  {
    name: "jira_set_issue_property",
    data: { outcome: "succeeded", projectId: "10000", projectKey: "SYN", propertyPresent: true },
  },
  {
    name: "jira_set_issue_property",
    data: {
      outcome: "succeeded",
      issueId: "10001",
      issueKey: "SYN-1",
      boardId: "7",
      propertyPresent: true,
    },
  },
  {
    name: "jira_set_issue_property",
    data: {
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
      projectId: "10000",
      projectKey: "SYN",
      propertyPresent: true,
    },
  },
];
function storedExchange(entry: SavedCase, index: number): ChatToolExchange {
  return {
    call: { id: `property-write-${index}`, name: entry.name, arguments: {} },
    ...(entry.mutationOutcome === undefined ? {} : { mutationOutcome: entry.mutationOutcome }),
    result: {
      schemaVersion: 1,
      invocationId: `property-write-${index}`,
      toolRef: null,
      projectionDigest: null,
      effectStarted: entry.data.outcome !== "rejected",
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data: {
        ...(entry.omitPropertyKey === true ? {} : { propertyKey: "view ~settings" }),
        ...entry.data,
        browseUrl: "https://untrusted.invalid/property",
      },
    },
  };
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("persisted property mutations in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores all sixteen actions with canonical identity, explicit presence and uncertain targets", async () => {
    const completed: SavedCase[] = ENTITIES.flatMap((entity) => [
      {
        name: `jira_set_${entity.tool}_property`,
        data: { ...entity.context, outcome: "succeeded", propertyPresent: true },
      },
      {
        name: `jira_delete_${entity.tool}_property`,
        data: { ...entity.context, outcome: "succeeded", propertyPresent: false },
      },
    ]);
    const exchanges = [...completed, ...EXTRA].map(storedExchange);
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
    for (const entity of ENTITIES) {
      const set = say(
        locale,
        `Set Jira ${entity.en} property`,
        `Jira-${entity.de}-Property setzen`,
      );
      const remove = say(
        locale,
        `Delete Jira ${entity.en} property`,
        `Jira-${entity.de}-Property löschen`,
      );
      expect(screen.getAllByRole("group", { name: set }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("group", { name: remove }).length).toBeGreaterThan(0);
    }
    const present = say(
      locale,
      "The property and its requested value were independently confirmed on the selected entity.",
      "Die Property und ihr angeforderter Wert wurden an der ausgewählten Entität unabhängig bestätigt.",
    );
    const absent = say(
      locale,
      "The property's absence was independently confirmed on the selected entity.",
      "Die Abwesenheit der Property wurde an der ausgewählten Entität unabhängig bestätigt.",
    );
    expect(screen.getAllByText(present, { exact: true })).toHaveLength(8);
    expect(screen.getAllByText(absent, { exact: true })).toHaveLength(8);
    const pending = say(
      locale,
      "Only the requested property state is recorded. The current stored state has not been confirmed.",
      "Nur der angeforderte Property-Zustand ist gespeichert. Der aktuell gespeicherte Zustand wurde nicht bestätigt.",
    );
    expect(screen.getAllByText(pending, { exact: true })).toHaveLength(3);
    const issueDelete = say(locale, "Delete Jira issue property", "Jira-Vorgangs-Property löschen");
    const unknownStatus = say(locale, "Jira outcome unknown", "Ausgang der Jira-Aktion unbekannt");
    const uncertain = screen
      .getAllByRole("group", { name: issueDelete })
      .find((group) => within(group).queryByText(unknownStatus) !== null);
    if (uncertain === undefined) throw new TypeError("Missing stored uncertain property mutation");
    expect(within(uncertain).queryByText(absent)).toBeNull();
    expect(within(uncertain).getByText(pending)).toBeVisible();
    const identityUnknown = say(
      locale,
      "No valid property-state confirmation was recorded.",
      "Es wurde keine gültige Bestätigung des Property-Zustands gespeichert.",
    );
    const issueSet = say(locale, "Set Jira issue property", "Jira-Vorgangs-Property setzen");
    const invalid = screen
      .getAllByRole("group", { name: issueSet })
      .filter((group) => within(group).queryByText(identityUnknown) !== null);
    expect(invalid).toHaveLength(6);
    for (const group of invalid) {
      expect(within(group).queryByText(present)).toBeNull();
      expect(within(group).queryByText(absent)).toBeNull();
      expect(
        within(group).queryByText(say(locale, "Jira change confirmed", "Jira-Änderung bestätigt")),
      ).toBeNull();
      expect(
        within(group).queryByText(say(locale, "Already up to date", "Bereits aktuell")),
      ).toBeNull();
    }
    expect(
      screen.getByText(say(locale, "Already up to date", "Bereits aktuell"), { exact: true }),
    ).toBeVisible();
    for (const value of ["view ~settings", "SYN-1", "JIRAUSER10100", "Synthetic-User"])
      expect(container.textContent).toContain(value);
    expect(container.querySelector("pre, a, img")).toBeNull();
    expect(buttonsOutsideProgress(container)).toEqual([]);
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(await axe(container)).toHaveNoViolations();
  });
});
