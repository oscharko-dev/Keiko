import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import { JiraWriteApproval } from "./JiraWriteApproval";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

// The acceptance criterion of #4178: an approval never shows the request as raw JSON, whatever the
// operation. Every case renders the real component and reads what a person would read.
type Operation = Extract<ChatToolWriteApprovalView, { kind: "jira-chat-write" }>["operation"];

function approvalFor(operation: Operation): ChatToolWriteApprovalView {
  return {
    kind: "jira-chat-write",
    approvalId: `approval-${operation}`,
    chatId: "chat-1",
    podId: "11111111-1111-4111-8111-111111111111",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    invocationId: "action-1",
    operation,
    actionDigest: "a".repeat(64),
    requestedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    state: "pending",
  };
}
const JSON_SHAPE = /[{}[\]]|"[^"\s]+"\s*:/u;

async function reviewed(
  operation: Operation,
  args: Record<string, unknown>,
  locale: "en" | "de" = "en",
): Promise<{
  readonly text: string;
  readonly region: HTMLElement;
  readonly container: HTMLElement;
}> {
  await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
  localStorage.setItem(I18N_STORAGE_KEY, locale);
  const view = approvalFor(operation);
  const { container } = render(
    <I18nProvider>
      <JiraWriteApproval
        approval={view}
        call={{ id: "call", name: operation.replace(/[.-]/gu, "_"), arguments: args }}
        turnState="pending"
        observe={vi.fn().mockResolvedValue(view)}
        decide={vi.fn()}
      />
    </I18nProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: locale === "en" ? "Approve this action" : "Diese Aktion genehmigen",
      }),
    ).toBeEnabled(),
  );
  const region = screen.getByRole("region", {
    name: locale === "en" ? "Review Jira action" : "Jira-Aktion prüfen",
  });
  return { text: region.textContent ?? "", region, container };
}
function expectNoJson(review: { readonly region: HTMLElement }): void {
  expect(review.region.textContent).not.toMatch(JSON_SHAPE);
  expect(review.region.querySelector("textarea, pre, details")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
}

afterEach(() => {
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe.each(["en", "de"] as const)("reviewed Jira deletion snapshots in %s", (locale) => {
  it.each(["role", "group"] as const)(
    "names the exact comment body and %s restriction before deleting it",
    async (type) => {
      const review = await reviewed(
        "jira.delete-comment",
        {
          issueKey: "SYN-7",
          commentId: "9007199254740993",
          expectedBody: "Reviewed comment to remove",
          expectedVisibility: { type, value: "Developers" },
        },
        locale,
      );
      for (const value of ["SYN-7", "9007199254740993", "Reviewed comment to remove", "Developers"])
        expect(review.text).toContain(value);
      expect(review.text).toContain(
        locale === "en" ? "Delete Jira comment" : "Jira-Kommentar löschen",
      );
      expect(review.text).toContain(
        locale === "en" ? "Reviewed comment text" : "Geprüfter Kommentartext",
      );
      const visibilityLabels = locale === "en"
        ? { group: "Visible to group", role: "Visible to role" }
        : { group: "Sichtbar für Gruppe", role: "Sichtbar für Rolle" };
      expect(review.text).toContain(visibilityLabels[type]);
      expectNoJson(review);
      expect(await axe(review.container)).toHaveNoViolations();
    },
  );
  it("states an empty reviewed unrestricted comment explicitly", async () => {
    const review = await reviewed(
      "jira.delete-comment",
      { issueKey: "SYN-7", commentId: "91", expectedBody: "" },
      locale,
    );
    expect(review.text).toContain(
      locale === "en" ? "Reviewed text is empty" : "Der geprüfte Text ist leer",
    );
    expect(review.text).toContain(
      locale === "en" ? "No group or role restriction" : "Keine Gruppen- oder Rollenbeschränkung",
    );
    expectNoJson(review);
  });
  it("names the reviewed attachment filename, exact ID and valid zero-byte size", async () => {
    const review = await reviewed(
      "jira.delete-attachment",
      { issueKey: "SYN-8", attachmentId: "9007199254740993", filename: "empty.txt", size: 0 },
      locale,
    );
    for (const value of ["SYN-8", "9007199254740993", "empty.txt", "0"])
      expect(review.text).toContain(value);
    expect(review.text).toContain(
      locale === "en" ? "Delete Jira attachment" : "Jira-Anhang löschen",
    );
    expect(review.text).toContain(locale === "en" ? "Size in bytes" : "Größe in Bytes");
    expectNoJson(review);
    expect(await axe(review.container)).toHaveNoViolations();
  });
  it.each([null, { type: "role", value: "Developers" }])(
    "names the entire reviewed worklog and keeps the remaining estimate unchanged",
    async (visibility) => {
      const review = await reviewed(
        "jira.delete-worklog",
        {
          issueKey: "SYN-9",
          worklogId: "9007199254740993",
          timeSpentSeconds: 0,
          started: "2026-11-07T12:30:00.000+0000",
          comment: "",
          visibility,
        },
        locale,
      );
      for (const value of ["SYN-9", "9007199254740993", "2026-11-07T12:30:00.000+0000", "0"])
        expect(review.text).toContain(value);
      expect(review.text).toContain(
        locale === "en" ? "Delete Jira worklog" : "Jira-Arbeitsprotokoll löschen",
      );
      expect(review.text).toContain(
        locale === "en" ? "Reviewed text is empty" : "Der geprüfte Text ist leer",
      );
      expect(review.text).toContain(locale === "en" ? "Remaining estimate" : "Restaufwand");
      expect(review.text).toContain(locale === "en" ? "Keep unchanged" : "Unverändert lassen");
      const unrestricted = locale === "en"
        ? "No group or role restriction"
        : "Keine Gruppen- oder Rollenbeschränkung";
      expect(review.text).toContain(visibility === null ? unrestricted : "Developers");
      expect(review.text).not.toContain(
        locale === "en" ? "Clear the existing comment" : "Vorhandenen Kommentar leeren",
      );
      expect(review.text).not.toContain("adjustEstimate");
      expectNoJson(review);
      expect(await axe(review.container)).toHaveNoViolations();
    },
  );
});

describe.each(["en", "de"] as const)(
  "readable worklog and self-account approvals in %s",
  (locale) => {
    it("names an explicit worklog comment clear before approval", async () => {
      const review = await reviewed(
        "jira.update-worklog",
        { issueKey: "SYN-7", worklogId: "92", comment: "" },
        locale,
      );
      expect(review.text).toContain(
        locale === "en" ? "Clear the existing comment" : "Vorhandenen Kommentar leeren",
      );
      expectNoJson(review);
    });
    it.each(["jira.create-worklog", "jira.update-worklog"] as const)(
      "names exact worklog values for %s",
      async (operation) => {
        const review = await reviewed(
          operation,
          {
            issueKey: "SYN-7",
            ...(operation === "jira.update-worklog"
              ? { worklogId: "9007199254740993" }
              : { visibility: { type: "role", value: "Developers" } }),
            timeSpentSeconds: 3661,
            started: "2026-11-07T12:00:00+01:00",
            comment: "Investigated the delivery failure",
          },
          locale,
        );
        for (const value of [
          "SYN-7",
          "3661",
          "2026-11-07T12:00:00+01:00",
          "Investigated the delivery failure",
        ])
          expect(review.text).toContain(value);
        for (const value of locale === "en"
          ? ["Time spent (seconds)", "Work started", "Worklog comment"]
          : ["Zeitaufwand (Sekunden)", "Arbeitsbeginn", "Kommentar zur Arbeitszeit"])
          expect(review.text).toContain(value);
        if (operation === "jira.create-worklog") {
          expect(review.text).toContain(locale === "en" ? "Visible to role" : "Sichtbar für Rolle");
          expect(review.text).toContain("Developers");
        } else expect(review.text).toContain("9007199254740993");
        expectNoJson(review);
        expect(await axe(review.container)).toHaveNoViolations();
      },
    );
    it.each([
      [
        "jira.watch",
        "Watch Jira issue with your account",
        "Jira-Vorgang mit deinem Konto beobachten",
      ],
      [
        "jira.unwatch",
        "Stop watching Jira issue with your account",
        "Jira-Vorgang mit deinem Konto nicht mehr beobachten",
      ],
      [
        "jira.vote",
        "Vote for Jira issue with your account",
        "Mit deinem Konto für einen Jira-Vorgang abstimmen",
      ],
      [
        "jira.unvote",
        "Remove your vote from Jira issue",
        "Deine Stimme für einen Jira-Vorgang entfernen",
      ],
    ] as const)("keeps %s explicitly scoped to the current account", async (operation, en, de) => {
      const review = await reviewed(operation, { issueKey: "SYN-7" }, locale);
      expect(review.text).toContain(locale === "en" ? en : de);
      expect(review.text).toContain("SYN-7");
      expectNoJson(review);
    });
  },
);

describe.each(["en", "de"] as const)("readable comment updates in %s (#4298)", (locale) => {
  it("names the exact existing comment and keeps the native body readable without JSON", async () => {
    const review = await reviewed(
      "jira.update-comment",
      { issueKey: "SYN-7", commentId: "9007199254740993", body: "Updated native comment" },
      locale,
    );
    expect(review.text).toContain(locale === "en" ? "Comment ID" : "Kommentar-ID");
    for (const value of ["SYN-7", "9007199254740993", "Updated native comment"])
      expect(review.text).toContain(value);
    expectNoJson(review);
    expect(await axe(review.container)).toHaveNoViolations();
  });
});

describe.each(["en", "de"] as const)(
  "readable project metadata approvals in %s (#4297)",
  (locale) => {
    it.each([
      [
        "jira.create-version",
        {
          projectId: "10000",
          name: "Delivery release",
          description: "Scoped release",
          startDate: "2028-02-29",
          releaseDate: "2028-03-01",
          released: false,
          archived: false,
        },
        "Version name",
        "Versionsname",
      ],
      [
        "jira.update-version",
        { versionId: "12000", released: true, releaseDate: "2028-03-01" },
        "Version ID",
        "Versions-ID",
      ],
      [
        "jira.create-component",
        {
          projectIdOrKey: "SYN",
          name: "Delivery component",
          description: "Scoped component",
          leadUserName: "component-owner",
          assigneeType: "COMPONENT_LEAD",
        },
        "Component name",
        "Komponentenname",
      ],
      [
        "jira.update-component",
        { componentId: "12001", leadUserName: "component-owner" },
        "Component ID",
        "Komponenten-ID",
      ],
    ] as const)(
      "shows every %s argument under the correct entity labels",
      async (operation, args, en, de) => {
        const review = await reviewed(operation, args, locale);
        expect(review.text).toContain(locale === "en" ? en : de);
        expect(review.text).not.toContain(locale === "en" ? "File name" : "Dateiname");
        for (const value of Object.values(args))
          if (typeof value === "string") expect(review.text).toContain(value);
        expectNoJson(review);
        expect(await axe(review.container)).toHaveNoViolations();
      },
    );
  },
);

describe.each(["en", "de"] as const)("readable project approvals in %s (#4293)", (locale) => {
  it.each(["jira.create-project", "jira.update-project"] as const)(
    "shows every %s argument with project-specific labels and keeps the website as a value",
    async (operation) => {
      const args =
        operation === "jira.create-project"
          ? {
              key: "SYN",
              name: "Delivery workspace",
              lead: "project-lead",
              projectTypeKey: "software",
              projectTemplateKey: "com.pyxis.greenhopper.jira:gh-scrum-template",
              description: "Project purpose",
              url: "https://homepage.example.test",
              assigneeType: "PROJECT_LEAD",
            }
          : {
              projectIdOrKey: "9223372036854775807",
              name: "Renamed workspace",
              lead: "updated-lead",
              description: "Updated purpose",
              url: "https://updated.example.test",
              assigneeType: "UNASSIGNED",
            };
      const { container, region } = await reviewed(operation, args, locale);
      const labels =
        locale === "en"
          ? [
              "Project name",
              "Project lead",
              "Project description",
              "Project website",
              "Default assignee",
            ]
          : [
              "Projektname",
              "Projektleitung",
              "Projektbeschreibung",
              "Projektwebseite",
              "Standardbearbeiter",
            ];
      for (const label of labels) expect(region.textContent).toContain(label);
      if (operation === "jira.create-project")
        expect(region.textContent).toContain(
          locale === "en" ? "Project template" : "Projektvorlage",
        );
      for (const value of Object.values(args)) expect(region.textContent).toContain(value);
      expect(region.textContent).not.toContain(locale === "en" ? "File name" : "Dateiname");
      expect(region.querySelector("a")).toBeNull();
      expectNoJson({ region });
      expect(await axe(container)).toHaveNoViolations();
    },
  );
});

describe.each(["en", "de"] as const)("readable Agile approvals in %s (AC6)", (locale) => {
  it.each([
    [
      "jira.board-create",
      { name: "Delivery board", type: "scrum", filterId: "7" },
      "Board name",
      "Board-Name",
    ],
    [
      "jira.sprint-create",
      {
        name: "Delivery sprint",
        originBoardId: "7",
        startDate: "2026-11-07T09:00:00Z",
        endDate: "2026-11-21T17:00:00Z",
        goal: "Reviewed delivery scope",
      },
      "Sprint goal",
      "Sprint-Ziel",
    ],
    ["jira.sprint-update", { sprintId: "9", state: "closed" }, "Sprint state", "Sprint-Status"],
    [
      "jira.sprint-move-issues",
      { sprintId: "9", issues: ["SYN-1", "SYN-2"] },
      "Issue keys",
      "Vorgangsschlüssel",
    ],
    ["jira.backlog-move-issues", { issues: ["SYN-1", "SYN-2"] }, "Issue keys", "Vorgangsschlüssel"],
    [
      "jira.epic-update",
      {
        epicIdOrKey: "SYN-10",
        name: "Delivery Epic",
        summary: "Reviewed requirement",
        done: true,
        color: "color_4",
      },
      "Epic name",
      "Epic-Name",
    ],
    [
      "jira.epic-move-issues",
      { epicIdOrKey: "SYN-10", issues: ["SYN-1", "SYN-2"] },
      "Epic ID or key",
      "Epic-ID oder Schlüssel",
    ],
  ] as const)(
    "shows the exact %s request with named facts before approval",
    async (operation, args, en, de) => {
      const before = JSON.stringify(args);
      const review = await reviewed(operation, args, locale);
      expect(review.text).toContain(locale === "en" ? en : de);
      for (const value of Object.values(args).flat()) expect(review.text).toContain(String(value));
      expect(review.text).not.toContain(locale === "en" ? "File name" : "Dateiname");
      expect(JSON.stringify(args)).toBe(before);
      expectNoJson(review);
      expect(await axe(review.container)).toHaveNoViolations();
    },
  );
});

describe("Jira write approvals never show the request as JSON (#4178)", () => {
  it.each(["jira.create", "jira.draft"] as const)(
    "shows the canonical Data Center description without mutating %s arguments",
    async (operation) => {
      const description =
        "## Requirement\nExact\n## Criteria\n* one\n* two\n* three\n* four\n* five\n## Source\nExact source";
      const fields = Object.freeze({
        summary: "Synthetic",
        description: Object.freeze({ format: "markdown", text: description }),
      });
      const issue = Object.freeze({ ref: "one", projectId: "10000", issueTypeId: "10002", fields });
      const args =
        operation === "jira.draft"
          ? { items: [issue] }
          : { projectId: "10000", issueTypeId: "10002", fields };
      const before = JSON.stringify(args);
      const review = await reviewed(operation, args);
      expect(review.text).toContain(
        "h2. Requirement\n\nExact\n\nh2. Criteria\n\n* one\n* two\n* three\n* four\n* five\n\nh2. Source\n\nExact source",
      );
      expect(JSON.stringify(args)).toBe(before);
      expect(fields.description).toEqual({ format: "markdown", text: description });
    },
  );

  it("shows a created issue's type, project, summary and field values by name", async () => {
    const review = await reviewed("jira.create", {
      projectId: "10000",
      issueTypeId: "10002",
      fields: {
        summary: "Synthetic story",
        labels: ["alpha", "beta"],
        priority: { name: "High" },
        components: [{ id: "10", name: "Core" }],
        storyPoints: 5,
        dueDate: null,
      },
      links: [{ type: "Relates", direction: "outward", issueKey: "SYN-9" }],
      requirementIds: ["REQ-1"],
    });
    expect(review.text).toContain("Project");
    expect(review.text).toContain("10000");
    expect(review.text).toContain("Issue type");
    expect(review.text).toContain("10002");
    expect(review.text).toContain("Synthetic story");
    expect(review.text).toContain("alpha");
    expect(review.text).toContain("High");
    expect(review.text).toContain("Core");
    expect(review.text).toContain("storyPoints");
    expect(review.text).toContain("Cleared");
    expect(review.text).toContain("Relates → SYN-9");
    expect(review.text).toContain("REQ-1");
    expectNoJson(review);
    expect(await axe(review.container)).toHaveNoViolations();
  });

  it("shows an edit's fields, label changes and links", async () => {
    const review = await reviewed("jira.edit", {
      issueKey: "SYN-1",
      fields: { summary: "Renamed" },
      updates: [
        { fieldId: "labels", operation: "add", value: "triage" },
        { fieldId: "labels", operation: "remove", value: "old" },
      ],
      links: [{ type: "Blocks", direction: "inward", issueKey: "SYN-2" }],
    });
    for (const shown of [
      "SYN-1",
      "Renamed",
      "Add to labels: triage",
      "Remove from labels: old",
      "SYN-2 → Blocks this issue",
    ])
      expect(review.text).toContain(shown);
    expectNoJson(review);
    expect(await axe(review.container)).toHaveNoViolations();
  });

  it("shows a comment's text, long text collapsed and expandable in place", async () => {
    const long = `${"A long comment sentence. ".repeat(20)}Final words`;
    const review = await reviewed("jira.comment", { issueKey: "SYN-1", body: long });
    expect(review.text).toContain("Comment");
    expect(review.text).toContain("A long comment sentence.");
    expect(review.text).not.toContain("Final words");
    expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expectNoJson(review);
    expect(await axe(review.container)).toHaveNoViolations();
  });

  it("shows a transition's target and the fields it sets", async () => {
    const review = await reviewed("jira.transition", {
      issueKey: "SYN-1",
      transitionId: "31",
      fields: { resolution: { name: "Done" } },
      updates: [{ fieldId: "labels", operation: "add", value: "shipped" }],
    });
    for (const shown of ["Transition", "31", "resolution", "Done", "Add to labels: shipped"])
      expect(review.text).toContain(shown);
    expectNoJson(review);
    expect(await axe(review.container)).toHaveNoViolations();
  });

  it("shows an assignment and an unassignment", async () => {
    const assigned = await reviewed("jira.assign", { issueKey: "SYN-1", assigneeName: "jdoe" });
    expect(assigned.text).toContain("Assignee");
    expect(assigned.text).toContain("jdoe");
    expectNoJson(assigned);
  });

  it("shows that an assignee is cleared", async () => {
    const cleared = await reviewed("jira.assign", { issueKey: "SYN-1", clearAssignee: true });
    expect(cleared.text).toContain("Cleared (unassigned)");
    expectNoJson(cleared);
  });

  it("shows an attachment's source file without a JSON object", async () => {
    const review = await reviewed("jira.attach", {
      issueKey: "SYN-1",
      source: { kind: "connected-file", path: "docs/report.txt" },
      name: "report.txt",
    });
    expect(review.text).toContain("docs/report.txt");
    expect(review.text).toContain("File name");
    expectNoJson(review);
  });

  it("shows every leaf of a deeply nested value as a dotted path, never hiding one", async () => {
    let deep: unknown = { leaf: 1, other: 2 };
    for (let level = 0; level < 9; level += 1) deep = { inner: deep, sibling: `s${level}` };
    const review = await reviewed("jira.create", {
      projectId: "10000",
      issueTypeId: "10002",
      fields: { summary: "Synthetic", customfield_10500: deep },
    });
    expect(review.text).toContain("customfield_10500");
    expect(review.text).not.toContain("not shown");
    expect(review.text).toContain("inner.inner.leaf");
    for (let level = 0; level < 9; level += 1) expect(review.text).toContain(`s${level}`);
    expect(review.text).toContain("1");
    expect(review.text).toContain("2");
    expectNoJson(review);
  });

  it("shows a draft that is not a readable tree field by field, under a note", async () => {
    const review = await reviewed("jira.draft", {
      items: [
        { ref: "a", projectId: "10000", issueTypeId: "10001", fields: { summary: "Item A" } },
        { ref: "a", projectId: "10000", issueTypeId: "10001", fields: { summary: "Item A again" } },
      ],
    });
    expect(review.text).toContain("cannot be laid out");
    expect(review.text).toContain("Item A again");
    expect(review.text).toContain("projectId");
    expectNoJson(review);
    expect(await axe(review.container)).toHaveNoViolations();
  });

  it("shows a large backlog draft as its tree alone, with no second, raw copy", async () => {
    const items = Array.from({ length: 32 }, (_, index) => ({
      ref: `item${index}`,
      projectId: "10000",
      issueTypeId: "10002",
      fields: { summary: `Synthetic item ${index}`, description: "Same text" },
      requirementIds: ["REQ-7"],
    }));
    const review = await reviewed("jira.draft", { items });
    expect(
      screen.getByRole("group", { name: "Issues to create (32 of 32 selected)" }),
    ).toBeVisible();
    expect(screen.getAllByRole("checkbox")).toHaveLength(32);
    expect(review.text).toContain("Requirements: REQ-7");
    expect(screen.queryByRole("group", { name: "Proposed action details" })).toBeNull();
    expectNoJson(review);
  });

  it("shows an MCP write's arguments under the names the tool gave them", async () => {
    const view: ChatToolWriteApprovalView = {
      kind: "mcp-chat-write",
      approvalId: "mcp-approval",
      chatId: "chat-1",
      configurationDigest: "a".repeat(64),
      invocationId: "mcp-call",
      operation: "mcp_fixture_create_note",
      actionDigest: "b".repeat(64),
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      state: "pending",
    };
    render(
      <JiraWriteApproval
        approval={view}
        call={{
          id: "mcp-call",
          name: "mcp_fixture_create_note",
          arguments: { body: "Synthetic note", options: { pinned: true, tags: ["x"] } },
        }}
        turnState="pending"
        observe={vi.fn().mockResolvedValue(view)}
        decide={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve this action" })).toBeEnabled(),
    );
    const region = screen.getByRole("region", { name: "Approve MCP action" });
    for (const shown of ["body", "Synthetic note", "options", "pinned", "true", "tags", "x"])
      expect(region.textContent).toContain(shown);
    expect(region.textContent).not.toContain("Comment");
    expectNoJson({ region });
  });

  it("is readable in German without a JSON dump", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const view = approvalFor("jira.transition");
    const { container } = render(
      <I18nProvider>
        <JiraWriteApproval
          approval={view}
          call={{
            id: "call",
            name: "jira_transition",
            arguments: {
              issueKey: "SYN-1",
              transitionId: "31",
              updates: [{ fieldId: "labels", operation: "add", value: "fertig" }],
            },
          }}
          turnState="pending"
          observe={vi.fn().mockResolvedValue(view)}
          decide={vi.fn()}
        />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Diese Aktion genehmigen" })).toBeEnabled(),
    );
    const region = screen.getByRole("region", { name: "Jira-Aktion prüfen" });
    for (const shown of ["Vorgang", "Statusübergang", "Zu labels hinzufügen: fertig"])
      expect(region.textContent).toContain(shown);
    expectNoJson({ region });
    expect(await axe(container)).toHaveNoViolations();
  });
});
