import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/lib/types";
import { deleteChat, updateChat } from "@/lib/api";
import { I18nProvider } from "@/lib/i18n";
import { ChatSessionProvider } from "../../context/ChatSessionContext";
import type { ChatSessionApi } from "../../hooks/useChatSession";
import { notifyChatDeleted } from "../../hooks/useChatSession";
import { ChatHistoryPanel, initialTabIndex } from "./ChatHistoryPanel";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    deleteChat: vi.fn(),
    updateChat: vi.fn(),
  };
});

vi.mock("../../hooks/useChatSession", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/useChatSession")>(
    "../../hooks/useChatSession",
  );
  return { ...actual, notifyChatDeleted: vi.fn() };
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

function makeProject(path: string): NonNullable<ChatSessionApi["activeProject"]> {
  return {
    path,
    name: path.slice(1),
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 2,
    available: true,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve): void => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
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
    await user.click(within(scoped).getByRole("button", { name: /^Delete\b/ }));
    expect(screen.getByRole("button", { name: /^Cancel\b/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Delete\b/ }));

    await waitFor(() => expect(updateChat).toHaveBeenCalledWith("chat-1", { status: "closed" }));
    expect(replaceChat).toHaveBeenCalledWith({ ...chat, status: "closed" });
  });

  it("does not open a chat after the active project changes during creation", async (): Promise<void> => {
    const creation = deferred<Chat | undefined>();
    const backgroundChat = makeChat({ id: "chat-background", projectPath: "/repo" });
    const openNewChat = vi.fn((): Promise<Chat | undefined> => creation.promise);
    const openChatWindow = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <ChatSessionProvider
        value={makeSession({ activeProject: makeProject("/repo"), openNewChat })}
      >
        <ChatHistoryPanel openChatWindow={openChatWindow} />
      </ChatSessionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "New" }));
    await waitFor((): void => expect(openNewChat).toHaveBeenCalledOnce());
    view.rerender(
      <ChatSessionProvider
        value={makeSession({ activeProject: makeProject("/other"), openNewChat })}
      >
        <ChatHistoryPanel openChatWindow={openChatWindow} />
      </ChatSessionProvider>,
    );
    await act(async (): Promise<void> => {
      creation.resolve(backgroundChat);
      await creation.promise;
    });

    expect(openChatWindow).not.toHaveBeenCalled();
  });

  it("opens a created chat when the requested project remains active", async (): Promise<void> => {
    const created = makeChat({ id: "chat-created", projectPath: "/repo" });
    const openNewChat = vi.fn(async (): Promise<Chat | undefined> => created);
    const openChatWindow = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatSessionProvider
        value={makeSession({ activeProject: makeProject("/repo"), openNewChat })}
      >
        <ChatHistoryPanel openChatWindow={openChatWindow} />
      </ChatSessionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "New" }));

    await waitFor((): void => expect(openChatWindow).toHaveBeenCalledWith(created));
  });

  it("opens the adopted fallback project chat from projectless bootstrap", async (): Promise<void> => {
    const created = makeChat({ id: "chat-fallback", projectPath: "/fallback" });
    const openNewChat = vi.fn(async (): Promise<Chat | undefined> => created);
    const openChatWindow = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatSessionProvider value={makeSession({ activeProject: undefined, openNewChat })}>
        <ChatHistoryPanel openChatWindow={openChatWindow} />
      </ChatSessionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "New" }));

    await waitFor((): void => expect(openChatWindow).toHaveBeenCalledWith(created));
  });

  it("does not open a fallback chat after leaving projectless bootstrap", async (): Promise<void> => {
    const creation = deferred<Chat | undefined>();
    const created = makeChat({ id: "chat-fallback", projectPath: "/fallback" });
    const openNewChat = vi.fn((): Promise<Chat | undefined> => creation.promise);
    const openChatWindow = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <ChatSessionProvider value={makeSession({ activeProject: undefined, openNewChat })}>
        <ChatHistoryPanel openChatWindow={openChatWindow} />
      </ChatSessionProvider>,
    );
    await user.click(screen.getByRole("button", { name: "New" }));
    await waitFor((): void => expect(openNewChat).toHaveBeenCalledOnce());

    view.rerender(
      <ChatSessionProvider
        value={makeSession({ activeProject: makeProject("/other"), openNewChat })}
      >
        <ChatHistoryPanel openChatWindow={openChatWindow} />
      </ChatSessionProvider>,
    );
    await act(async (): Promise<void> => {
      creation.resolve(created);
      await creation.promise;
    });

    expect(openChatWindow).not.toHaveBeenCalled();
  });

  it("keeps the active tab selected after deleting a chat", async () => {
    const chat = makeChat();
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: { ...chat, status: "closed" } });
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat] }));

    const row = screen.getByText("Sprint triage").closest(".chat-history-row");
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole("button", { name: /^Delete\b/ }));
    await user.click(screen.getByRole("button", { name: /^Delete\b/ }));

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

  it("cancels a hard-purge confirmation without calling the server", async () => {
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [makeChat({ status: "closed" })] }));
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("button", { name: /^Delete .* permanently$/i }));
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Cancel\b/ }));

    expect(deleteChat).not.toHaveBeenCalled();
  });

  it("purges only after server success and publishes the existing delete mutation", async () => {
    vi.mocked(deleteChat).mockResolvedValueOnce();
    const chat = makeChat({ status: "closed" });
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat], activeProject: makeProject("/repo") }));
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("button", { name: /^Delete .* permanently$/i }));
    await user.click(screen.getByRole("button", { name: /^Confirm permanent delete of/ }));

    await waitFor(() => expect(deleteChat).toHaveBeenCalledWith("chat-1", "/repo"));
    expect(notifyChatDeleted).toHaveBeenCalledWith("chat-1");
  });

  it("keeps a failed purge available for an explicit retry", async () => {
    vi.mocked(deleteChat).mockRejectedValueOnce(new Error("disk busy")).mockResolvedValueOnce();
    const chat = makeChat({ status: "closed" });
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat], activeProject: makeProject("/repo") }));
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("button", { name: /^Delete .* permanently$/i }));
    await user.click(screen.getByRole("button", { name: /^Confirm permanent delete of/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("disk busy");
    expect(notifyChatDeleted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Confirm permanent delete of/ }));
    await waitFor(() => expect(deleteChat).toHaveBeenCalledTimes(2));
    expect(notifyChatDeleted).toHaveBeenCalledWith("chat-1");
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

    await user.click(screen.getByRole("button", { name: /^Rename\b/ }));
    const input = screen.getByDisplayValue("Old title");
    await user.clear(input);
    await user.type(input, "New title");
    await user.click(screen.getByRole("button", { name: /^Save\b/ }));

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

    await user.click(screen.getByRole("button", { name: /^Rename\b/ }));
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    await user.click(screen.getByRole("button", { name: /^Save\b/ }));

    // Field must still be present and marked invalid — not silently dismissed.
    expect(renameInput).toBeInTheDocument();
    expect(renameInput).toHaveAttribute("aria-invalid", "true");
    expect(updateChat).not.toHaveBeenCalled();
  });

  it("empty rename shows an associated error message via aria-describedby (PA-05)", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: /^Rename\b/ }));
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    await user.click(screen.getByRole("button", { name: /^Save\b/ }));

    const describedById = renameInput.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const errorEl = document.getElementById(describedById as string);
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toMatch(/empty/i);
  });

  it("rename error clears when the user starts typing again (PA-05)", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: /^Rename\b/ }));
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    await user.click(screen.getByRole("button", { name: /^Save\b/ }));

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
    const deleteButton = within(scoped).getByRole("button", { name: /^Delete\b/ });
    deleteButton.focus();
    await user.keyboard("{Enter}");

    // Confirmation mode: focus lands on the destructive confirm Delete button.
    const confirmDelete = within(scoped).getByRole("button", { name: /^Delete\b/ });
    expect(confirmDelete).toHaveFocus();
    expect(within(scoped).getByRole("button", { name: /^Cancel\b/ })).toBeInTheDocument();

    // Escape cancels the confirmation and restores the default row actions.
    await user.keyboard("{Escape}");
    expect(within(scoped).queryByRole("button", { name: /^Cancel\b/ })).toBeNull();
    expect(within(scoped).getByRole("button", { name: /^Rename\b/ })).toBeInTheDocument();
    expect(within(scoped).getByRole("button", { name: /^Delete\b/ })).toBeInTheDocument();
    expect(updateChat).not.toHaveBeenCalled();
  });

  // #2723 (S3358): clicking Cancel while editing a title (distinct from the "empty submit"
  // and "typing clears the error" paths already covered above).
  it("cancels an in-progress rename without saving (PA-05)", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: /^Rename\b/ }));
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    await user.type(renameInput, "Changed title");
    await user.click(screen.getByRole("button", { name: /^Cancel\b/ }));

    expect(screen.queryByDisplayValue("Changed title")).toBeNull();
    expect(screen.getByText("Sprint triage")).toBeInTheDocument();
    expect(updateChat).not.toHaveBeenCalled();
  });

  // #2723 (S3358): clicking (not keying Escape on) the confirm-mode Cancel button.
  it("clicking Cancel during delete-confirm closes it without deleting", async () => {
    const user = userEvent.setup();
    renderPanel();

    const row = screen.getByText("Sprint triage").closest(".chat-history-row");
    expect(row).not.toBeNull();
    const scoped = row as HTMLElement;

    await user.click(within(scoped).getByRole("button", { name: /^Delete\b/ }));
    await user.click(within(scoped).getByRole("button", { name: /^Cancel\b/ }));

    expect(within(scoped).queryByRole("button", { name: /^Cancel\b/ })).toBeNull();
    expect(within(scoped).getByRole("button", { name: /^Rename\b/ })).toBeInTheDocument();
    expect(updateChat).not.toHaveBeenCalled();
  });

  // #2723 (S3358): Escape while focus is on the confirm-mode Delete button itself (the
  // existing GEN-UI-FOCUS-016 test above focuses it via Enter-to-activate; this pins the
  // handler directly regardless of that focus path).
  it("Escape on the confirm Delete button cancels the delete confirmation", async () => {
    const user = userEvent.setup();
    renderPanel();

    const row = screen.getByText("Sprint triage").closest(".chat-history-row");
    expect(row).not.toBeNull();
    const scoped = row as HTMLElement;

    await user.click(within(scoped).getByRole("button", { name: /^Delete\b/ }));
    const confirmDelete = within(scoped).getByRole("button", { name: /^Delete\b/ });
    confirmDelete.focus();
    await user.keyboard("{Escape}");

    expect(within(scoped).queryByRole("button", { name: /^Cancel\b/ })).toBeNull();
    expect(within(scoped).getByRole("button", { name: /^Rename\b/ })).toBeInTheDocument();
    expect(updateChat).not.toHaveBeenCalled();
  });

  // #2723 (S3358): Escape while focus is on the confirm-mode Cancel button (its own
  // onKeyDown, distinct from the Delete button's handler pinned above).
  it("Escape on the confirm Cancel button also cancels the delete confirmation", async () => {
    const user = userEvent.setup();
    renderPanel();

    const row = screen.getByText("Sprint triage").closest(".chat-history-row");
    expect(row).not.toBeNull();
    const scoped = row as HTMLElement;

    await user.click(within(scoped).getByRole("button", { name: /^Delete\b/ }));
    const cancelButton = within(scoped).getByRole("button", { name: /^Cancel\b/ });
    cancelButton.focus();
    await user.keyboard("{Escape}");

    expect(within(scoped).queryByRole("button", { name: /^Cancel\b/ })).toBeNull();
    expect(within(scoped).getByRole("button", { name: /^Rename\b/ })).toBeInTheDocument();
    expect(updateChat).not.toHaveBeenCalled();
  });

  // #2723 (S3358): the "deleted" row-actions branch has its own Rename button (distinct
  // JSX from the default branch's Rename button already exercised above).
  // KEIKO-0452: with more than one row visible, every action button's accessible name must be
  // unique (include the chat title). Otherwise a screen-reader user cannot tell one Delete
  // button from another — worst-case, the irreversible purge Delete.
  it("gives every row-scoped action button a chat-scoped, unique accessible name", () => {
    const chatA = makeChat({ id: "a", title: "Sprint triage" });
    const chatB = makeChat({ id: "b", title: "Bug hunt" });
    renderPanel(makeSession({ chats: [chatA, chatB] }));
    const renameButtons = screen.getAllByRole("button", { name: /^Rename\b/ });
    const deleteButtons = screen.getAllByRole("button", { name: /^Delete\b/ });
    const renameNames = renameButtons.map((btn) => btn.getAttribute("aria-label"));
    const deleteNames = deleteButtons.map((btn) => btn.getAttribute("aria-label"));
    expect(new Set(renameNames).size).toBe(renameNames.length);
    expect(new Set(deleteNames).size).toBe(deleteNames.length);
    expect(renameNames).toEqual(
      expect.arrayContaining(["Rename Sprint triage", "Rename Bug hunt"]),
    );
    expect(deleteNames).toEqual(
      expect.arrayContaining(["Delete Sprint triage", "Delete Bug hunt"]),
    );
    expect(screen.getByRole("article", { name: "Sprint triage" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Bug hunt" })).toBeInTheDocument();
  });

  it("renames a deleted chat from its history row", async () => {
    const chat = makeChat({ status: "closed" });
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat] }));

    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("button", { name: /^Rename\b/ }));

    expect(screen.getByDisplayValue("Sprint triage")).toBeInTheDocument();
  });
});

