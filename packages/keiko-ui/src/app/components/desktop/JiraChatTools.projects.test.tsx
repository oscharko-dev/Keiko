import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { JIRA_MUTATION_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const PROJECT_ID = "9223372036854775807";
const PROJECT_URL = "https://jira.example.test/context/projects/SYN/summary";
const PROJECT = {
  projectId: PROJECT_ID,
  projectKey: "SYN",
  projectName: "Delivery workspace",
  browseUrl: PROJECT_URL,
};

function projectExchange(
  data: CatalogJsonObject,
  operation = "jira_create_project",
): ChatToolExchange {
  return {
    call: { id: "project-call", name: operation, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "project-invocation",
      toolRef: null,
      projectionDigest: null,
      effectStarted: JIRA_MUTATION_OPERATIONS.some(
        (name) => name.replace(/[.-]/gu, "_") === operation,
      ),
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data,
    },
  };
}

function show(exchange: ChatToolExchange): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [exchange] }}
        turnState="completed"
      />
    </I18nProvider>,
  );
}

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));

describe.each(["en", "de"] as const)("persistent Jira deletion receipts in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it.each(["succeeded", "succeeded-unconfirmed", "unknown"] as const)(
    "restores exact delete targets with the authoritative %s journal state",
    async (state) => {
      const cases: readonly [string, string, string, string][] = [
        ["jira_delete_comment", "commentId", "Comment ID", "Kommentar-ID"],
        ["jira_delete_attachment", "attachmentId", "Attachment ID", "Anhang-ID"],
        ["jira_delete_worklog", "worklogId", "Worklog ID", "Arbeitsprotokoll-ID"],
      ];
      const exchanges = cases.map(([operation, field], index): ChatToolExchange => ({
        ...projectExchange(
          {
            outcome: "succeeded",
            issueKey: `SYN-${String(index + 1)}`,
            issueId: String(10000 + index),
            [field]: "9007199254740993",
            browseUrl: `https://jira.example.test/context/browse/SYN-${String(index + 1)}`,
            self: "https://untrusted.invalid/deleted-resource",
            content: "https://untrusted.invalid/download",
          },
          operation,
        ),
        call: { id: `delete-${String(index)}`, name: operation, arguments: {} },
        mutationOutcome: state,
      }));
      const restored = JSON.parse(
        JSON.stringify({ schemaVersion: 1, exchanges }),
      ) as ChatToolTranscript;
      const renderReceipt = (): ReturnType<typeof render> =>
        render(
          <I18nProvider>
            <JiraChatTools transcript={restored} turnState="completed" />
          </I18nProvider>,
        );
      const first = renderReceipt();
      const priorText = first.container.textContent;
      first.unmount();
      const { container } = renderReceipt();
      expect(container.textContent).toBe(priorText);
      for (const [, , en, de] of cases)
        expect(screen.getByText(`${locale === "en" ? en : de}: 9007199254740993`)).toBeVisible();
      const labels =
        locale === "en"
          ? {
              succeeded: "Jira change confirmed",
              "succeeded-unconfirmed": "Jira accepted the change; confirmation incomplete",
              unknown: "Jira outcome unknown",
            }
          : {
              succeeded: "Jira-Änderung bestätigt",
              "succeeded-unconfirmed": "Jira hat die Änderung angenommen; Bestätigung unvollständig",
              unknown: "Ausgang der Jira-Aktion unbekannt",
            };
      expect(screen.getAllByText(labels[state])).toHaveLength(3);
      if (state !== "succeeded") expect(screen.queryByText(labels.succeeded)).toBeNull();
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(3);
      for (const [index, link] of links.entries())
        expect(link).toHaveAttribute(
          "href",
          `https://jira.example.test/context/browse/SYN-${String(index + 1)}`,
        );
      expect(container.querySelector("pre, img, a[download]")).toBeNull();
      expect(container.textContent).not.toContain("untrusted.invalid");
      expect(await axe(container)).toHaveNoViolations();
    },
  );
  it.each([
    ["jira_delete_comment", { worklogId: "92", attachmentId: "93" }],
    ["jira_delete_attachment", { commentId: "91", worklogId: "92" }],
    ["jira_delete_worklog", { commentId: "91", attachmentId: "93" }],
  ] as const)(
    "does not invent %s identity from another entity or the issue ID",
    (operation, other) => {
      const { container } = show(
        projectExchange(
          { outcome: "unknown", issueKey: "SYN-7", issueId: "10007", id: "10007", ...other },
          operation,
        ),
      );
      for (const value of ["91", "92", "93", "10007"])
        expect(container.textContent).not.toContain(`: ${value}`);
      expect(
        screen.getByText(
          locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt",
        ),
      ).toBeVisible();
    },
  );
});

