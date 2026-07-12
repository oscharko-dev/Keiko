import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatSessionProvider } from "../../context/ChatSessionContext";
import type { ChatSessionApi } from "../../hooks/useChatSession";
import { ProjectPanel } from "./ProjectPanel";

function session(): ChatSessionApi {
  return {
    projects: [
      {
        path: "/workspace/keiko",
        name: "Keiko",
        favorite: true,
        createdAt: 1,
        lastOpenedAt: 2,
        available: true,
      },
    ],
    chats: [
      {
        id: "chat-1",
        projectPath: "/workspace/keiko",
        title: "Investigate shell audit",
        selectedModel: "gpt-5.5",
        branchLabel: "codex/issue-526-audit",
        status: "open",
        connectedScope: undefined,
        localKnowledgeScope: undefined,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    messages: [],
    models: [],
    activeProject: {
      path: "/workspace/keiko",
      name: "Keiko",
      favorite: true,
      createdAt: 1,
      lastOpenedAt: 2,
      available: true,
    },
    activeChat: {
      id: "chat-1",
      projectPath: "/workspace/keiko",
      title: "Investigate shell audit",
      selectedModel: "gpt-5.5",
      branchLabel: "codex/issue-526-audit",
      status: "open",
      connectedScope: undefined,
      localKnowledgeScope: undefined,
      createdAt: 1,
      updatedAt: 2,
    },
    selectedModel: "gpt-5.5",
    noEligibleModels: false,
    draft: "",
    loading: false,
    sending: false,
    sendStatus: "idle",
    regeneratingMessageId: undefined,
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
    regenerateMessage: vi.fn(),
    cancelSend: vi.fn(),
    replaceChat: vi.fn(),
    latestGrounded: undefined,
    cancelGrounded: vi.fn(),
    pendingAttachments: [],
    addPendingAttachment: vi.fn(),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    forgetMemoryAction: vi.fn(),
    lastSentDocuments: [],
  };
}

describe("ProjectPanel", () => {
  it("renders live projects and chats from the chat-session context", () => {
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );

    expect(screen.getByText("Keiko")).toBeInTheDocument();
    expect(screen.getByText("Investigate shell audit")).toBeInTheDocument();
    expect(screen.queryByText("example-workspace")).toBeNull();
  });

  // Issue #644 — assistive technology must see the project/chat selection state, not just CSS.
  it("exposes aria-expanded, aria-current, and chat aria-pressed for the active project (issue #644)", () => {
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const projectButton = screen.getByRole("treeitem", { name: /Keiko/ });
    expect(projectButton).toHaveAttribute("aria-expanded", "true");
    expect(projectButton).toHaveAttribute("aria-current", "true");
    const chatButton = screen.getByRole("treeitem", { name: /Investigate shell audit/ });
    expect(chatButton).toHaveAttribute("aria-selected", "true");
  });

  // PA-03 — WAI-ARIA tree pattern: role="tree", role="treeitem", aria-level, aria-expanded.
  it("wraps projects in a role=tree container (PA-03)", () => {
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    expect(screen.getByRole("tree", { name: "Projects" })).toBeInTheDocument();
  });

  it("project row has role=treeitem at aria-level 1 (PA-03)", () => {
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const treeitem = screen.getByRole("treeitem", { name: /Keiko/ });
    expect(treeitem).toHaveAttribute("aria-level", "1");
    expect(treeitem).toHaveAttribute("aria-expanded", "true");
  });

  it("child chat row has role=treeitem at aria-level 2 with aria-selected (PA-03)", () => {
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const chatItem = screen.getByRole("treeitem", { name: /Investigate shell audit/ });
    expect(chatItem).toHaveAttribute("aria-level", "2");
    expect(chatItem).toHaveAttribute("aria-selected", "true");
  });

  it("child group has role=group (PA-03)", () => {
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    expect(screen.getByRole("group", { name: "Keiko" })).toBeInTheDocument();
  });

  // Focus-transition keys — parameterized per SonarCloud S5976. Each row moves
  // focus from the seeded item to the expected target without touching
  // aria-expanded state.
  it.each([
    {
      key: "ArrowDown",
      startName: /Keiko/,
      endName: /Investigate shell audit/,
      note: "moves focus from project to first child chat",
    },
    {
      key: "ArrowUp",
      startName: /Investigate shell audit/,
      endName: /Keiko/,
      note: "moves focus from chat back to parent project",
    },
    {
      key: "Home",
      startName: /Investigate shell audit/,
      endName: /Keiko/,
      note: "moves focus to the first treeitem",
    },
    {
      key: "End",
      startName: /Keiko/,
      endName: /Investigate shell audit/,
      note: "moves focus to the last treeitem",
    },
    {
      // ArrowLeft on a level-2 chat item routes to focusParentTreeItem: the
      // chat button has no aria-expanded="true" attribute.
      key: "ArrowLeft",
      startName: /Investigate shell audit/,
      endName: /Keiko/,
      note: "moves focus from chat back to its parent project",
    },
    {
      // ArrowRight on an already-expanded project focuses its first child.
      key: "ArrowRight",
      startName: /Keiko/,
      endName: /Investigate shell audit/,
      note: "moves focus from expanded project to the first child",
    },
  ])("$key $note (PA-03)", async ({ key, startName, endName }) => {
    const user = userEvent.setup();
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    screen.getByRole("treeitem", { name: startName }).focus();
    await user.keyboard(`{${key}}`);
    expect(screen.getByRole("treeitem", { name: endName })).toHaveFocus();
  });

  // ArrowLeft on an expanded project collapses it (aria-expanded="true" → click).
  it("ArrowLeft collapses an expanded project (PA-03)", async () => {
    const user = userEvent.setup();
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const projectItem = screen.getByRole("treeitem", { name: /Keiko/ });
    projectItem.focus();
    expect(projectItem).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowLeft}");
    expect(projectItem).toHaveAttribute("aria-expanded", "false");
  });

  // ArrowRight on a collapsed project triggers a click to expand it.
  it("ArrowRight on a collapsed project expands it (PA-03)", async () => {
    const user = userEvent.setup();
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const projectItem = screen.getByRole("treeitem", { name: /Keiko/ });
    projectItem.focus();
    // First collapse the project (it starts expanded because it is the active project).
    await user.keyboard("{ArrowLeft}");
    expect(projectItem).toHaveAttribute("aria-expanded", "false");
    // Now ArrowRight should re-expand.
    await user.keyboard("{ArrowRight}");
    expect(projectItem).toHaveAttribute("aria-expanded", "true");
  });

  // handleTreeKey guards: non-registered keys don't crash, non-treeitem targets are ignored.
  it("ignores non-tree navigation keys (PA-03)", async () => {
    const user = userEvent.setup();
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const projectItem = screen.getByRole("treeitem", { name: /Keiko/ });
    projectItem.focus();
    await user.keyboard("a");
    expect(projectItem).toHaveFocus();
  });
});
