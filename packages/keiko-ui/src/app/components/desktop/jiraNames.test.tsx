import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import type { OptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import {
  JiraNamesContext,
  NO_JIRA_NAMES,
  jiraNameOf,
  jiraNamesOf,
  restatesTarget,
  withApprovalProjects,
} from "./jiraNames";

vi.mock("@/lib/atlassian-connectors-api", () => ({
  decideJiraChatWriteApproval: vi.fn(),
  getJiraChatWriteApproval: vi.fn(() => new Promise(() => undefined)),
  getJiraStagedDraft: vi.fn(),
}));

function read(name: string, items: readonly unknown[], status = "completed"): ChatToolExchange {
  return {
    call: { id: name, name, arguments: {} },
    result: { status, page: { truncated: false, reason: "none", cursor: null }, data: { items } },
  } as unknown as ChatToolExchange;
}
const approval: Extract<ChatToolWriteApprovalView, { kind: "jira-chat-write" }> = {
  kind: "jira-chat-write",
  approvalId: "approval-1",
  chatId: "chat-1",
  podId: "pod-1",
  bindingGeneration: 1,
  authenticationGeneration: 1,
  invocationId: "invocation-1",
  operation: "jira.draft",
  actionDigest: "a".repeat(64),
  requestedAt: 1,
  expiresAt: Date.now() + 60_000,
  state: "pending",
};
function draft(issuetype: string): ChatToolExchange {
  return {
    call: {
      id: "draft",
      name: "jira_draft",
      arguments: {
        items: [
          {
            ref: "task",
            projectId: "10000",
            issueTypeId: "10002",
            fields: {
              summary: "UI test",
              description: "Synthetic",
              issuetype: { id: issuetype },
              customfield_1: "Synthetic value",
            },
          },
        ],
      },
    },
    approval,
  };
}
function transcript(...exchanges: readonly ChatToolExchange[]): ChatToolTranscript {
  return {
    schemaVersion: 1,
    exchanges,
    readGrant: {
      kind: "jira-chat-read",
      grantId: "grant-1",
      chatId: approval.chatId,
      podId: approval.podId,
      bindingGeneration: approval.bindingGeneration,
      authenticationGeneration: approval.authenticationGeneration,
      state: "granted",
      disclosureVersion: "jira-chat-read-v1",
      requestedAt: 1,
      expiresAt: 2,
    },
  };
}
function renderInChat(...turns: readonly ChatToolTranscript[]): void {
  render(
    <JiraNamesContext.Provider value={jiraNamesOf(turns)}>
      <JiraChatTools transcript={turns.at(-1)} turnState="pending" />
    </JiraNamesContext.Provider>,
  );
}
const READS = [
  read("jira_projects", [{ id: "10000", key: "KEIKO", name: "Keiko synthetic" }]),
  read("jira_issue_types", [{ id: "10002", name: "Task" }]),
  read("jira_create_fields", [{ id: "description", name: "Description" }]),
];

describe("the names on a Jira approval", () => {
  it("names the target and fields as this turn's Jira reads called them", () => {
    renderInChat(transcript(...READS, draft("10002")));
    expect(screen.getByText("Project Keiko synthetic · Issue type Task")).toBeVisible();
    const review = within(screen.getByRole("region", { name: "Review Jira action" }));
    expect(review.getByText("Description")).toBeVisible();
    // A field the reads did not name keeps its id, and the restated target is said once.
    expect(screen.getByText("customfield_1")).toBeVisible();
    expect(screen.queryByText("issuetype")).toBeNull();
    expect(screen.getByText("Create Jira issues")).toBeVisible();
  });
  it("names them from an earlier turn of the Chat, and the later read wins", () => {
    const renamed = read("jira_projects", [{ id: "10000", name: "Renamed" }]);
    renderInChat(transcript(...READS), transcript(renamed), transcript(draft("10002")));
    expect(screen.getByText("Project Renamed · Issue type Task")).toBeVisible();
  });
  it("keeps target and custom ids while localizing built-in fields when the Chat did not read names", () => {
    renderInChat(transcript(draft("10002")));
    expect(screen.getByText("Project 10000 · Issue type 10002")).toBeVisible();
    expect(screen.queryByText("description")).toBeNull();
    expect(screen.getByText("Description")).toBeVisible();
    expect(screen.getByText("Synthetic")).toBeVisible();
    expect(screen.getByText("customfield_1")).toBeVisible();
  });
  it("names the project on the first card of a Chat from the approval itself (F09)", () => {
    const named = {
      ...draft("10002"),
      approval: {
        ...approval,
        projects: [{ ref: "10000", key: "KEIKO", name: "Keiko synthetic" }],
      },
    };
    renderInChat(transcript(named));
    expect(screen.getByText("Project Keiko synthetic (KEIKO) · Issue type 10002")).toBeVisible();
    expect(screen.queryByText(/Project 10000/u)).toBeNull();
  });
  it("lets the approval's key and name win over what an earlier read of the Chat called the project", () => {
    const named = {
      ...draft("10002"),
      approval: {
        ...approval,
        projects: [{ ref: "10000", key: "KEIKO", name: "Keiko synthetic" }],
      },
    };
    renderInChat(
      transcript(read("jira_projects", [{ id: "10000", name: "Stale name" }])),
      transcript(named),
    );
    expect(screen.getByText("Project Keiko synthetic (KEIKO) · Issue type 10002")).toBeVisible();
  });
  it("marks a numeric id Jira did not answer as an id and shows a key as sent, never a bare number", () => {
    const unnamed = { ...draft("10002"), approval: { ...approval, projects: [{ ref: "10000" }] } };
    renderInChat(transcript(unnamed));
    expect(screen.getByText("Project ID 10000 · Issue type 10002")).toBeVisible();
    const keyed = withApprovalProjects(
      NO_JIRA_NAMES,
      "binding",
      { ...approval, projects: [{ ref: "KEIKO" }, { ref: "10001", key: "TWO" }] },
      ((key: string) => key) as unknown as OptionalWidgetTranslate,
    );
    expect(jiraNameOf(keyed, "projects", "KEIKO")).toBe("KEIKO");
    // A project whose name could not be shown is its key.
    expect(jiraNameOf(keyed, "projects", "10001")).toBe("TWO");
  });
  it("words the marked id from the message catalog, in English and German", () => {
    const named = { ...draft("10002"), approval: { ...approval, projects: [{ ref: "10000" }] } };
    for (const [locale, id] of [
      ["en", "ID"],
      ["de", "ID"],
    ] as const) {
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      const { unmount } = render(
        <I18nProvider>
          <JiraNamesContext.Provider value={jiraNamesOf([transcript(named)])}>
            <JiraChatTools transcript={transcript(named)} turnState="pending" />
          </JiraNamesContext.Provider>
        </I18nProvider>,
      );
      expect(screen.getByText(new RegExp(`${id} 10000`, "u"))).toBeVisible();
      unmount();
    }
    localStorage.removeItem(I18N_STORAGE_KEY);
  });
  it("keeps a field visible that contradicts the item's target", () => {
    renderInChat(transcript(draft("10009")));
    expect(screen.queryByText("issuetype")).toBeNull();
    expect(screen.getByText("Issue type")).toBeVisible();
    expect(screen.getByText("10009")).toBeVisible();
  });
  it("takes names only from completed reads of the tool that owns them", () => {
    const names = jiraNamesOf([
      transcript(
        read("jira_projects", [{ id: "1", name: "Refused" }], "denied"),
        read("mcp_other", [{ id: "2", name: "Foreign" }]),
        read("jira_issue_types", [{ id: 3, name: "Not an id" }, null]),
      ),
      undefined,
    ]);
    expect([...names.projects, ...names.issueTypes, ...names.fields]).toEqual([]);
  });
  it("only leaves out a project or issue type field that says exactly the target", () => {
    const text = (value: string): { readonly kind: "text"; readonly text: string } => ({
      kind: "text",
      text: value,
    });
    expect(restatesTarget({ id: "project", value: text("1") }, "1", "2")).toBe(true);
    expect(restatesTarget({ id: "project", value: text("9") }, "1", "2")).toBe(false);
    expect(restatesTarget({ id: "issuetype", value: { kind: "empty" } }, "1", "2")).toBe(false);
    expect(restatesTarget({ id: "summary", value: text("1") }, "1", "2")).toBe(false);
  });
});