describe.each(["en", "de"] as const)("screen and scheme inspection in %s (C9)", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores all fourteen configuration reads with named cards, mappings and no invented links", async () => {
    const scheme = {
      id: "21",
      name: "Delivery types",
      issueTypes: [
        { id: "10001", name: "Story", subtask: false },
        { id: "10002", name: "Child", subtask: true },
        { id: "10003", name: "Unspecified" },
      ],
      defaultIssueType: { id: "10001", name: "Story" },
    };
    const cases: readonly [string, CatalogJsonObject, string, string][] = [
      [
        "jira_screen_tabs",
        {
          screenId: "7",
          items: [{ id: "10", name: "Main", self: "https://untrusted.invalid/tab" }],
          startAt: 0,
          total: 1,
        },
        "Read Jira screen tabs",
        "Jira-Masken-Tabs lesen",
      ],
      [
        "jira_screen_tab_fields",
        {
          screenId: "7",
          tabId: "10",
          items: [
            {
              id: "customfield_10010",
              name: "Acceptance criteria",
              type: "custom",
              showWhenEmpty: false,
              required: true,
            },
          ],
          startAt: 0,
          total: 1,
        },
        "Read Jira screen tab fields",
        "Felder eines Jira-Masken-Tabs lesen",
      ],
      [
        "jira_screen_available_fields",
        { screenId: "7", items: [], startAt: 0, total: 0 },
        "Read available Jira screen fields",
        "Verfügbare Jira-Maskenfelder lesen",
      ],
      [
        "jira_issue_type_schemes",
        { items: [scheme], startAt: 0, total: 1 },
        "Read Jira issue type schemes",
        "Jira-Vorgangstyp-Schemata lesen",
      ],
      [
        "jira_issue_type_scheme",
        { schemeId: "22", items: [{ id: "22", name: "Other types" }] },
        "Read Jira issue type scheme",
        "Jira-Vorgangstyp-Schema lesen",
      ],
      [
        "jira_issue_type_scheme_projects",
        {
          schemeId: "21",
          items: [
            {
              id: "71",
              key: "SYN",
              name: "Delivery project",
              archived: false,
              browseUrl: "https://untrusted.invalid/project",
            },
          ],
          startAt: 0,
          total: 1,
        },
        "Read projects using a Jira issue type scheme",
        "Projekte eines Jira-Vorgangstyp-Schemas lesen",
      ],
      [
        "jira_workflow_scheme",
        {
          schemeId: "44",
          id: "44",
          name: "Delivery flow",
          draft: false,
          defaultWorkflow: "Default live",
          items: [
            { issueTypeId: "10001", workflow: "Story live", originalWorkflow: "Story original" },
          ],
          startAt: 0,
          total: 1,
        },
        "Read Jira workflow scheme",
        "Jira-Workflow-Schema lesen",
      ],
      [
        "jira_workflow_scheme_draft",
        {
          schemeId: "44",
          id: "45",
          name: "Delivery draft",
          draft: true,
          originalDefaultWorkflow: "Original default",
          items: [],
          startAt: 0,
          total: 0,
        },
        "Read Jira workflow scheme draft",
        "Jira-Workflow-Schemaentwurf lesen",
      ],
      [
        "jira_workflow_scheme_default",
        { schemeId: "44", workflow: "Default live" },
        "Read Jira default workflow mapping",
        "Jira-Standardworkflow-Zuordnung lesen",
      ],
      [
        "jira_workflow_scheme_draft_default",
        { schemeId: "44", workflow: "Default draft" },
        "Read Jira draft default workflow mapping",
        "Jira-Standardworkflow-Zuordnung im Entwurf lesen",
      ],
      [
        "jira_workflow_scheme_issue_type",
        { schemeId: "44", issueTypeId: "10001", workflow: "Story live" },
        "Read Jira issue type workflow mapping",
        "Jira-Vorgangstyp-Workflow-Zuordnung lesen",
      ],
      [
        "jira_workflow_scheme_draft_issue_type",
        { schemeId: "44", issueTypeId: "10001", workflow: "Story draft" },
        "Read Jira draft issue type workflow mapping",
        "Jira-Vorgangstyp-Workflow-Zuordnung im Entwurf lesen",
      ],
      [
        "jira_workflow_scheme_workflows",
        {
          schemeId: "44",
          items: [{ workflow: "Live mapping", issueTypeIds: ["10001"], defaultMapping: false }],
          startAt: 0,
          total: 1,
        },
        "Read Jira workflow mappings",
        "Jira-Workflow-Zuordnungen lesen",
      ],
      [
        "jira_workflow_scheme_draft_workflows",
        {
          schemeId: "44",
          items: [{ workflow: "Draft mapping", issueTypeIds: [], defaultMapping: true }],
          startAt: 0,
          total: 1,
        },
        "Read Jira draft workflow mappings",
        "Jira-Workflow-Zuordnungen im Entwurf lesen",
      ],
    ];
    const exchanges = cases.map(([operation, data], index) => {
      const exchange = projectExchange({ outcome: "succeeded", ...data }, operation);
      return { ...exchange, call: { ...exchange.call, id: `administration-${String(index)}` } };
    });
    const transcript = { schemaVersion: 1 as const, exchanges };
    const initial = render(
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="completed" />
      </I18nProvider>,
    );
    initial.unmount();
    const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={restored} turnState="completed" />
      </I18nProvider>,
    );
    for (const [, , en, de] of cases)
      expect(screen.getByRole("group", { name: locale === "en" ? en : de })).toBeVisible();
    for (const value of locale === "en"
      ? [
          "Field ID: customfield_10010",
          "Hidden when empty",
          "Default issue type: Story (10001)",
          "Standard issue types: Story (10001)",
          "Subtask issue types: Child (10002)",
          "Issue types with unspecified kind: Unspecified (10003)",
          "Returned scheme ID: 45",
          "Draft scheme",
          "Original workflow: Story original",
          "Mapped issue types returned: 0",
        ]
      : [
          "Feld-ID: customfield_10010",
          "Wird leer ausgeblendet",
          "Standardvorgangstyp: Story (10001)",
          "Standardvorgangstypen: Story (10001)",
          "Unteraufgabentypen: Child (10002)",
          "Vorgangstypen ohne angegebene Art: Unspecified (10003)",
          "Zurückgegebene Schema-ID: 45",
          "Schemaentwurf",
          "Ursprünglicher Workflow: Story original",
          "Gelieferte zugeordnete Vorgangstypen: 0",
        ])
      expect(screen.getByText(value, { exact: true })).toBeVisible();
    expect(
      screen.queryByText(locale === "en" ? "Required" : "Erforderlich", { exact: true }),
    ).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(await axe(container)).toHaveNoViolations();
  });
  it("keeps an original-only mapping distinct from an unknown current mapping", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          schemeId: "44",
          id: "45",
          items: [{ issueTypeId: "10001", originalWorkflow: "Original flow" }],
          startAt: 0,
          total: 1,
        },
        "jira_workflow_scheme_draft",
      ),
    );
    expect(
      screen.getByText(
        locale === "en"
          ? "Original workflow: Original flow"
          : "Ursprünglicher Workflow: Original flow",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "The current mapping was not supplied; the original mapping is shown separately."
          : "Die aktuelle Zuordnung wurde nicht geliefert; die ursprüngliche Zuordnung wird separat angezeigt.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Workflow: Original flow", { exact: true })).toBeNull();
  });
  it("keeps unreturned mappings unknown rather than claiming an empty scheme", () => {
    show(
      projectExchange(
        { outcome: "succeeded", schemeId: "44", id: "45", name: "Draft without mapping data" },
        "jira_workflow_scheme_draft",
      ),
    );
    expect(
      screen.getByText(
        locale === "en"
          ? "Issue type mappings were not supplied; their contents are unknown."
          : "Vorgangstypzuordnungen wurden nicht geliefert; ihr Inhalt ist unbekannt.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/Mapped issue types returned|Gelieferte zugeordnete Vorgangstypen/u),
    ).toBeNull();
    expect(
      screen.queryByText(locale === "en" ? "Draft scheme" : "Schemaentwurf", { exact: true }),
    ).toBeNull();
  });
  it("preserves local page incompleteness for screen fields", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          screenId: "7",
          startAt: 1,
          total: 3,
          nextStartAt: 2,
          items: [{ id: "summary", name: "Summary" }],
        },
        "jira_screen_available_fields",
      ),
    );
    expect(
      screen.getByText(
        locale === "en"
          ? "Partial Jira result. Some available data is not included."
          : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        /Shown when empty|Hidden when empty|Wird leer angezeigt|Wird leer ausgeblendet/u,
      ),
    ).toBeNull();
  });
});

