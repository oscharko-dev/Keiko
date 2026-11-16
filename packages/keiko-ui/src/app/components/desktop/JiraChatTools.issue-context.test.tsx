import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { partialJiraReadPage } from "./jira-result.test-fixture";

const PARENT = { issueId: "10001", issueKey: "SYN-1" };
const CASES: readonly [string, CatalogJsonObject][] = [
  [
    "jira_issue_picker",
    {
      suggestionsScope: "native-suggestions",
      sections: [
        {
          id: "history",
          label: "Recent issues",
          issues: [
            {
              key: "SYN-2",
              summary: "Suggested issue",
              browseUrl: "https://jira.example.test/context/browse/SYN-2",
            },
            {
              key: "SYN-9",
              summary: "Saved invalid destination",
              browseUrl: "https://untrusted.invalid/browse/OTHER-9",
            },
          ],
        },
        { id: "empty", issues: [] },
        { id: "unknown" },
      ],
    },
  ],
  [
    "jira_pinned_comments",
    {
      ...PARENT,
      items: [
        {
          id: "10002",
          body: "Pinned native text",
          created: "Native creation date",
          author: { name: "synthetic-user", displayName: "Synthetic author" },
          pinnedBy: "Pin owner",
          pinnedDate: "Native pin date",
        },
      ],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira_subtasks",
    {
      ...PARENT,
      items: [
        {
          id: "10003",
          key: "SYN-3",
          summary: "Observed subtask",
          status: { name: "Open" },
          browseUrl: "https://jira.example.test/context/browse/SYN-3",
        },
      ],
      startAt: 0,
      total: 1,
    },
  ],
  ["jira_subtask_move_availability", { ...PARENT, canReorderSubtasks: false }],
  [
    "jira_remote_links",
    {
      ...PARENT,
      items: [
        {
          id: "71",
          title: "Observed remote title",
          summary: "Observed remote summary",
          resolved: false,
          globalId: "app=synthetic&id=1",
          application: { name: "Reference app", type: "synthetic" },
          relationship: "references",
          url: "https://untrusted.invalid/target",
        },
      ],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira_remote_link",
    { ...PARENT, id: "72", title: "Another observed remote title", resolved: true },
  ],
  ["jira_subtask_move_availability", { ...PARENT, canReorderSubtasks: true }],
  ["jira_subtask_move_availability", { ...PARENT }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("persistent Jira issue-context cards in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores six read families with scoped observations and unchanged accessible labels", async () => {
    const exchanges = CASES.map(([name, data], index): ChatToolExchange => ({
      call: { id: `context-${index}`, name, arguments: {} },
      result: {
        schemaVersion: 1,
        invocationId: `context-${index}`,
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
        ? ([
            "Read Jira issue suggestions",
            "Read pinned Jira comments",
            "Read Jira subtasks",
            "Read Jira subtask ordering availability",
            "Read Jira remote link metadata",
            "Read a Jira remote link's metadata",
          ] as const)
        : ([
            "Jira-Vorgangsvorschläge lesen",
            "Angeheftete Jira-Kommentare lesen",
            "Jira-Unteraufgaben lesen",
            "Verfügbarkeit der Jira-Unteraufgabenreihenfolge lesen",
            "Metadaten externer Jira-Verknüpfungen lesen",
            "Metadaten einer externen Jira-Verknüpfung lesen",
          ] as const);
    for (const name of groups)
      expect(screen.getAllByRole("group", { name }).length).toBeGreaterThan(0);
    const picker = screen.getByRole("group", { name: groups[0] });
    expect(
      within(picker).getByRole("link", {
        name:
          locale === "en"
            ? "SYN-2 Suggested issue (opens Jira in a new tab)"
            : "SYN-2 Suggested issue (öffnet Jira in einem neuen Tab)",
      }),
    ).toHaveAttribute("href", "https://jira.example.test/context/browse/SYN-2");
    expect(within(picker).queryByRole("link", { name: "SYN-9" })).toBeNull();
    const subtasks = screen.getByRole("group", { name: groups[2] });
    expect(
      within(subtasks).getByRole("link", {
        name:
          locale === "en"
            ? "SYN-3 Observed subtask (opens Jira in a new tab)"
            : "SYN-3 Observed subtask (öffnet Jira in einem neuen Tab)",
      }),
    ).toHaveAttribute("href", "https://jira.example.test/context/browse/SYN-3");
    const observations =
      locale === "en"
        ? [
            "These are Jira's returned suggestions, not a complete issue list or a permission grant.",
            "Jira reported that ordering is unavailable.",
            "Jira reported that ordering is available.",
            "Ordering availability was not provided.",
            "Native resolved flag: false",
            "Native resolved flag: true",
            "Pinned by: Pin owner",
          ]
        : [
            "Dies sind die von Jira gelieferten Vorschläge, keine vollständige Vorgangsliste und keine Berechtigungserteilung.",
            "Jira meldet, dass eine Änderung der Reihenfolge nicht verfügbar ist.",
            "Jira meldet, dass eine Änderung der Reihenfolge verfügbar ist.",
            "Die Verfügbarkeit einer Änderung der Reihenfolge wurde nicht geliefert.",
            "Nativer Erledigt-Status: falsch",
            "Nativer Erledigt-Status: wahr",
            "Angeheftet von: Pin owner",
          ];
    for (const value of [
      ...observations,
      "Pinned native text",
      "Synthetic author",
      "Observed remote title",
      "Observed remote summary",
    ])
      expect(container.textContent).toContain(value);
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(container.querySelector("pre, img")).toBeNull();
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(await axe(container)).toHaveNoViolations();
  });
});
