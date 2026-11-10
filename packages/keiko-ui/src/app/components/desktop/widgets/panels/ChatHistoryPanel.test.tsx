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
import { deleteHistoryChats } from "./chatHistoryDeletion";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "@/lib/client-diagnostics";
import type { ClientDiagnosticMeta } from "@/lib/client-diagnostics";

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

async function confirmPurge(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
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
    resetClientDiagnosticWriter();
  });

  it("moves an active chat to Deleted on Delete and never purges it (#4335)", async () => {
    const chat = makeChat();
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: { ...chat, status: "closed" } });
    const replaceChat = vi.fn();
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat], replaceChat }));
    await user.click(screen.getByRole("button", { name: "Delete Sprint triage" }));
    await waitFor(() => expect(updateChat).toHaveBeenCalledWith("chat-1", { status: "closed" }));
    expect(replaceChat).toHaveBeenCalledWith({ ...chat, status: "closed" });
    expect(deleteChat).not.toHaveBeenCalled();
    expect(notifyChatDeleted).not.toHaveBeenCalled();
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

  it("keeps New disabled until the chat session has loaded", async (): Promise<void> => {
    const openNewChat = vi.fn(async (): Promise<Chat | undefined> => undefined);
    const view = render(
      <ChatSessionProvider value={makeSession({ loading: true, openNewChat })}>
        <ChatHistoryPanel openChatWindow={vi.fn()} />
      </ChatSessionProvider>,
    );
    // A click during the session bootstrap created nothing and reported a false "no model" error.
    expect(screen.getByRole("button", { name: "New" })).toBeDisabled();

    view.rerender(
      <ChatSessionProvider value={makeSession({ loading: false, openNewChat })}>
        <ChatHistoryPanel openChatWindow={vi.fn()} />
      </ChatSessionProvider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "New" }));

    await waitFor((): void => expect(openNewChat).toHaveBeenCalledOnce());
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
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: makeChat({ status: "closed" }) });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Delete Sprint triage" }));
    await waitFor(() => expect(updateChat).toHaveBeenCalledOnce());
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

  it("selecting and deselecting legacy deleted chats never calls the server", async () => {
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [makeChat({ status: "closed" })] }));
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    const checkbox = screen.getByRole("checkbox", { name: "Select Sprint triage" });
    await user.click(checkbox);
    expect(screen.getByRole("button", { name: "Delete selected (1)" })).toBeEnabled();
    await user.click(checkbox);
    expect(screen.getByRole("button", { name: "Delete selected (0)" })).toBeDisabled();
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it("asks for confirmation naming the chat before purging, and Cancel purges nothing (#4335)", async () => {
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [makeChat({ status: "closed" })] }));
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("button", { name: /^Delete Sprint triage permanently$/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Sprint triage");
    expect(dialog).toHaveTextContent("cannot be undone");
    expect(deleteChat).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteChat).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Delete Sprint triage permanently$/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it("purges only after server success and publishes the existing delete mutation", async () => {
    const purge = deferred<void>();
    vi.mocked(deleteChat).mockReturnValueOnce(purge.promise);
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [makeChat({ status: "closed" })] }));
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("button", { name: /^Delete Sprint triage permanently$/ }));
    await confirmPurge(user);
    expect(deleteChat).toHaveBeenCalledWith("chat-1", "/repo", expect.any(String));
    expect(notifyChatDeleted).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /^Delete Sprint triage permanently$/ }),
    ).toBeDisabled();
    await act(async () => {
      purge.resolve();
      await purge.promise;
    });
    await waitFor(() => expect(notifyChatDeleted).toHaveBeenCalledWith("chat-1"));
  });

  it("keeps a failed purge available for an explicit retry", async () => {
    vi.mocked(deleteChat).mockRejectedValueOnce(new Error("disk busy")).mockResolvedValueOnce();
    const chat = makeChat({ status: "closed" });
    const user = userEvent.setup();
    renderPanel(makeSession({ chats: [chat], activeProject: makeProject("/repo") }));
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("button", { name: /^Delete .* permanently$/i }));
    await confirmPurge(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("disk busy");
    expect(notifyChatDeleted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Delete .* permanently$/i }));
    await confirmPurge(user);
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

  it("moves all checked active chats to Deleted with one action and never purges (#4335)", async (): Promise<void> => {
    const chats = [makeChat(), makeChat({ id: "chat-2", title: "Bug hunt" })];
    vi.mocked(updateChat)
      .mockResolvedValueOnce({ chat: makeChat({ status: "closed" }) })
      .mockResolvedValueOnce({ chat: makeChat({ id: "chat-2", status: "closed" }) });
    const user = userEvent.setup();
    renderPanel(makeSession({ chats }));
    await user.click(screen.getByRole("checkbox", { name: "Select all displayed chats" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByRole("checkbox", { name: "Select Sprint triage" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Bug hunt" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    await waitFor((): void => expect(updateChat).toHaveBeenCalledTimes(2));
    expect(updateChat).toHaveBeenCalledWith("chat-1", { status: "closed" });
    expect(updateChat).toHaveBeenCalledWith("chat-2", { status: "closed" });
    expect(deleteChat).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("purges all checked Deleted chats only after one confirmation with one shared correlation", async (): Promise<void> => {
    vi.mocked(deleteChat).mockResolvedValue(undefined);
    const chats = [
      makeChat({ status: "closed" }),
      makeChat({ id: "chat-2", title: "Bug hunt", status: "closed" }),
    ];
    const user = userEvent.setup();
    renderPanel(makeSession({ chats }));
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("checkbox", { name: "Select all displayed chats" }));
    await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("2 chats");
    expect(deleteChat).not.toHaveBeenCalled();
    await confirmPurge(user);
    await waitFor((): void => expect(notifyChatDeleted).toHaveBeenCalledTimes(2));
    expect(deleteChat).toHaveBeenCalledWith("chat-1", "/repo", expect.any(String));
    expect(deleteChat).toHaveBeenCalledWith(
      "chat-2",
      "/repo",
      vi.mocked(deleteChat).mock.calls[0]?.[2],
    );
    expect(updateChat).not.toHaveBeenCalled();
  });

  it("selects only visible filtered chats and clears selection when the filter changes", async (): Promise<void> => {
    vi.mocked(updateChat).mockResolvedValueOnce({
      chat: makeChat({ id: "chat-2", status: "closed" }),
    });
    const user = userEvent.setup();
    renderPanel(
      makeSession({ chats: [makeChat(), makeChat({ id: "chat-2", title: "Bug hunt" })] }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all displayed chats" }));
    await user.type(screen.getByRole("textbox", { name: "Search chat history" }), "Bug");
    expect(screen.getByRole("button", { name: "Delete selected (0)" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Select all displayed chats" }));
    await user.click(screen.getByRole("button", { name: "Delete selected (1)" }));
    await waitFor((): void => expect(updateChat).toHaveBeenCalledOnce());
    expect(updateChat).toHaveBeenCalledWith("chat-2", { status: "closed" });
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it("keeps only failed moves selected and retries them without repeating successes", async (): Promise<void> => {
    vi.mocked(updateChat)
      .mockResolvedValueOnce({ chat: makeChat({ status: "closed" }) })
      .mockRejectedValueOnce(new Error("disk busy"));
    const user = userEvent.setup();
    renderPanel(
      makeSession({ chats: [makeChat(), makeChat({ id: "chat-2", title: "Bug hunt" })] }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all displayed chats" }));
    await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not move 1 chats to Deleted: disk busy",
    );
    expect(screen.getByRole("checkbox", { name: "Select Sprint triage" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Bug hunt" })).toBeChecked();
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: makeChat({ id: "chat-2" }) });
    await user.click(screen.getByRole("button", { name: "Delete selected (1)" }));
    await waitFor((): void => expect(updateChat).toHaveBeenCalledTimes(3));
    expect(updateChat).toHaveBeenLastCalledWith("chat-2", { status: "closed" });
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it("clears selection across tab and project changes without resurrecting hidden selections", async (): Promise<void> => {
    const user = userEvent.setup();
    const chat = makeChat();
    const view = render(
      <ChatSessionProvider
        value={makeSession({ chats: [chat], activeProject: makeProject("/repo") })}
      >
        <ChatHistoryPanel openChatWindow={vi.fn()} />
      </ChatSessionProvider>,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select Sprint triage" }));
    await user.click(screen.getByRole("tab", { name: /deleted/i }));
    await user.click(screen.getByRole("tab", { name: /active/i }));
    expect(screen.getByRole("checkbox", { name: "Select Sprint triage" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Select Sprint triage" }));
    view.rerender(
      <ChatSessionProvider
        value={makeSession({ chats: [chat], activeProject: makeProject("/other") })}
      >
        <ChatHistoryPanel openChatWindow={vi.fn()} />
      </ChatSessionProvider>,
    );
    view.rerender(
      <ChatSessionProvider
        value={makeSession({ chats: [chat], activeProject: makeProject("/repo") })}
      >
        <ChatHistoryPanel openChatWindow={vi.fn()} />
      </ChatSessionProvider>,
    );
    expect(screen.getByRole("button", { name: "Delete selected (0)" })).toBeDisabled();
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it("limits bulk deletion concurrency and records body-free settlement counts", async (): Promise<void> => {
    const requests = Array.from({ length: 5 }, (): ReturnType<typeof deferred<void>> =>
      deferred<void>(),
    );
    vi.mocked(deleteChat).mockImplementation((_id, _path): Promise<void> => {
      const request = requests[vi.mocked(deleteChat).mock.calls.length - 1];
      if (request === undefined) throw new Error("Unexpected deletion request");
      return request.promise;
    });
    const reports: ClientDiagnosticMeta[] = [];
    setClientDiagnosticWriter((_message, meta): void => {
      if (meta !== undefined) reports.push(meta);
    });
    const chats = Array.from({ length: 5 }, (_, index): Chat =>
      makeChat({ id: `bulk-${String(index)}` }),
    );
    const operation = deleteHistoryChats(chats);
    expect(deleteChat).toHaveBeenCalledTimes(4);
    expect(notifyChatDeleted).not.toHaveBeenCalled();
    for (const request of requests.slice(0, 4)) request.resolve();
    await waitFor((): void => expect(deleteChat).toHaveBeenCalledTimes(5));
    requests[4]?.resolve();
    const result = await operation;
    expect(result.failedIds).toEqual([]);
    expect(notifyChatDeleted).toHaveBeenCalledTimes(5);
    expect(reports.map((meta) => meta.stageReport?.deletion)).toEqual([
      { requestedCount: 5, deletedCount: 0, failedCount: 0 },
      { requestedCount: 5, deletedCount: 5, failedCount: 0 },
    ]);
    expect(reports[0]?.correlationId).toBe(reports[1]?.correlationId);
    expect(JSON.stringify(reports)).not.toMatch(/Sprint triage|\/repo|bulk-0/);
    resetClientDiagnosticWriter();
    vi.mocked(deleteChat).mockReset();
  });

  it("does not repeat requests when Delete is activated again while a batch is pending", async (): Promise<void> => {
    const pending = deferred<{ readonly chat: Chat }>();
    vi.mocked(updateChat).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    renderPanel();
    const button = screen.getByRole("button", { name: "Delete Sprint triage" });
    await user.click(button);
    await user.click(button);
    expect(updateChat).toHaveBeenCalledOnce();
    expect(screen.getByRole("checkbox", { name: "Select all displayed chats" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: /deleted/i })).toBeDisabled();
    await act(async (): Promise<void> => {
      pending.resolve({ chat: makeChat({ status: "closed" }) });
      await pending.promise;
    });
    await waitFor((): void => expect(button).toBeEnabled());
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

  // GEN-UI-FOCUS-016 (test-plan #43): the owner removed inline confirmation. The new
  // pin retains keyboard cancellation before deletion and stable focus after the row disappears.
  it("clears selection on Escape and restores stable focus after keyboard deletion (GEN-UI-FOCUS-016)", async () => {
    vi.mocked(updateChat).mockResolvedValueOnce({ chat: makeChat({ status: "closed" }) });
    const user = userEvent.setup();
    const view = render(
      <ChatSessionProvider value={makeSession()}>
        <ChatHistoryPanel openChatWindow={vi.fn()} />
      </ChatSessionProvider>,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Select Sprint triage" });
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
    await user.keyboard("{Escape}");
    expect(checkbox).not.toBeChecked();
    expect(updateChat).not.toHaveBeenCalled();
    const deleteButton = screen.getByRole("button", { name: "Delete Sprint triage" });
    deleteButton.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(updateChat).toHaveBeenCalledWith("chat-1", { status: "closed" }));
    expect(screen.getByRole("checkbox", { name: "Select all displayed chats" })).toHaveFocus();
    view.rerender(
      <ChatSessionProvider value={makeSession({ chats: [] })}>
        <ChatHistoryPanel openChatWindow={vi.fn()} />
      </ChatSessionProvider>,
    );
    expect(screen.getByRole("textbox", { name: "Search chat history" })).toHaveFocus();
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
    const deleteButtons = screen
      .getAllByRole("article")
      .flatMap((row) => within(row).getAllByRole("button", { name: /^Delete\b/ }));
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
// permanent-deletion path. Locale set to German
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
// two-phase transition). The panel's optional catalog loads separately, so each test also waits
// for the actual localized control before interacting; the document language alone is insufficient.
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
    vi.mocked(updateChat).mockReset();
    vi.mocked(deleteChat).mockReset();
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
    const renameButton = await screen.findByRole("button", { name: /umbenennen/i });
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

    await user.click(await screen.findByRole("button", { name: /umbenennen/i }));
    const renameInput = screen.getByDisplayValue("Sprint triage");
    await user.clear(renameInput);
    await user.type(renameInput, "New title");
    await user.click(screen.getByRole("button", { name: /speichern/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Umbenennen fehlgeschlagen.");
    expect(alert).not.toHaveTextContent("Rename failed.");
  });

  it("shows the German move-failed error with the caught detail, not the English literal", async () => {
    vi.mocked(updateChat).mockRejectedValueOnce(new Error("disk busy"));
    const user = userEvent.setup();
    renderGermanPanel();
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));

    await user.click(await screen.findByRole("button", { name: "Sprint triage löschen" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "1 Chats konnten nicht nach Gelöscht verschoben werden: disk busy",
    );
    expect(alert).not.toHaveTextContent("Could not move");
  });

  it("shows the German restore-failed error with the caught detail, not the English literal", async () => {
    vi.mocked(updateChat).mockRejectedValueOnce(new Error("disk busy"));
    const user = userEvent.setup();
    renderGermanPanel(makeSession({ chats: [makeChat({ status: "closed" })] }));
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));

    // #2906 round 3: the "Active"/"Deleted" tab labels now route through t("chat.history.tab.*"),
    // so their accessible name (there is no separate aria-label — the visible text IS the name) is
    // German too. Assert both the query match and the visible text explicitly.
    const deletedTab = await screen.findByRole("tab", { name: /gelöscht/i });
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
