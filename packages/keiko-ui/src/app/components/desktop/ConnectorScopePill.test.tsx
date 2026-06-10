// Epic #189 Slice 3 M4 — unit tests for the connector-scope pills (mixed N).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectorScopePill } from "./ConnectorScopePill";
import type { Chat, ChatLocalKnowledgeScope, ChatResponse } from "@/lib/types";

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/proj",
    title: "t",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeCapsule(id: string, ms = 1): ChatLocalKnowledgeScope {
  return {
    kind: "capsule",
    capsuleId: id as Extract<ChatLocalKnowledgeScope, { kind: "capsule" }>["capsuleId"],
    connectedAtMs: ms,
  };
}

function makeSet(id: string, ms = 1): ChatLocalKnowledgeScope {
  return {
    kind: "capsule-set",
    capsuleSetId: id as Extract<ChatLocalKnowledgeScope, { kind: "capsule-set" }>["capsuleSetId"],
    connectedAtMs: ms,
  };
}

describe("ConnectorScopePill", () => {
  it("renders nothing when the chat has no local-knowledge scope", () => {
    const { container } = render(<ConnectorScopePill chat={makeChat()} updateScopes={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one pill for a single capsule scope (legacy singular field)", () => {
    const chat = makeChat({ localKnowledgeScope: makeCapsule("cap-abc") });
    render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Connector: cap-abc");
  });

  it("renders resolved label from the labels map when provided", () => {
    const chat = makeChat({ localKnowledgeScope: makeCapsule("cap-abc") });
    const labels = new Map([["capsule:cap-abc", "My Docs"]]);
    render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} labels={labels} />);
    expect(screen.getByRole("status")).toHaveTextContent("My Docs");
  });

  it("renders one pill per scope for a plural list (M4 mixed N)", () => {
    const scopes: ChatLocalKnowledgeScope[] = [makeCapsule("c1"), makeSet("s1")];
    const chat = makeChat({ localKnowledgeScopes: scopes });
    render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getAllByRole("status")).toHaveLength(2);
  });

  it("uses stable keys — each pill has a distinct aria-label (no index collision)", () => {
    const scopes: ChatLocalKnowledgeScope[] = [makeCapsule("c1"), makeCapsule("c2")];
    const chat = makeChat({ localKnowledgeScopes: scopes });
    render(<ConnectorScopePill chat={chat} updateScopes={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAttribute("aria-label", "Disconnect Connector: c1 from chat");
    expect(buttons[1]).toHaveAttribute("aria-label", "Disconnect Connector: c2 from chat");
  });

  it("PATCHes with the remaining scopes when a single connector is removed (#189)", async () => {
    const scopes: ChatLocalKnowledgeScope[] = [makeCapsule("c1"), makeSet("s1")];
    const chat = makeChat({ localKnowledgeScopes: scopes });
    const updated: Chat = { ...chat, localKnowledgeScopes: [scopes[1]!] };
    const updateScopes = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectorScopePill chat={chat} updateScopes={updateScopes} onDisconnect={onDisconnect} />,
    );
    await user.click(screen.getByRole("button", { name: "Disconnect Connector: c1 from chat" }));
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", [scopes[1]]);
    });
    expect(onDisconnect).toHaveBeenCalledWith(updated);
  });

  it("PATCHes null when the last connector scope is removed", async () => {
    const chat = makeChat({ localKnowledgeScope: makeCapsule("only") });
    const cleared: Chat = { ...chat, localKnowledgeScope: undefined };
    const updateScopes = vi.fn().mockResolvedValue({ chat: cleared } satisfies ChatResponse);
    const user = userEvent.setup();
    render(<ConnectorScopePill chat={chat} updateScopes={updateScopes} />);
    await user.click(screen.getByRole("button", { name: "Disconnect Connector: only from chat" }));
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", null);
    });
  });

  it("surfaces wire errors via role=alert", async () => {
    const chat = makeChat({ localKnowledgeScope: makeCapsule("c1") });
    const updateScopes = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<ConnectorScopePill chat={chat} updateScopes={updateScopes} />);
    await user.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("offline");
    });
  });
});
