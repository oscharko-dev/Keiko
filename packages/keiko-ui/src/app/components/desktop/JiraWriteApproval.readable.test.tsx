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
): Promise<{
  readonly text: string;
  readonly region: HTMLElement;
  readonly container: HTMLElement;
}> {
  const view = approvalFor(operation);
  const { container } = render(
    <JiraWriteApproval
      approval={view}
      call={{ id: "call", name: operation.replace(".", "_"), arguments: args }}
      turnState="pending"
      observe={vi.fn().mockResolvedValue(view)}
      decide={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeEnabled(),
  );
  const region = screen.getByRole("region", { name: "Review Jira action" });
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

describe.each(["en", "de"] as const)("readable project approvals in %s (#4293)", (locale) => {
  it.each(["jira.create-project", "jira.update-project"] as const)(
    "shows every %s argument with project-specific labels and keeps the website as a value",
    async (operation) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      const view = approvalFor(operation);
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
      const { container } = render(
        <I18nProvider>
          <JiraWriteApproval
            approval={view}
            call={{ id: "project-write", name: operation.replace(/[.-]/gu, "_"), arguments: args }}
            turnState="pending"
            observe={vi.fn().mockResolvedValue(view)}
            decide={vi.fn()}
          />
        </I18nProvider>,
      );
      const allow = locale === "en" ? "Approve this action" : "Diese Aktion genehmigen";
      await waitFor(() => expect(screen.getByRole("button", { name: allow })).toBeEnabled());
      const region = screen.getByRole("region", {
        name: locale === "en" ? "Review Jira action" : "Jira-Aktion prüfen",
      });
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
