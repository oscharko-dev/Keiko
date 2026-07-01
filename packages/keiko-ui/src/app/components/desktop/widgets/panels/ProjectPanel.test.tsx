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
    budget: undefined,
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    forgetMemoryAction: vi.fn(),
    clearHistory: vi.fn(),
    launchWorkflowFromConversation: vi.fn(),
    launchGroundedWorkflowHandoff: vi.fn(),
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

  it("ArrowDown moves focus from project to first child chat (PA-03)", async () => {
    const user = userEvent.setup();
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const projectItem = screen.getByRole("treeitem", { name: /Keiko/ });
    projectItem.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("treeitem", { name: /Investigate shell audit/ })).toHaveFocus();
  });

  it("ArrowUp moves focus from chat back to parent project (PA-03)", async () => {
    const user = userEvent.setup();
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const chatItem = screen.getByRole("treeitem", { name: /Investigate shell audit/ });
    chatItem.focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("treeitem", { name: /Keiko/ })).toHaveFocus();
  });

  it("Home moves focus to the first treeitem (PA-03)", async () => {
    const user = userEvent.setup();
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const chatItem = screen.getByRole("treeitem", { name: /Investigate shell audit/ });
    chatItem.focus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("treeitem", { name: /Keiko/ })).toHaveFocus();
  });

  it("End moves focus to the last treeitem (PA-03)", async () => {
    const user = userEvent.setup();
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const projectItem = screen.getByRole("treeitem", { name: /Keiko/ });
    projectItem.focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("treeitem", { name: /Investigate shell audit/ })).toHaveFocus();
  });
});
