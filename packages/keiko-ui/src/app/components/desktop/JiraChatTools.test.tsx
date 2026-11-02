import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts";
import type { ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JiraChatTools } from "./JiraChatTools";

const connectors = vi.hoisted(() => ({ observe: vi.fn(), decide: vi.fn() }));
vi.mock("@/lib/atlassian-connectors-api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/atlassian-connectors-api")>(
    "@/lib/atlassian-connectors-api",
  )),
  getJiraChatWriteApproval: connectors.observe,
  decideJiraChatWriteApproval: connectors.decide,
}));

const jiraGrant: ChatToolReadGrantView = {
  kind: "jira-chat-read",
  grantId: "grant-1",
  chatId: "chat-1",
  podId: "pod-1",
  bindingGeneration: 1,
  authenticationGeneration: 1,
  state: "pending",
  disclosureVersion: "jira-chat-read-v1",
  requestedAt: Date.now(),
  expiresAt: Date.now() + 60000,
};
const mcpGrant: ChatToolReadGrantView = {
  kind: "mcp-chat-read",
  grantId: "mcp-grant",
  chatId: "chat-1",
  configurationDigest: "a".repeat(64),
  state: "pending",
  disclosureVersion: "mcp-chat-read-v1",
  requestedAt: Date.now(),
  expiresAt: Date.now() + 60000,
};
const writeApproval: ChatToolWriteApprovalView = {
  kind: "jira-chat-write",
  approvalId: "approval-1",
  chatId: "chat-1",
  podId: "11111111-1111-4111-8111-111111111111",
  bindingGeneration: 1,
  authenticationGeneration: 1,
  invocationId: "action-1",
  operation: "jira.edit",
  actionDigest: "a".repeat(64),
  requestedAt: Date.now(),
  expiresAt: Date.now() + 60000,
  state: "pending",
};

function transcript(grants: readonly ChatToolReadGrantView[]): ChatToolTranscript {
  const [latest] = grants;
  return {
    schemaVersion: 1,
    exchanges: [
      { call: { id: "call-read", name: "mcp_lab_search", arguments: { query: "LAB" } } },
      {
        call: {
          id: "call-write",
          name: "jira_edit",
          arguments: { issueKey: "LAB-1", fields: { summary: "Reviewed change" } },
        },
        approval: writeApproval,
      },
    ],
    ...(latest === undefined ? {} : { readGrant: latest, readGrants: grants }),
  };
}

function expectNoReadConsent(): void {
  expect(screen.queryByRole("button", { name: "Allow reading" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Do not allow" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Read Jira in this chat" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Read MCP data in this chat" })).toBeNull();
  expect(screen.queryByText("Waiting for your permission")).toBeNull();
  expect(screen.queryByText("Reading allowed")).toBeNull();
}

describe("Jira Chat tools without a read consent card", () => {
  it("renders tool exchanges and the write approval but no card for Jira and MCP read grants", async () => {
    connectors.observe.mockResolvedValue(writeApproval);
    const { container } = render(
      <JiraChatTools
        transcript={transcript([jiraGrant, mcpGrant])}
        turnState="pending"
        chatId="chat-1"
      />,
    );
    expectNoReadConsent();
    expect(screen.getByText("mcp_lab_search")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeVisible();
    expect(screen.getAllByText("Running")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "MCP action" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Jira action" })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve this action" })).toBeEnabled(),
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("renders the same exchanges when the transcript carries no read grant", () => {
    connectors.observe.mockResolvedValue(writeApproval);
    render(<JiraChatTools transcript={transcript([])} turnState="pending" />);
    expectNoReadConsent();
    expect(screen.getByText("mcp_lab_search")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeVisible();
  });

  it("renders nothing without a transcript and nothing for an empty one", () => {
    const { container, rerender } = render(<JiraChatTools transcript={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <JiraChatTools transcript={{ schemaVersion: 1, exchanges: [], readGrants: [mcpGrant] }} />,
    );
    expectNoReadConsent();
    expect(screen.queryByRole("region")).toBeNull();
  });
});