describe.each(["en", "de"] as const)("worklog and participation results in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores worklog identities, observed account state and partial visible lists accessibly", async () => {
    const exchanges = [
      projectExchange(
        { outcome: "succeeded", issueKey: "SYN-7", worklogId: "9007199254740993" },
        "jira_create_worklog",
      ),
      projectExchange(
        { outcome: "succeeded", issueKey: "SYN-8", worklogId: "92" },
        "jira_update_worklog",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          issueKey: "SYN-9",
          watchCount: 3,
          isWatching: true,
          items: [{ name: "delivery-reviewer", displayName: "Delivery reviewer" }],
          startAt: 0,
          total: 1,
          listComplete: false,
        },
        "jira_watchers",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          issueKey: "SYN-10",
          votes: 0,
          hasVoted: false,
          items: [],
          startAt: 0,
          total: 0,
          listComplete: true,
        },
        "jira_votes",
      ),
      ...["jira_watch", "jira_unwatch", "jira_vote", "jira_unvote"].map((operation, index) =>
        projectExchange(
          {
            outcome: "succeeded",
            issueKey: `SYN-${String(20 + index)}`,
            ...(index < 2 ? { isWatching: index === 0 } : { hasVoted: index === 2 }),
          },
          operation,
        ),
      ),
    ].map((exchange, index) => ({
      ...exchange,
      call: { ...exchange.call, id: `collaboration-result-${String(index)}` },
    }));
    const restored = JSON.parse(
      JSON.stringify({ schemaVersion: 1, exchanges }),
    ) as ChatToolTranscript;
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={restored} turnState="completed" />
      </I18nProvider>,
    );
    expect(
      screen.getByText(
        locale === "en" ? "Worklog ID: 9007199254740993" : "Arbeitsprotokoll-ID: 9007199254740993",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Total watchers: 3" : "Beobachter insgesamt: 3"),
    ).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Total votes: 0" : "Stimmen insgesamt: 0"),
    ).toBeVisible();
    expect(screen.getByText("Delivery reviewer")).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Jira did not expose the complete member list. The total may include people not shown here."
          : "Jira hat die vollständige Mitgliederliste nicht offengelegt. Die Gesamtzahl kann hier nicht angezeigte Personen einschließen.",
      ),
    ).toBeVisible();
    expect(
      screen.getAllByText(
        locale === "en"
          ? "Your account is watching this issue."
          : "Dein Konto beobachtet diesen Vorgang.",
      ),
    ).toHaveLength(2);
    expect(
      screen.getByText(
        locale === "en"
          ? "Your account is not watching this issue."
          : "Dein Konto beobachtet diesen Vorgang nicht.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Your account has voted for this issue."
          : "Dein Konto hat für diesen Vorgang abgestimmt.",
      ),
    ).toBeVisible();
    expect(
      screen.getAllByText(
        locale === "en"
          ? "Your account has not voted for this issue."
          : "Dein Konto hat für diesen Vorgang nicht abgestimmt.",
      ),
    ).toHaveLength(2);
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("keeps an uncertain journal authoritative over a claimed confirmed account state", () => {
    show({
      ...projectExchange(
        { outcome: "succeeded", issueKey: "SYN-7", isWatching: false },
        "jira_watch",
      ),
      mutationOutcome: "unknown",
    });
    expect(
      screen.getByText(
        locale === "en"
          ? "The watching state of your account is not confirmed."
          : "Der Beobachtungsstatus deines Kontos ist nicht bestätigt.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        locale === "en"
          ? "Your account is not watching this issue."
          : "Dein Konto beobachtet diesen Vorgang nicht.",
      ),
    ).toBeNull();
  });
  it.each(["jira_watch", "jira_vote"])(
    "does not turn uncertain %s into a confirmed boolean",
    (operation) => {
      show(
        projectExchange(
          { outcome: "unknown", issueKey: "SYN-7", isWatching: false, hasVoted: false },
          operation,
        ),
      );
      expect(
        screen.getByText(
          operation === "jira_watch"
            ? locale === "en"
              ? "The watching state of your account is not confirmed."
              : "Der Beobachtungsstatus deines Kontos ist nicht bestätigt."
            : locale === "en"
              ? "The vote of your account is not confirmed."
              : "Die Stimme deines Kontos ist nicht bestätigt.",
        ),
      ).toBeVisible();
      expect(
        screen.queryByText(
          /Your account is not watching|Your account has not voted|Dein Konto beobachtet diesen Vorgang nicht|Dein Konto hat für diesen Vorgang nicht abgestimmt/u,
        ),
      ).toBeNull();
    },
  );
});

