import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/lib/types";
import { updateChat } from "@/lib/api";
import { ChatSessionProvider } from "../../context/ChatSessionContext";
import type { ChatSessionApi } from "../../hooks/useChatSession";
import { ChatHistoryPanel } from "./ChatHistoryPanel";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    updateChat: vi.fn(),
  };
});

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/repo",
    title: "Sprint triage",
    selectedModel: "gpt-oss-120b",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSessionApi> = {}): ChatSessionApi {
  return {
    projects: [],
    chats: [makeChat()],
    messages: [],
    models: [],
    activeProject: undefined,
    activeChat: undefined,
    selectedModel: "gpt-oss-120b",
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
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    lastSentDocuments: [],
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    forgetMemoryAction: vi.fn(),
    ...overrides,
  };
}

function renderPanel(session: ChatSessionApi = makeSession()): void {
  render(
    <ChatSessionProvider value={session}>
      <ChatHistoryPanel openChatWindow={vi.fn()} />
    </ChatSessionProvider>,
  );
}

describe("ChatHistoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves a chat to deleted after confirmation through the PATCH helper", async () => {
    const chat = makeChat();
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: { ...chat, status: "closed" } });
    const replaceChat = vi.fn();
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat], replaceChat }));

    const row = screen.getByText("Sprint triage").closest(".chat-history-row");
    expect(row).not.toBeNull();
    const scoped = row as HTMLElement;
    await user.click(within(scoped).getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(updateChat).toHaveBeenCalledWith("chat-1", { status: "closed" }));
    expect(replaceChat).toHaveBeenCalledWith({ ...chat, status: "closed" });
  });

  it("keeps the active tab selected after deleting a chat", async () => {
    const chat = makeChat();
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: { ...chat, status: "closed" } });
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat] }));

    const row = screen.getByText("Sprint triage").closest(".chat-history-row");
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(updateChat).toHaveBeenCalledWith("chat-1", { status: "closed" }));
    expect(screen.getByRole("tab", { name: /active/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /deleted/i })).toHaveAttribute("aria-selected", "false");
  });

  it("restores a deleted chat through the PATCH helper", async () => {
    const chat = makeChat({ status: "closed" });
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: { ...chat, status: "open" } });
    const replaceChat = vi.fn();
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat], replaceChat }));

    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("button", { name: /restore/i }));

    await waitFor(() => expect(updateChat).toHaveBeenCalledWith("chat-1", { status: "open" }));
    expect(replaceChat).toHaveBeenCalledWith({ ...chat, status: "open" });
  });

  it("keeps the deleted tab selected after restoring a chat", async () => {
    const chat = makeChat({ status: "closed" });
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: { ...chat, status: "open" } });
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat] }));

    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("button", { name: /restore/i }));

    await waitFor(() => expect(updateChat).toHaveBeenCalledWith("chat-1", { status: "open" }));
    expect(screen.getByRole("tab", { name: /active/i })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: /deleted/i })).toHaveAttribute("aria-selected", "true");
  });

  it("renames a chat through the PATCH helper", async () => {
    const chat = makeChat({ title: "Old title" });
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: { ...chat, title: "New title" } });
    const replaceChat = vi.fn();
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat], replaceChat }));

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByDisplayValue("Old title");
    await user.clear(input);
    await user.type(input, "New title");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateChat).toHaveBeenCalledWith("chat-1", { title: "New title" }));
    expect(replaceChat).toHaveBeenCalledWith({ ...chat, title: "New title" });
  });

  // PA-04 — tabs must be linked to their tabpanel via aria-controls / aria-labelledby.
  it("tabs carry aria-controls pointing to the tabpanel (PA-04)", () => {
    renderPanel();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    const panelId = tabs[0]?.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    // Both tabs control the same panel (single panel, switching content).
    expect(tabs[1]?.getAttribute("aria-controls")).toBe(panelId);
    const panel = document.getElementById(panelId as string);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("role", "tabpanel");
  });

  it("tabpanel is labelled by the active tab (PA-04)", () => {
    renderPanel();
    const activeTab = screen.getByRole("tab", { name: /active/i });
    const tabId = activeTab.getAttribute("id");
    expect(tabId).toBeTruthy();
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tabId);
  });

  it("tabpanel aria-labelledby updates when Deleted tab is selected (PA-04)", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    const deletedTabId = screen.getByRole("tab", { name: /deleted/i }).getAttribute("id");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", deletedTabId);
  });

  // PA-05 — empty rename must not silently discard; field stays open with aria-invalid.
  it("keeps the rename field open with aria-invalid on empty submit (PA-05)", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Field must still be present and marked invalid — not silently dismissed.
    expect(renameInput).toBeInTheDocument();
    expect(renameInput).toHaveAttribute("aria-invalid", "true");
    expect(updateChat).not.toHaveBeenCalled();
  });

  it("empty rename shows an associated error message via aria-describedby (PA-05)", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    await user.click(screen.getByRole("button", { name: "Save" }));

    const describedById = renameInput.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const errorEl = document.getElementById(describedById as string);
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toMatch(/empty/i);
  });

  it("rename error clears when the user starts typing again (PA-05)", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Error is shown; now type to clear it.
    await user.type(renameInput, "x");
    expect(renameInput).not.toHaveAttribute("aria-invalid", "true");
  });

  // GEN-UI-KEYBOARD-008 (test-plan #42) — the tablist is a single roving tab stop:
  // ArrowRight from the Active tab moves BOTH focus and selection to the Deleted tab.
  it("ArrowRight on the Active tab rovers focus and selection to Deleted (GEN-UI-KEYBOARD-008)", async () => {
    const user = userEvent.setup();
    renderPanel();

    const activeTab = screen.getByRole("tab", { name: /active/i });
    const deletedTab = screen.getByRole("tab", { name: /deleted/i });

    // Roving tabindex: only the selected (Active) tab is a Tab stop.
    expect(activeTab).toHaveAttribute("tabindex", "0");
    expect(deletedTab).toHaveAttribute("tabindex", "-1");

    activeTab.focus();
    expect(activeTab).toHaveFocus();

    await user.keyboard("{ArrowRight}");

    // Focus and selection both moved to the Deleted tab; roving tabindex flipped.
    expect(deletedTab).toHaveFocus();
    expect(deletedTab).toHaveAttribute("aria-selected", "true");
    expect(activeTab).toHaveAttribute("aria-selected", "false");
    expect(deletedTab).toHaveAttribute("tabindex", "0");
    expect(activeTab).toHaveAttribute("tabindex", "-1");

    // ArrowLeft wraps back to Active.
    await user.keyboard("{ArrowLeft}");
    expect(activeTab).toHaveFocus();
    expect(activeTab).toHaveAttribute("aria-selected", "true");
  });

  // GEN-UI-FOCUS-016 (test-plan #43) — entering inline delete-confirm moves focus onto
  // the confirmation, and Escape cancels the destructive confirm.
  it("focuses the confirm Delete button on delete-confirm and cancels on Escape (GEN-UI-FOCUS-016)", async () => {
    const user = userEvent.setup();
    renderPanel();

    const row = screen.getByText("Sprint triage").closest(".chat-history-row");
    expect(row).not.toBeNull();
    const scoped = row as HTMLElement;

    // Activate Delete via keyboard (focus + Enter).
    const deleteButton = within(scoped).getByRole("button", { name: "Delete" });
    deleteButton.focus();
    await user.keyboard("{Enter}");

    // Confirmation mode: focus lands on the destructive confirm Delete button.
    const confirmDelete = within(scoped).getByRole("button", { name: "Delete" });
    expect(confirmDelete).toHaveFocus();
    expect(within(scoped).getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // Escape cancels the confirmation and restores the default row actions.
    await user.keyboard("{Escape}");
    expect(within(scoped).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(within(scoped).getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(within(scoped).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(updateChat).not.toHaveBeenCalled();
  });
});
