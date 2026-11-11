import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JiraChatTools } from "./JiraChatTools";
import { JiraNamesContext, jiraNamesOf, restatesTarget } from "./jiraNames";

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