describe.each(["en", "de"] as const)("saved Agile destinations in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores direct board and Epic destinations and labels sprint context as a board", async () => {
    const boardUrl = "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=7";
    const exchanges = [
      projectExchange(
        { outcome: "succeeded", boardId: "7", browseUrl: boardUrl },
        "jira_board_create",
      ),
      projectExchange(
        {
          outcome: "succeeded-unconfirmed",
          sprintId: "9",
          originBoardId: "7",
          boardBrowseUrl: boardUrl,
        },
        "jira_sprint_update",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          epicKey: "SYN-10",
          issueKeys: ["SYN-11"],
          browseUrl: "https://jira.example.test/context/browse/SYN-10",
        },
        "jira_epic_move_issues",
      ),
    ].map((exchange, index) => ({
      ...exchange,
      call: { ...exchange.call, id: `agile-destination-${String(index)}` },
    }));
    const transcript = { schemaVersion: 1 as const, exchanges };
    const initial = render(
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="completed" />
      </I18nProvider>,
    );
    initial.unmount();
    const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={restored} turnState="completed" />
      </I18nProvider>,
    );
    const links = screen.getAllByRole("link", {
      name: locale === "en" ? /Open board/u : /Board öffnen/u,
    });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute("href", boardUrl);
    expect(screen.getByRole("link", { name: /SYN-10/u })).toHaveAttribute(
      "href",
      "https://jira.example.test/context/browse/SYN-10",
    );
    expect(screen.queryByRole("link", { name: /Sprint/u })).toBeNull();
    expect(screen.getByText(locale === "en" ? "Sprint ID: 9" : "Sprint-ID: 9")).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Jira accepted the change; confirmation incomplete"
          : "Jira hat die Änderung angenommen; Bestätigung unvollständig",
      ),
    ).toBeVisible();
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it.each([
    {
      originBoardId: "7",
      boardBrowseUrl: "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=8",
    },
    {
      originBoardId: "7",
      boardBrowseUrl:
        "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=7&extra=true",
    },
    { originBoardId: "7", boardBrowseUrl: "https://jira.example.test/context/browse/SYN-10" },
    { boardBrowseUrl: "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=7" },
  ])("does not turn absent or mismatched sprint context into a link %#", (context) => {
    show(
      projectExchange({ outcome: "succeeded", sprintId: "9", ...context }, "jira_sprint_update"),
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe.each(["en", "de"] as const)("file and avatar metadata in %s (C8)", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores all eight metadata reads with named accessible cards and no image or download destinations", async () => {
    const exchanges = [
      projectExchange(
        { outcome: "succeeded", enabled: true, uploadLimit: 1000, maxBytes: 500 },
        "jira_attachment_settings",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          attachmentId: "9007199254740993",
          filename: "delivery.txt",
          size: 0,
          mimeType: "text/plain",
          created: "2026-11-07T10:00:00Z",
          content: "https://untrusted.invalid/file",
        },
        "jira_attachment",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          attachmentId: "92",
          items: [{ entryIndex: 0, abbreviatedName: "source…", size: 42 }],
          startAt: 0,
          total: 1,
          totalEntryCount: 3,
          entriesComplete: false,
        },
        "jira_attachment_archive",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          attachmentId: "93",
          name: "release.zip",
          mediaType: "application/zip",
          totalEntryCount: 7,
        },
        "jira_attachment_archive_summary",
      ),
      ...["jira_system_avatars", "jira_project_avatars", "jira_user_avatars", "jira_avatars"].map(
        (operation, index) =>
          projectExchange(
            {
              outcome: "succeeded",
              startAt: 0,
              total: 1,
              items: [
                {
                  id: String(index + 1),
                  category: index === 0 ? "system" : "custom",
                  ...(index === 0 ? { selected: false } : index === 1 ? { selected: true } : {}),
                  owner: "Delivery owner",
                  self: "https://untrusted.invalid/avatar",
                  urls: { "48x48": "https://untrusted.invalid/image" },
                  browseUrl: "https://untrusted.invalid/browse/SYN-7",
                  issueKey: "SYN-7",
                },
              ],
            },
            operation,
          ),
      ),
    ].map((exchange, index) => ({
      ...exchange,
      call: { ...exchange.call, id: `asset-${String(index)}` },
    }));
    const transcript = { schemaVersion: 1 as const, exchanges };
    const initial = render(
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="completed" />
      </I18nProvider>,
    );
    expect(screen.getByText("delivery.txt")).toBeVisible();
    initial.unmount();
    const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={restored} turnState="completed" />
      </I18nProvider>,
    );
    const actionNames =
      locale === "en"
        ? [
            "Read Jira attachment settings",
            "Read Jira attachment metadata",
            "Read Jira archive entry metadata",
            "Read Jira archive summary",
            "Read Jira system avatar metadata",
            "Read Jira project avatar metadata",
            "Read Jira user avatar metadata",
            "Read Jira avatar metadata",
          ]
        : [
            "Jira-Anhangseinstellungen lesen",
            "Jira-Anhangsmetadaten lesen",
            "Jira-Archiveintragsmetadaten lesen",
            "Jira-Archivübersicht lesen",
            "Jira-Systemavatar-Metadaten lesen",
            "Jira-Projektavatar-Metadaten lesen",
            "Jira-Benutzeravatar-Metadaten lesen",
            "Jira-Avatar-Metadaten lesen",
          ];
    for (const name of actionNames) expect(screen.getByRole("group", { name })).toBeVisible();
    for (const value of locale === "en"
      ? [
          "Attachment ID: 9007199254740993",
          "Size in bytes: 0",
          "Archive entry index: 0",
          "Total entries in archive: 3",
          "Attachments enabled",
          "System avatar",
          "Selected",
          "Not selected",
          "Jira returned metadata for only part of the archive.",
        ]
      : [
          "Anhang-ID: 9007199254740993",
          "Größe in Bytes: 0",
          "Archiveintragsindex: 0",
          "Einträge im gesamten Archiv: 3",
          "Anhänge aktiviert",
          "Systemavatar",
          "Ausgewählt",
          "Nicht ausgewählt",
          "Jira hat nur für einen Teil des Archivs Metadaten geliefert.",
        ])
      expect(screen.getByText(value, { exact: true })).toBeVisible();
    expect(
      screen.getAllByText(locale === "en" ? "Selection unknown" : "Auswahl unbekannt"),
    ).toHaveLength(2);
    expect(screen.getByText("source…")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("pre, img, video, audio")).toBeNull();
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.textContent).not.toContain("SYN-7");
    expect(await axe(container)).toHaveNoViolations();
  });
  it("keeps omitted archive sizes and native totals unknown while showing the entry index", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          attachmentId: "92",
          startAt: 0,
          total: 1,
          items: [{ entryIndex: 4 }],
        },
        "jira_attachment_archive",
      ),
    );
    expect(
      screen.getByText(locale === "en" ? "Archive entry index: 4" : "Archiveintragsindex: 4"),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "The total archive size is unknown; these entries may be incomplete."
          : "Der Gesamtumfang des Archivs ist unbekannt; diese Einträge können unvollständig sein.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        /Size in bytes|Größe in Bytes|Total entries in archive|Einträge im gesamten Archiv/u,
      ),
    ).toBeNull();
  });
  it("does not turn missing upload limits into zero or disabled attachments", () => {
    show(projectExchange({ outcome: "succeeded", enabled: true }, "jira_attachment_settings"));
    expect(
      screen.getByText(locale === "en" ? "Attachments enabled" : "Anhänge aktiviert"),
    ).toBeVisible();
    expect(screen.queryByText(/limit in bytes|limit in Bytes/u)).toBeNull();
    expect(
      screen.queryByText(locale === "en" ? "Attachments disabled" : "Anhänge deaktiviert"),
    ).toBeNull();
  });
  it("distinguishes complete native archive metadata from the current local page", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          attachmentId: "92",
          startAt: 1,
          total: 3,
          nextStartAt: 2,
          totalEntryCount: 3,
          entriesComplete: true,
          items: [{ entryIndex: 1, name: "middle.txt" }],
        },
        "jira_attachment_archive",
      ),
    );
    expect(
      screen.getByText(
        locale === "en"
          ? "All archive entry metadata returned by Jira. The displayed page may contain only part of it."
          : "Jira hat die Metadaten aller Archiveinträge geliefert. Die angezeigte Seite kann nur einen Teil enthalten.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Partial Jira result. Some available data is not included."
          : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
      ),
    ).toBeVisible();
  });
});

