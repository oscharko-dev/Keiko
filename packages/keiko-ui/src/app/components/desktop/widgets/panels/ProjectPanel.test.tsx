import { render, screen } from "@testing-library/react";
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
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
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
    clearHistory: vi.fn(),
    launchWorkflowFromConversation: vi.fn(),
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
    const projectButton = screen.getByRole("button", { name: /Keiko/ });
    expect(projectButton).toHaveAttribute("aria-expanded", "true");
    expect(projectButton).toHaveAttribute("aria-current", "true");
    const chatButton = screen.getByRole("button", { name: /Investigate shell audit/ });
    expect(chatButton).toHaveAttribute("aria-pressed", "true");
  });
});
