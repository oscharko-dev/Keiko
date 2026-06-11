// Issue #184 / Epic #532 — unit tests for the chat-header connected-scope pills (1+N).

import { useState, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildLastGroundedBudgetStatus, ConnectedScopePill } from "./ConnectedScopePill";
import type {
  Chat,
  ChatConnectedScope,
  ChatResponse,
  GroundedAnswerContextPackSummary,
} from "@/lib/types";

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

function contextPack(
  overrides: Partial<GroundedAnswerContextPackSummary> = {},
): GroundedAnswerContextPackSummary {
  return {
    schemaVersion: "1",
    scopeId: "scope-1234",
    scopeKind: "files",
    fileCount: 1,
    queryKind: "natural-language",
    usage: {
      searchCalls: 2,
      filesRead: 5,
      excerptBytes: 4000,
      modelInputTokens: 1100,
      modelOutputTokens: 300,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    budget: {
      searchCallsMax: 10,
      filesReadMax: 6,
      excerptBytesMax: 10000,
      modelInputTokensMax: 5000,
      modelOutputTokensMax: 1000,
      elapsedMsMax: 10000,
      rerankCallsMax: Number.POSITIVE_INFINITY,
    },
    citationCount: 1,
    omittedCount: 0,
    omittedCounts: {
      "outside-scope": 0,
      binary: 0,
      generated: 0,
      ignored: 0,
      "size-exceeded": 0,
      "near-duplicate": 0,
      "low-relevance": 0,
      "redacted-only": 0,
      "budget-exhausted": 0,
      "tool-unavailable": 0,
    },
    uncertaintyCount: 0,
    elapsedMs: 1000,
    ...overrides,
  };
}

describe("ConnectedScopePill", () => {
  it("renders nothing when the chat has no connected scope", () => {
    const { container } = render(<ConnectedScopePill chat={makeChat()} updateScopes={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders repository scope and trust/budget disclosure", () => {
    const chat = makeChat({
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Repository scope");
    expect(screen.getByText(/Keiko may inspect only the connected repository/i)).toHaveTextContent(
      /safe-read exclusions and context budget limits apply/i,
    );
  });

  it("renders the single-file basename when the scope has one file path", () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/lib/api.ts"], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("File: api.ts");
  });

  it("renders a folder label when the scope is a directory", () => {
    const chat = makeChat({
      connectedScope: { kind: "directory", relativePaths: ["src/lib"], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Folder: lib");
  });

  it("renders canonical list-only folder and file boundary copy", () => {
    const chat = makeChat({
      connectedScopes: [
        { kind: "directory", relativePaths: ["src/lib"], connectedAtMs: 1 },
        { kind: "files", relativePaths: ["README.md"], connectedAtMs: 2 },
      ],
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toHaveTextContent("Folder: lib");
    expect(statuses[1]).toHaveTextContent("File: README.md");
    expect(screen.getByText(/Keiko may inspect only the connected folder/i)).toHaveTextContent(
      /safe-read exclusions and context budget limits apply/i,
    );
    expect(screen.getByText(/Keiko may inspect only the connected file scope/i)).toHaveTextContent(
      /safe-read exclusions and context budget limits apply/i,
    );
  });

  it("labels an external connected folder by its root basename (#532)", () => {
    const chat = makeChat({
      connectedScope: {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: 1,
        root: "/Users/me/marketing",
      },
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Folder: marketing");
  });

  it("renders one pill per connected source for a 1+N binding (#532)", () => {
    const scopes: ChatConnectedScope[] = [
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 1, root: "/data/alpha" },
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 2, root: "/data/beta" },
    ];
    const chat = makeChat({ connectedScopes: scopes, connectedScope: scopes[0] });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toHaveTextContent("Folder: alpha");
    expect(statuses[1]).toHaveTextContent("Folder: beta");
  });

  it("removes only the clicked source from a multi-source binding (#532)", async () => {
    const scopes: ChatConnectedScope[] = [
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 1, root: "/data/alpha" },
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 2, root: "/data/beta" },
    ];
    const chat = makeChat({ connectedScopes: scopes, connectedScope: scopes[0] });
    const updated: Chat = { ...chat, connectedScopes: [scopes[1]!], connectedScope: scopes[1] };
    const updateScopes = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectedScopePill chat={chat} updateScopes={updateScopes} onDisconnect={onDisconnect} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Disconnect Folder: alpha (/data/alpha) from chat" }),
    );
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", [scopes[1]]);
    });
    expect(onDisconnect).toHaveBeenCalledWith(updated);
  });

  // uiux-fix F010 (C174): same-basename folders produced indistinguishable pills; the
  // full path must stay reachable via title on the label and the disconnect button.
  it("exposes the full connected root via title on label and disconnect button", () => {
    const chat = makeChat({
      connectedScope: {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: 1,
        root: "/Users/me/kunde-a/docs",
      },
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(
      screen.getByRole("status", { name: "Folder: docs (/Users/me/kunde-a/docs)" }),
    ).toHaveAttribute("title", "/Users/me/kunde-a/docs");
    expect(
      screen.getByRole("button", {
        name: "Disconnect Folder: docs (/Users/me/kunde-a/docs) from chat",
      }),
    ).toHaveAttribute("title", "Disconnect Folder: docs from chat (/Users/me/kunde-a/docs)");
  });

  it("disambiguates same-basename scopes in accessible names while preserving titles", () => {
    const scopes: ChatConnectedScope[] = [
      {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: 1,
        root: "/team-a/docs",
      },
      {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: 2,
        root: "/team-b/docs",
      },
    ];
    const chat = makeChat({ connectedScopes: scopes, connectedScope: scopes[0] });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);

    expect(screen.getByRole("status", { name: "Folder: docs (/team-a/docs)" })).toHaveAttribute(
      "title",
      "/team-a/docs",
    );
    expect(screen.getByRole("status", { name: "Folder: docs (/team-b/docs)" })).toHaveAttribute(
      "title",
      "/team-b/docs",
    );
    expect(
      screen.getByRole("button", {
        name: "Disconnect Folder: docs (/team-a/docs) from chat",
      }),
    ).toHaveAttribute("title", "Disconnect Folder: docs from chat (/team-a/docs)");
    expect(
      screen.getByRole("button", {
        name: "Disconnect Folder: docs (/team-b/docs) from chat",
      }),
    ).toHaveAttribute("title", "Disconnect Folder: docs from chat (/team-b/docs)");
  });

  // uiux-fix F010 (C169, WCAG 2.4.3): the focused × unmounts with its pill on success —
  // focus must land on the next remaining disconnect button instead of dropping to <body>.
  it("moves keyboard focus to the next remaining pill after a disconnect", async () => {
    const scopes: ChatConnectedScope[] = [
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 1, root: "/data/alpha" },
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 2, root: "/data/beta" },
    ];
    const initial = makeChat({ connectedScopes: scopes, connectedScope: scopes[0] });
    const updated: Chat = { ...initial, connectedScopes: [scopes[1]!], connectedScope: scopes[1] };
    const updateScopes = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);

    function Harness(): ReactNode {
      const [chat, setChat] = useState(initial);
      return (
        <div className="chat-scope-header">
          <ConnectedScopePill chat={chat} updateScopes={updateScopes} onDisconnect={setChat} />
        </div>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    await user.click(
      screen.getByRole("button", { name: "Disconnect Folder: alpha (/data/alpha) from chat" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Disconnect Folder: beta (/data/beta) from chat" }),
      ).toHaveFocus();
    });
  });

  it("clears the binding (null) when the last source is removed", async () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    const cleared: Chat = { ...chat, connectedScope: undefined };
    const updateScopes = vi.fn().mockResolvedValue({ chat: cleared } satisfies ChatResponse);
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectedScopePill chat={chat} updateScopes={updateScopes} onDisconnect={onDisconnect} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Disconnect File: a.ts (src/a.ts) from chat" }),
    );
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", null);
    });
    expect(onDisconnect).toHaveBeenCalledWith(cleared);
  });

  it("surfaces wire errors via role=alert", async () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    const updateScopes = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<ConnectedScopePill chat={chat} updateScopes={updateScopes} />);
    await user.click(
      screen.getByRole("button", { name: "Disconnect File: a.ts (src/a.ts) from chat" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("offline");
    });
  });

  it("renders the last grounded budget badge and summary", () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    const status = buildLastGroundedBudgetStatus(
      contextPack({ usage: { ...contextPack().usage, filesRead: 5 } }),
    );
    render(
      <ConnectedScopePill chat={chat} updateScopes={vi.fn()} lastGroundedBudgetStatus={status} />,
    );
    expect(screen.getByText("Moderate")).toBeInTheDocument();
    expect(screen.getByText(/Last grounded run:/)).toHaveTextContent("1.4k tokens, 5 files");
  });
});