describe.each(["en", "de"] as const)("changed source requirements in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores actionable source-change guidance from the real pre-approval refusal shape", () => {
    const data = {
      outcome: "rejected",
      reason: "field-validation",
      requirementRefusal: "source-changed",
    };
    const receipt = projectExchange(data, "jira_draft");
    if (receipt.result?.status !== "completed") throw new Error("Missing source-refusal fixture");
    const rejected: ChatToolExchange = {
      ...receipt,
      result: {
        ...receipt.result,
        effectStarted: false,
        status: "failed",
        reason: "provider-reported-error",
        page: null,
        data,
      },
    };
    const restored = JSON.parse(JSON.stringify(rejected)) as ChatToolExchange;
    const { container } = show(restored);
    expect(
      screen.getByText(
        locale === "en"
          ? "The source requirements changed. Read them again and prepare the draft again. No change was made in Jira."
          : "Die Quellanforderungen haben sich geändert. Lies sie erneut und bereite den Entwurf neu vor. In Jira wurde nichts geändert.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /retry|wiederholen/iu })).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });
});

describe.each(["en", "de"] as const)("explicit unchanged receipts in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores an explicit no-change observation without presenting rejection or inventing success", () => {
    const data = {
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
      issueKey: "SYN-7",
      commentId: "91",
    };
    const receipt = projectExchange(data, "jira_update_comment");
    if (receipt.result?.status !== "completed") throw new Error("Missing unchanged fixture result");
    const rejected: ChatToolExchange = {
      ...receipt,
      mutationOutcome: "rejected",
      result: {
        ...receipt.result,
        effectStarted: false,
        status: "failed",
        reason: "provider-reported-error",
        page: null,
        data,
      },
    };
    const stored = JSON.parse(JSON.stringify(rejected)) as ChatToolExchange;
    show(stored);
    expect(
      screen.getByText(locale === "en" ? "Already up to date" : "Bereits aktuell"),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "The requested values already match Jira. No change was made."
          : "Die gewünschten Werte stimmen bereits mit Jira überein. Es wurde nichts geändert.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(locale === "en" ? "Jira action rejected" : "Jira-Aktion abgelehnt"),
    ).toBeNull();
    expect(screen.queryByText(/The Jira state changed|Der Jira-Stand hat sich/u)).toBeNull();
    expect(stored.result?.data).toMatchObject({ outcome: "rejected" });
  });
  it.each([
    { outcome: "rejected", reason: "conflict" },
    { outcome: "rejected", reason: "permission-denied", unchanged: true },
    { outcome: "unknown", reason: "conflict", unchanged: true },
  ])("keeps other conflicts, refusals and unknown outcomes actionable", (data) => {
    show(projectExchange(data, "jira_update_comment"));
    expect(
      screen.queryByText(locale === "en" ? "Already up to date" : "Bereits aktuell"),
    ).toBeNull();
  });
  it("keeps an unknown journal outcome authoritative over a contradictory unchanged payload", () => {
    show({
      ...projectExchange(
        { outcome: "rejected", reason: "conflict", unchanged: true },
        "jira_update_comment",
      ),
      mutationOutcome: "unknown",
    });
    expect(
      screen.queryByText(locale === "en" ? "Already up to date" : "Bereits aktuell"),
    ).toBeNull();
    expect(
      screen.getByText(
        locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt",
      ),
    ).toBeVisible();
  });
});

describe.each(["en", "de"] as const)(
  "saved views and sharing observations in %s (C7)",
  (locale) => {
    beforeEach(async () => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
    });
    it("restores dashboard identities and configured share facts accessibly without remote links or JSON", async () => {
      const exchanges = [
        projectExchange(
          {
            outcome: "succeeded",
            startAt: 0,
            total: 1,
            items: [
              {
                id: "9007199254740993",
                name: "Delivery dashboard",
                view: "https://untrusted.invalid/dashboard",
                browseUrl: "https://untrusted.invalid/browse/SYN-7",
                issueKey: "SYN-7",
              },
            ],
          },
          "jira_dashboards",
        ),
        projectExchange(
          {
            outcome: "succeeded",
            filterId: "700",
            items: [
              { id: "91", type: "group", groupName: "Delivery group", edit: false, view: true },
              { id: "92", type: "future-share", roleId: "5", roleName: "Developers" },
            ],
          },
          "jira_filter_permissions",
        ),
        projectExchange({ outcome: "succeeded", scope: "PRIVATE" }, "jira_filter_share_scope"),
      ].map((exchange, index) => ({
        ...exchange,
        call: { ...exchange.call, id: `saved-view-${String(index)}` },
      }));
      const transcript = { schemaVersion: 1 as const, exchanges };
      const initial = render(
        <I18nProvider>
          <JiraChatTools transcript={transcript} turnState="completed" />
        </I18nProvider>,
      );
      expect(screen.getByText("Delivery dashboard")).toBeVisible();
      initial.unmount();
      const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
      const { container } = render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
      for (const value of locale === "en"
        ? [
            "Dashboard ID: 9007199254740993",
            "Group: Delivery group",
            "Role: Developers",
            "Share type: future-share",
            "Entry does not grant editing",
            "Entry grants viewing",
            "Default sharing: private",
          ]
        : [
            "Dashboard-ID: 9007199254740993",
            "Gruppe: Delivery group",
            "Rolle: Developers",
            "Freigabetyp: future-share",
            "Eintrag erlaubt kein Bearbeiten",
            "Eintrag erlaubt Anzeigen",
            "Standardfreigabe: privat",
          ])
        expect(screen.getByText(value, { exact: true })).toBeVisible();
      expect(
        screen.getAllByText(
          locale === "en" ? "Saved filter ID: 700" : "Gespeicherte Filter-ID: 700",
        ),
      ).toHaveLength(2);
      expect(
        screen.getByText(
          locale === "en"
            ? "This is the default for future filters, not the sharing state of an existing filter."
            : "Dies ist die Voreinstellung für künftige Filter, nicht der Freigabestatus eines vorhandenen Filters.",
        ),
      ).toBeVisible();
      expect(screen.queryByRole("link")).toBeNull();
      expect(container.querySelector("pre, details")).toBeNull();
      expect(
        screen.getByRole("group", {
          name: locale === "en" ? "Read Jira dashboards" : "Jira-Dashboards lesen",
        }),
      ).toBeVisible();
      expect(
        screen.getByRole("group", {
          name:
            locale === "en"
              ? "Read Jira filter share entries"
              : "Jira-Filter-Freigabeeinträge lesen",
        }),
      ).toBeVisible();
      expect(await axe(container)).toHaveNoViolations();
    });
    it("does not infer missing permission flags or private sharing from an empty list", () => {
      show(
        projectExchange(
          { outcome: "succeeded", filterId: "700", items: [], startAt: 0, total: 0 },
          "jira_filter_permissions",
        ),
      );
      expect(
        screen.getByText(locale === "en" ? "Saved filter ID: 700" : "Gespeicherte Filter-ID: 700"),
      ).toBeVisible();
      expect(
        screen.queryByText(
          /Entry grants|Entry does not grant|Default sharing|Eintrag erlaubt|Standardfreigabe/u,
        ),
      ).toBeNull();
    });
    it("keeps numeric native continuation visible as a partial dashboard result", () => {
      show(
        projectExchange(
          {
            outcome: "succeeded",
            items: [{ id: "17", name: "Next dashboard" }],
            startAt: 1,
            total: 3,
            nextStartAt: 2,
          },
          "jira_dashboards",
        ),
      );
      expect(
        screen.getByText(
          locale === "en"
            ? "Partial Jira result. Some available data is not included."
            : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
        ),
      ).toBeVisible();
    });
  },
);