// KEIKO-0820 — rename/delete/restore failure messages were hardcoded English, unlike the sibling
// purge path (setError(optionalT("chat.history.purgeFailed", { detail }))). Locale set to German
// (matching the window.localStorage.setItem("keiko.locale", "de") pattern established by
// KeyboardShortcutsPanel.test.tsx) proves each of the four paths now renders through the optional
// widget catalog instead of the literal English string.
//
// useLocale()/useOptionalWidgetTranslate() read from I18nProvider's LocaleContext, which the shared
// module-level `renderPanel` above does not wrap (it only needs ChatSessionProvider for its other 29
// tests, and adding I18nProvider there would change their harness too) — so these tests wrap
// I18nProvider locally instead. The context's exposed locale starts on English and only flips to the
// stored "de" once I18nProvider's `ready`/`catalogReady` effect settles (see
// packages/keiko-ui/src/lib/i18n.test.tsx's "keeps locale ... until German is ready" pin for the same
// two-phase transition), so every test below waits on document.documentElement.lang before
// interacting — the same signal I18nProvider's own effect updates once it is truly on German.
describe("ChatHistoryPanel localized failure messages (KEIKO-0820)", () => {
  function renderGermanPanel(session: ChatSessionApi = makeSession()): void {
    render(
      <I18nProvider>
        <ChatSessionProvider value={session}>
          <ChatHistoryPanel openChatWindow={vi.fn()} />
        </ChatSessionProvider>
      </I18nProvider>,
    );
  }

  beforeEach(() => {
    window.localStorage.setItem("keiko.locale", "de");
  });

  afterEach(() => {
    window.localStorage.removeItem("keiko.locale");
    document.documentElement.lang = "en";
    document.documentElement.removeAttribute("data-locale");
  });

  it("shows the German empty-title rename error, not the English literal", async () => {
    const user = userEvent.setup();
    renderGermanPanel();
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));

    // #2906 round 3: the accessible name (aria-label, t("chat.history.action.rename", { title }))
    // and the VISIBLE button copy (t("chat.history.action.renameLabel")) are both German now — a
    // sighted user and a screen-reader user see/hear the same language (WCAG 2.5.3 Label in
    // Name), so this asserts both rather than only the accessible name the query happens to match.
    const renameButton = screen.getByRole("button", { name: /umbenennen/i });
    expect(renameButton).toHaveTextContent("Umbenennen");
    await user.click(renameButton);
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    const saveButton = screen.getByRole("button", { name: /speichern/i });
    expect(saveButton).toHaveTextContent("Speichern");
    await user.click(saveButton);

    const describedById = renameInput.getAttribute("aria-describedby");
    const errorEl = document.getElementById(describedById as string);
    expect(errorEl?.textContent).toBe("Titel darf nicht leer sein.");
    expect(errorEl?.textContent).not.toBe("Title cannot be empty.");
  });

  it("shows the German rename-failed error, not the English literal", async () => {
    vi.mocked(updateChat).mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    renderGermanPanel();
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));

    await user.click(screen.getByRole("button", { name: /umbenennen/i }));
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    await user.type(renameInput, "New title");
    await user.click(screen.getByRole("button", { name: /speichern/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Umbenennen fehlgeschlagen.");
    expect(alert).not.toHaveTextContent("Rename failed.");
  });

  it("shows the German delete-failed error with the caught detail, not the English literal", async () => {
    vi.mocked(updateChat).mockRejectedValueOnce(new Error("disk busy"));
    const user = userEvent.setup();
    renderGermanPanel();
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));

    // Both the trigger and the confirm button share the same aria-label pattern
    // (t("chat.history.action.delete", { title })) for the non-deleted (moveToTrash) row.
    await user.click(screen.getByRole("button", { name: /löschen/i }));
    await user.click(screen.getByRole("button", { name: /löschen/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Löschen fehlgeschlagen: disk busy");
    expect(alert).not.toHaveTextContent("Delete failed:");
  });

  it("shows the German restore-failed error with the caught detail, not the English literal", async () => {
    vi.mocked(updateChat).mockRejectedValueOnce(new Error("disk busy"));
    const user = userEvent.setup();
    renderGermanPanel(makeSession({ chats: [makeChat({ status: "closed" })] }));
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));

    // #2906 round 3: the "Active"/"Deleted" tab labels now route through t("chat.history.tab.*"),
    // so their accessible name (there is no separate aria-label — the visible text IS the name) is
    // German too. Assert both the query match and the visible text explicitly.
    const deletedTab = screen.getByRole("tab", { name: /gelöscht/i });
    expect(deletedTab).toHaveTextContent("Gelöscht");
    await user.click(deletedTab);
    await user.click(screen.getByRole("button", { name: /wiederherstellen/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Wiederherstellen fehlgeschlagen: disk busy");
    expect(alert).not.toHaveTextContent("Restore failed:");
  });
});

describe("initialTabIndex", () => {
  // #2723 (S3358): the roving-tablist "from" index if/else chain, extracted from a nested
  // ternary — all three branches.
  it("returns the current index unchanged when it is already a valid tab index", () => {
    expect(initialTabIndex("active", 1)).toBe(1);
  });

  it("defaults to the Active tab (index 0) when nothing is focused in the active view", () => {
    expect(initialTabIndex("active", -1)).toBe(0);
  });

  it("defaults to the Deleted tab (index 1) when nothing is focused in the deleted view", () => {
    expect(initialTabIndex("deleted", -1)).toBe(1);
  });
});
