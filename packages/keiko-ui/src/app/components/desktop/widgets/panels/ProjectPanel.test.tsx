import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectWithAvailability } from "@/lib/types";
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

  // KEIKO-0262: ArrowRight (expand) and ArrowLeft (collapse) must never activate the project —
  // otherwise the user's composer draft is silently discarded on any keyboard tree navigation.
  it("ArrowRight/ArrowLeft toggle expansion without calling openProject", async () => {
    const user = userEvent.setup();
    const openProject = vi.fn();
    const otherProject: ProjectWithAvailability = {
      path: "/workspace/other",
      name: "OtherProject",
      favorite: false,
      createdAt: 3,
      lastOpenedAt: 4,
      available: true,
    };
    render(
      <ChatSessionProvider
        value={{ ...session(), openProject, projects: [session().projects[0]!, otherProject] }}
      >
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const other = screen.getByRole("treeitem", { name: /OtherProject/ });
    other.focus();
    expect(other).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{ArrowRight}");
    expect(other).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowLeft}");
    expect(other).toHaveAttribute("aria-expanded", "false");

    expect(openProject).not.toHaveBeenCalled();
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

  // #2723 (S3358): the "not the active project" branch — expanding a project that is not the
  // active one must not show its (unfetched) chats.
  it("tells you to select the project before its chats load (S3358)", async () => {
    const user = userEvent.setup();
    const otherProject: ProjectWithAvailability = {
      path: "/workspace/other",
      name: "OtherProject",
      favorite: false,
      createdAt: 3,
      lastOpenedAt: 4,
      available: true,
    };
    render(
      <ChatSessionProvider
        value={{ ...session(), projects: [session().projects[0]!, otherProject] }}
      >
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    // OtherProject starts collapsed (it is not the active project); expand it.
    await user.click(screen.getByRole("treeitem", { name: /OtherProject/ }));
    const group = screen.getByRole("group", { name: "OtherProject" });
    expect(within(group).getByText("Select project to load chats")).toBeInTheDocument();
  });

  // #2723 (S3358): the "no chats" branch, distinct from the "not active" branch.
  it("shows a no-chats message for the active project once it has none (S3358)", () => {
    render(
      <ChatSessionProvider value={{ ...session(), chats: [] }}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const group = screen.getByRole("group", { name: "Keiko" });
    expect(within(group).getByText("No chats")).toBeInTheDocument();
  });

  // WCAG 2.5.8 Target Size (Minimum): the caret button's pointer target must be at least
  // 24×24 CSS pixels (Codex on PR #3089: 3766009390).
  it("gives the caret a >=24x24 CSS-px pointer target (WCAG 2.5.8)", () => {
    render(
      <ChatSessionProvider value={session()}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const caret = document.querySelector<HTMLButtonElement>("button.proj-caret-btn");
    expect(caret).not.toBeNull();
    // jsdom returns the inline style values as strings; the visible chevron stays smaller
    // but the button's own hit area is what the pointer sees.
    expect(caret?.style.width).toBe("24px");
    expect(caret?.style.height).toBe("24px");
  });

  // #2723: the chat row's onClick — confirms the click wiring the extracted render
  // function still attaches to each rendered chat button.
  it("opens a chat when its treeitem is clicked", async () => {
    const user = userEvent.setup();
    const openChat = vi.fn();
    render(
      <ChatSessionProvider value={{ ...session(), openChat }}>
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    await user.click(screen.getByRole("treeitem", { name: /Investigate shell audit/ }));
    expect(openChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chat-1", title: "Investigate shell audit" }),
    );
  });

  // #2723 (S3358): the chat-meta branchLabel span's "undefined" (null) branch — the default
  // fixture chat always has a branchLabel, so this covers the omitted case.
  it("omits the branch-label meta span when a chat has no branch label", () => {
    const withoutBranch = { ...session() };
    render(
      <ChatSessionProvider
        value={{
          ...withoutBranch,
          chats: withoutBranch.chats.map((chat) => ({ ...chat, branchLabel: undefined })),
        }}
      >
        <ProjectPanel />
      </ChatSessionProvider>,
    );
    const chatItem = screen.getByRole("treeitem", { name: /Investigate shell audit/ });
    expect(within(chatItem).queryByText("codex/issue-526-audit")).toBeNull();
  });
});