describe.each(["en", "de"] as const)("saved collaboration facts in %s (#4298)", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores comments and distinct worklogs for the same issue with named facts and accessible links", async () => {
    const exchanges = [
      projectExchange(
        {
          outcome: "succeeded",
          browseUrl: "https://jira.example.test/context/browse/SYN-7",
          items: [
            {
              id: "9007199254740993",
              issueKey: "SYN-7",
              body: "Updated native comment",
              authorDisplayName: "Comment owner",
              visibility: { type: "role", value: "Developers" },
            },
          ],
        },
        "jira_get_comment",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          issueKey: "SYN-7",
          items: [
            { id: "22", issueKey: "SYN-7", comment: "First work entry", timeSpentSeconds: 0 },
            { id: "23", issueKey: "SYN-7", comment: "Second work entry", timeSpentSeconds: 1800 },
          ],
          startAt: 0,
          total: 2,
        },
        "jira_worklogs",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "30",
              name: "Blocks",
              inward: "is blocked by",
              outward: "blocks",
              inwardIssueKey: "SYN-7",
              outwardIssueKey: "SYN-8",
            },
          ],
        },
        "jira_issue_link",
      ),
    ].map((exchange, index) => ({
      ...exchange,
      call: { ...exchange.call, id: `collaboration-${String(index)}` },
    }));
    const transcript = { schemaVersion: 1 as const, exchanges };
    const first = render(
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="completed" />
      </I18nProvider>,
    );
    expect(screen.getByText("Updated native comment")).toBeVisible();
    first.unmount();
    const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={restored} turnState="completed" />
      </I18nProvider>,
    );
    for (const value of [
      "Updated native comment",
      "First work entry",
      "Second work entry",
      "Blocks",
    ])
      expect(screen.getByText(value, { exact: true })).toBeVisible();
    expect(
      screen.getByText(
        locale === "en" ? "Comment ID: 9007199254740993" : "Kommentar-ID: 9007199254740993",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en" ? "Visible to role: Developers" : "Sichtbar für Rolle: Developers",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Time spent (seconds): 0" : "Zeitaufwand (Sekunden): 0"),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en" ? "Time spent (seconds): 1800" : "Zeitaufwand (Sekunden): 1800",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Outward issue: SYN-8" : "Ausgehender Vorgang: SYN-8"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /SYN-7/u })).toHaveAttribute(
      "href",
      "https://jira.example.test/context/browse/SYN-7",
    );
    expect(container.querySelector("pre, details")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("does not invent effort or visibility and preserves a partial native page notice", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          items: [{ id: "24", issueKey: "SYN-7", comment: "Unmeasured entry" }],
          startAt: 1,
          total: 3,
          nextStartAt: 2,
        },
        "jira_worklogs",
      ),
    );
    expect(screen.getByText("Unmeasured entry")).toBeVisible();
    expect(screen.queryByText(/Time spent|Zeitaufwand|Visible to|Sichtbar für/u)).toBeNull();
    expect(
      screen.getByText(
        locale === "en"
          ? "Partial Jira result. Some available data is not included."
          : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
      ),
    ).toBeVisible();
  });
  it("keeps an unknown comment mutation distinct from confirmed success", () => {
    show(
      projectExchange(
        { outcome: "unknown", ...{ issueKey: "SYN-7", commentId: "91" } },
        "jira_update_comment",
      ),
    );
    expect(screen.getByText(locale === "en" ? "Comment ID: 91" : "Kommentar-ID: 91")).toBeVisible();
    expect(
      screen.getByText(
        locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt",
      ),
    ).toBeVisible();
  });
});

describe("server-minted board read links", () => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages("en"), loadOptionalWidgetMessages("en")]);
  });
  it("keeps the saved context and exact board identity", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "17",
              name: "Delivery board",
              type: "scrum",
              browseUrl: "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17",
            },
          ],
        },
        "jira_board",
      ),
    );
    expect(screen.getByRole("link", { name: /Delivery board/u })).toHaveAttribute(
      "href",
      "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17",
    );
  });
  it("does not use an issue URL as a fallback destination for a board", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "17",
              name: "Delivery board",
              issueKey: "SYN-7",
              browseUrl: "https://jira.example.test/context/browse/SYN-7",
            },
          ],
        },
        "jira_board",
      ),
    );
    expect(screen.getByText("Delivery board")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it.each([
    "not a URL",
    "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=18",
    "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17&rapidView=17",
    "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17&other=1",
    "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17#fragment",
    "https://secret@jira.example.test/context/secure/RapidBoard.jspa?rapidView=17",
    "http://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17",
    "https://jira.example.test/context/projects/SYN/summary?rapidView=17",
  ])("refuses a URL that does not preserve the exact trusted board route", (browseUrl) => {
    show(
      projectExchange(
        { outcome: "succeeded", items: [{ id: "17", name: "Delivery board", browseUrl }] },
        "jira_board",
      ),
    );
    expect(screen.getByText("Delivery board")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe.each(["en", "de"] as const)(
  "saved version and component results in %s (#4297)",
  (locale) => {
    beforeEach(async () => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
    });
    it("restores distinct entity IDs, names, states and calendar dates accessibly without URLs or JSON", async () => {
      const exchanges = [
        projectExchange(
          {
            outcome: "succeeded",
            versionId: "9223372036854775807",
            projectId: "10000",
            name: "Delivery release",
            released: true,
            archived: false,
            startDate: "2028-02-29",
            releaseDate: "2028-03-01",
            browseUrl: "https://jira.example.test/browse/SYN-7",
            issueKey: "SYN-7",
          },
          "jira_version",
        ),
        projectExchange(
          {
            outcome: "succeeded",
            items: [
              {
                id: "12001",
                name: "Delivery component",
                project: "SYN",
                leadUserName: "component-owner",
                assigneeType: "COMPONENT_LEAD",
                archived: true,
                self: "https://untrusted.invalid",
              },
            ],
          },
          "jira_components",
        ),
      ].map((entry, index) => ({
        ...entry,
        call: { ...entry.call, id: `metadata-${String(index)}` },
      }));
      const transcript = { schemaVersion: 1 as const, exchanges };
      const first = render(
        <I18nProvider>
          <JiraChatTools transcript={transcript} turnState="completed" />
        </I18nProvider>,
      );
      expect(screen.getByText("Delivery release", { exact: true })).toBeVisible();
      first.unmount();
      const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
      const { container } = render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
      for (const value of ["Delivery release", "Delivery component"])
        expect(screen.getByText(value, { exact: true })).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Version ID: 9223372036854775807" : "Versions-ID: 9223372036854775807",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(locale === "en" ? "Component ID: 12001" : "Komponenten-ID: 12001"),
      ).toBeVisible();
      expect(
        screen.getByText(locale === "en" ? "Project key: SYN" : "Projektschlüssel: SYN"),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Release date: 2028-03-01" : "Veröffentlichungsdatum: 2028-03-01",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(locale === "en" ? "Released version" : "Veröffentlichte Version"),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Assignee: component lead" : "Zuständigkeit: Komponentenleitung",
        ),
      ).toBeVisible();
      expect(screen.queryByText("SYN-7", { exact: true })).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      expect(container.querySelector("pre")).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    });

    it("keeps missing version state and totals unknown", () => {
      show(
        projectExchange(
          {
            outcome: "succeeded",
            items: [{ versionId: "12000", projectId: "10000", name: "State unknown" }],
          },
          "jira_versions",
        ),
      );
      expect(
        screen.getByText(
          locale === "en" ? "Release state unavailable" : "Veröffentlichungsstatus nicht verfügbar",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Archive state unavailable" : "Archivierungsstatus nicht verfügbar",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Returned results: 1." : "Zurückgegebene Ergebnisse: 1.",
        ),
      ).toBeVisible();
      expect(
        screen.queryByText(locale === "en" ? "Unreleased version" : "Unveröffentlichte Version"),
      ).toBeNull();
      expect(screen.queryByText(locale === "en" ? "Not archived" : "Nicht archiviert")).toBeNull();
    });

    it.each([0, 2])("keeps local collection page at offset %s explicitly partial", (startAt) => {
      show(
        projectExchange(
          {
            outcome: "succeeded",
            items: [{ versionId: "12000", projectId: "10000", name: "One page" }],
            startAt,
            total: 3,
            ...(startAt === 0 ? { nextStartAt: 1 } : {}),
          },
          "jira_versions",
        ),
      );
      expect(
        screen.getByText(
          locale === "en" ? "1 of 3 results returned." : "1 von 3 Ergebnissen zurückgegeben.",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en"
            ? "Partial Jira result. Some available data is not included."
            : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
        ),
      ).toBeVisible();
    });

    it.each(["jira_create_version", "jira_create_component"])(
      "keeps unknown %s with only project context distinct from a created entity",
      (operation) => {
        const exchange = projectExchange(
          {
            outcome: "unknown",
            projectId: "10000",
            projectKey: "SYN",
            projectName: "Context only",
            browseUrl: PROJECT_URL,
            reason: "timeout",
          },
          operation,
        );
        const { container } = show({ ...exchange, mutationOutcome: "unknown" });
        expect(
          screen.getByText(
            locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt",
          ),
        ).toBeVisible();
        expect(
          screen.getByText(locale === "en" ? "Project ID: 10000" : "Projekt-ID: 10000"),
        ).toBeVisible();
        expect(screen.queryByText("Context only", { exact: true })).toBeNull();
        expect(container.textContent).not.toMatch(
          /(?:Version ID|Versions-ID|Component ID|Komponenten-ID):/u,
        );
        expect(screen.queryByRole("link")).toBeNull();
        expect(
          screen.queryByText(locale === "en" ? "Jira change confirmed" : "Jira-Änderung bestätigt"),
        ).toBeNull();
      },
    );

    it.each([
      ["jira_create_version", { versionId: "12000" }, "Version ID: 12000", "Versions-ID: 12000"],
      ["jira_update_version", { versionId: "12000" }, "Version ID: 12000", "Versions-ID: 12000"],
      [
        "jira_create_component",
        { componentId: "12001", projectId: "10000", projectKey: "SYN" },
        "Component ID: 12001",
        "Komponenten-ID: 12001",
      ],
      [
        "jira_update_component",
        { componentId: "12001", projectId: "10000", projectKey: "SYN" },
        "Component ID: 12001",
        "Komponenten-ID: 12001",
      ],
    ] as const)(
      "retains %s identity without inventing a confirmed state",
      (operation, receipt, en, de) => {
        show({
          ...projectExchange({ outcome: "succeeded-unconfirmed", ...receipt }, operation),
          mutationOutcome: "succeeded-unconfirmed",
        });
        expect(screen.getByText(locale === "en" ? en : de)).toBeVisible();
        expect(
          screen.queryByText(locale === "en" ? "Released version" : "Veröffentlichte Version"),
        ).toBeNull();
        expect(screen.queryByRole("link")).toBeNull();
      },
    );
  },
);

describe.each(["en", "de"] as const)("saved Agile results in %s (AC6)", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("keeps a saved filter readable without assuming unknown sharing is private", async () => {
    const { container } = show(
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "7",
              name: "Delivery filter",
              jql: "project = SYN ORDER BY Rank",
              shareScope: "unknown",
            },
          ],
          startAt: 0,
          total: 1,
        },
        "jira_favourite_filters",
      ),
    );
    expect(screen.getByText("Delivery filter", { exact: true })).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Saved filter ID: 7" : "Gespeicherte Filter-ID: 7"),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Filter query: project = SYN ORDER BY Rank"
          : "Filterabfrage: project = SYN ORDER BY Rank",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Filter sharing status unavailable"
          : "Freigabestatus des Filters nicht verfügbar",
      ),
    ).toBeVisible();
    expect(screen.queryByText(locale === "en" ? "Private filter" : "Privater Filter")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("restores board and sprint identity, state and goal as readable facts", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const exchanges = [
      projectExchange(
        { outcome: "succeeded", items: [{ id: "7", name: "Delivery board", type: "scrum" }] },
        "jira_boards",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "9",
              name: "Delivery sprint",
              state: "active",
              originBoardId: "7",
              goal: "Deliver the reviewed scope",
            },
          ],
        },
        "jira_sprint",
      ),
    ].map((entry, index) => ({ ...entry, call: { ...entry.call, id: `agile-${String(index)}` } }));
    const restored = JSON.parse(
      JSON.stringify({ schemaVersion: 1, exchanges }),
    ) as ChatToolTranscript;
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={restored} turnState="completed" />
      </I18nProvider>,
    );
    for (const value of ["Delivery board", "Delivery sprint", "Deliver the reviewed scope"])
      expect(screen.getByText(value, { exact: true })).toBeVisible();
    expect(screen.getByText(locale === "en" ? "Sprint ID: 9" : "Sprint-ID: 9")).toBeVisible();
    expect(screen.getAllByText(locale === "en" ? "Board ID: 7" : "Board-ID: 7")).toHaveLength(2);
    expect(screen.getByText(locale === "en" ? "Active sprint" : "Aktiver Sprint")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ["jira_board_create", { boardId: "7" }, "Board ID: 7", "Board-ID: 7"],
    ["jira_sprint_create", { sprintId: "9" }, "Sprint ID: 9", "Sprint-ID: 9"],
    ["jira_sprint_update", { sprintId: "9" }, "Sprint ID: 9", "Sprint-ID: 9"],
    [
      "jira_sprint_move_issues",
      { sprintId: "9", issueKeys: ["SYN-1", "SYN-2"] },
      "Sprint ID: 9",
      "Sprint-ID: 9",
    ],
    ["jira_backlog_move_issues", { issueKeys: ["SYN-1", "SYN-2"] }, "SYN-1", "SYN-1"],
    ["jira_epic_update", { epicKey: "SYN-10" }, "SYN-10", "SYN-10"],
    [
      "jira_epic_move_issues",
      { epicKey: "SYN-10", issueKeys: ["SYN-1", "SYN-2"] },
      "SYN-10",
      "SYN-10",
    ],
  ] as const)(
    "keeps %s acknowledgement identity visible without claiming confirmation",
    (operation, receipt, en, de) => {
      const entry = projectExchange({ outcome: "succeeded-unconfirmed", ...receipt }, operation);
      const { container } = show({ ...entry, mutationOutcome: "succeeded-unconfirmed" });
      expect(
        screen.getByText(
          locale === "en"
            ? "Jira accepted the change; confirmation incomplete"
            : "Jira hat die Änderung angenommen; Bestätigung unvollständig",
        ),
      ).toBeVisible();
      expect(screen.getByText(locale === "en" ? en : de, { exact: true })).toBeVisible();
      if ("issueKeys" in receipt)
        for (const key of receipt.issueKeys)
          expect(screen.getByText(key, { exact: true })).toBeVisible();
      expect(
        screen.queryByText(locale === "en" ? "Jira change confirmed" : "Jira-Änderung bestätigt"),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /retry|erneut/iu })).toBeNull();
      expect(container.querySelector("pre")).toBeNull();
    },
  );
});

it("uses stored Epic and Board destinations but never invents a Sprint URL", () => {
  const entries = [
    projectExchange(
      {
        outcome: "succeeded",
        epicKey: "SYN-10",
        browseUrl: "https://jira.example.test/context/browse/SYN-10",
      },
      "jira_epic_update",
    ),
    projectExchange(
      {
        outcome: "succeeded",
        boardId: "7",
        browseUrl: "https://jira.example.test/secure/RapidBoard.jspa?rapidView=7",
      },
      "jira_board_create",
    ),
    projectExchange(
      {
        outcome: "succeeded",
        sprintId: "9",
        browseUrl: "https://jira.example.test/secure/RapidBoard.jspa?sprint=9",
      },
      "jira_sprint_create",
    ),
  ].map((entry, index) => ({ ...entry, call: { ...entry.call, id: `link-${String(index)}` } }));
  render(
    <JiraChatTools transcript={{ schemaVersion: 1, exchanges: entries }} turnState="completed" />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(screen.getByRole("link", { name: /SYN-10/u })).toHaveAttribute(
    "href",
    "https://jira.example.test/context/browse/SYN-10",
  );
});

describe.each(["en", "de"] as const)("saved project results in %s (#4293)", (locale) => {
  it("keeps a denied project write actionable without a success claim or automatic retry", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const exchange = projectExchange({ outcome: "rejected", reason: "permission-denied" });
    const { container } = show({ ...exchange, mutationOutcome: "rejected" });
    expect(
      screen.getByText(locale === "en" ? "Jira action rejected" : "Jira-Aktion abgelehnt"),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Check the Jira account's permission for the requested project and action."
          : "Prüfe die Berechtigung des Jira-Kontos für das angeforderte Projekt und die Aktion.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(locale === "en" ? "Jira change confirmed" : "Jira-Änderung bestätigt"),
    ).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry|erneut/iu })).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows key validation, permission decisions and the project type without raw objects", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const exchanges = [
      projectExchange(
        { outcome: "succeeded", key: "FREE", valid: true },
        "jira_validate_project_key",
      ),
      projectExchange(
        { outcome: "succeeded", key: "TAKEN", valid: false },
        "jira_validate_project_key",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          permissions: [
            { key: "ADMINISTER_PROJECTS", name: "Administer projects", havePermission: true },
            { key: "ADMINISTER", name: "Jira administration", havePermission: false },
          ],
        },
        "jira_project_permissions",
      ),
      projectExchange(
        { outcome: "succeeded", projectTypeKey: "software", name: "Software" },
        "jira_project_type",
      ),
    ].map((exchange, index) => ({
      ...exchange,
      call: { ...exchange.call, id: `read-${String(index)}` },
    }));
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={{ schemaVersion: 1, exchanges }} turnState="completed" />
      </I18nProvider>,
    );
    for (const name of ["FREE", "TAKEN", "Administer projects", "Jira administration", "Software"])
      expect(screen.getByText(name, { exact: true })).toBeVisible();
    const states =
      locale === "en"
        ? [
            "This project key is available.",
            "This project key cannot be used. Choose another key.",
            "Permission granted",
            "Permission not granted",
            "Returned results: 2.",
          ]
        : [
            "Dieser Projektschlüssel ist verfügbar.",
            "Dieser Projektschlüssel ist nicht verwendbar. Wähle einen anderen Schlüssel.",
            "Berechtigung erteilt",
            "Berechtigung nicht erteilt",
            "Zurückgegebene Ergebnisse: 2.",
          ];
    for (const state of states) expect(screen.getByText(state, { exact: true })).toBeVisible();
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each(["jira_project", "jira_create_project", "jira_update_project"])(
    "keeps %s identity, name and trusted link after serialization without rounding its ID",
    async (operation) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      const exchange = projectExchange({ outcome: "succeeded", ...PROJECT }, operation);
      const first = show(exchange);
      first.unmount();
      const restored = JSON.parse(
        JSON.stringify({ schemaVersion: 1, exchanges: [exchange] }),
      ) as ChatToolTranscript;
      const { container } = render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
      expect(screen.getByText("Delivery workspace")).toBeVisible();
      expect(screen.getByRole("link", { name: /SYN/u })).toHaveAttribute("href", PROJECT_URL);
      expect(
        screen.getByText(`${locale === "en" ? "Project ID" : "Projekt-ID"}: ${PROJECT_ID}`),
      ).toBeVisible();
      expect(container.querySelector("pre")).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it("keeps accepted project identity visible when readback is unconfirmed without offering a retry", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const exchange = projectExchange({ outcome: "succeeded-unconfirmed", ...PROJECT });
    show({ ...exchange, mutationOutcome: "succeeded-unconfirmed" });
    expect(
      screen.getByText(
        locale === "en"
          ? "Jira accepted the change; confirmation incomplete"
          : "Jira hat die Änderung angenommen; Bestätigung unvollständig",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /SYN/u })).toHaveAttribute("href", PROJECT_URL);
    expect(screen.queryByRole("button", { name: /retry|erneut/iu })).toBeNull();
  });
});

it.each([
  "javascript:alert(1)",
  "http://jira.example.test/projects/SYN/summary",
  "https://user:credential@jira.example.test/projects/SYN/summary",
  "https://jira.example.test/projects/OTHER/summary",
  "https://jira.example.test/projects/SYN/summary?token=private",
  "https://jira.example.test/projects/SYN/summary#private",
  "https://jira.example.test/rest/api/2/project/SYN",
  "https://jira.example.test/browse/SYN-1",
])("retains the project key without opening unsafe or non-project URL %s", (browseUrl) => {
  const { container } = show(projectExchange({ outcome: "succeeded", ...PROJECT, browseUrl }));
  expect(screen.getByText("SYN", { exact: true })).toBeVisible();
  expect(screen.queryByRole("link")).toBeNull();
  expect(container.querySelector("pre")).toBeNull();
});

it("never substitutes a project homepage or REST self URL for a missing saved browse link", () => {
  show(
    projectExchange({
      outcome: "succeeded",
      projectId: PROJECT_ID,
      projectKey: "SYN",
      projectName: "Delivery workspace",
      url: "https://homepage.example.test/projects/SYN/summary",
      self: "https://jira.example.test/rest/api/2/project/SYN",
    }),
  );
  expect(screen.getByText("SYN", { exact: true })).toBeVisible();
  expect(screen.queryByRole("link")).toBeNull();
});

it("keeps the saved instance and context when another project has the same key", () => {
  const otherUrl = "https://other-jira.example.test/another-context/projects/SYN/summary";
  show(projectExchange({ outcome: "succeeded", ...PROJECT, browseUrl: otherUrl }));
  expect(screen.getByRole("link", { name: /SYN/u })).toHaveAttribute("href", otherUrl);
});
