// Issue #185 AC3 — tests for the grounded-request cancel button in ChatWindow.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapsuleSetId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { ChatWindow, clearKnowledgeCatalogCacheForTests, copyableMessageText } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat, ChatMessage, GroundedAnswer, ModelCapability } from "@/lib/types";
import { fetchFilesSearch, updateChat } from "@/lib/api";
import { fetchCapsules, fetchCapsuleSets } from "@/lib/local-knowledge-api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchFilesSearch: vi.fn(),
    updateChat: vi.fn(),
  };
});

vi.mock("@/lib/local-knowledge-api", () => ({
  fetchCapsules: vi.fn(async () => ({ capsules: [] })),
  fetchCapsuleSets: vi.fn(async () => ({ capsuleSets: [] })),
}));

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

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    chatId: "chat-1",
    role: "user",
    content: "",
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSessionApi> = {}): ChatSessionApi {
  return {
    projects: [],
    chats: [],
    messages: [],
    models: [],
    activeProject: undefined,
    activeChat: undefined,
    selectedModel: "example-chat-model",
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
    // Issue #147 — attachment fields
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
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
    ...overrides,
  };
}

function renderWindow(
  session: ChatSessionApi,
  props: {
    readonly linkedRoot?: string | null | undefined;
    readonly linkedRoots?: readonly string[] | undefined;
    readonly openEditorFile?: ComponentProps<typeof ChatWindow>["openEditorFile"];
    readonly onOpenRunResult?: ((message: ChatMessage) => void) | undefined;
  } = {},
): void {
  const chatWindowProps: ComponentProps<typeof ChatWindow> = {
    ...(props.linkedRoot === undefined ? {} : { linkedRoot: props.linkedRoot }),
    ...(props.linkedRoots === undefined ? {} : { linkedRoots: props.linkedRoots }),
    ...(props.openEditorFile === undefined ? {} : { openEditorFile: props.openEditorFile }),
    ...(props.onOpenRunResult === undefined ? {} : { onOpenRunResult: props.onOpenRunResult }),
  };
  render(
    <ChatSessionProvider value={session}>
      <ChatWindow {...chatWindowProps} />
    </ChatSessionProvider>,
  );
}

function renderStatefulWindow(
  session: ChatSessionApi,
  props: { readonly onOpenRunResult?: ((message: ChatMessage) => void) | undefined } = {},
): void {
  function StatefulWindow(): React.JSX.Element {
    const [draft, setDraftState] = useState(session.draft);
    return (
      <ChatSessionProvider
        value={{
          ...session,
          draft,
          setDraft: (next) => {
            session.setDraft(next);
            setDraftState(next);
          },
        }}
      >
        <ChatWindow onOpenRunResult={props.onOpenRunResult} />
      </ChatSessionProvider>
    );
  }

  render(<StatefulWindow />);
}

const fetchCapsulesMock = vi.mocked(fetchCapsules);
const fetchCapsuleSetsMock = vi.mocked(fetchCapsuleSets);
const fetchFilesSearchMock = vi.mocked(fetchFilesSearch);
const updateChatMock = vi.mocked(updateChat);

beforeEach(() => {
  clearKnowledgeCatalogCacheForTests();
  fetchCapsulesMock.mockReset();
  fetchCapsulesMock.mockResolvedValue({ capsules: [] });
  fetchCapsuleSetsMock.mockReset();
  fetchCapsuleSetsMock.mockResolvedValue({ capsuleSets: [] });
  fetchFilesSearchMock.mockReset();
  fetchFilesSearchMock.mockResolvedValue({
    root: "/repo",
    query: "",
    results: [],
    truncated: false,
    scannedFileCount: 0,
  });
  updateChatMock.mockReset();
});

function makeCapsuleId(value: string): KnowledgeCapsuleId {
  return value as KnowledgeCapsuleId;
}

function makeCapsuleSetId(value: string): CapsuleSetId {
  return value as CapsuleSetId;
}

async function openCombobox(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(await screen.findByRole("combobox", { name }));
}

async function chooseComboboxOption(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string | RegExp,
): Promise<void> {
  await openCombobox(user, name);
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("ChatWindow cancel button", () => {
  it("keeps connected resource details out of the chat header", () => {
    const chat = makeChat({
      connectedScopes: [{ kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 }],
    });
    const { container } = render(
      <ChatSessionProvider value={makeSession({ activeChat: chat })}>
        <ChatWindow linkedRoot="/proj" />
      </ChatSessionProvider>,
    );

    expect(screen.getByRole("combobox", { name: "Grounding mode" })).toHaveTextContent(
      "Live Files context",
    );
    expect(container.querySelector(".scope-grounding")).toHaveAttribute("data-connected", "true");
    expect(container.querySelector(".scope-pill")).toBeNull();
    expect(container.querySelector(".chat-ctx")).toBeNull();
  });

  it("does not render the cancel button when not sending", () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    renderWindow(makeSession({ activeChat: chat, sending: false }));
    expect(screen.queryByRole("button", { name: "Cancel grounded request" })).toBeNull();
  });

  it("does not render the cancel button when sending but no connectedScope", () => {
    const chat = makeChat({ connectedScope: undefined });
    renderWindow(makeSession({ activeChat: chat, sending: true }));
    expect(screen.queryByRole("button", { name: "Cancel grounded request" })).toBeNull();
  });

  it("renders the cancel button while sending with a connectedScope", () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    // Provide at least one visible message so the chatw-log branch is rendered
    renderWindow(
      makeSession({
        activeChat: chat,
        sending: true,
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "hello",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );
    expect(screen.getByRole("button", { name: "Cancel grounded request" })).toBeInTheDocument();
  });

  it("renders the cancel button while sending with plural-only connectedScopes", () => {
    const chat = makeChat({
      connectedScopes: [{ kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 }],
    });
    renderWindow(
      makeSession({
        activeChat: chat,
        sending: true,
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "hello",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );
    expect(screen.getByRole("button", { name: "Cancel grounded request" })).toBeInTheDocument();
  });

  it("passes run-summary result clicks to the workspace opener", async () => {
    const user = userEvent.setup();
    const openResult = vi.fn();
    const runMessage: ChatMessage = {
      id: "run-msg",
      chatId: "chat-1",
      role: "system",
      content: "Launched: Generate unit tests",
      timestamp: 1,
      runId: "run-abc",
      workflowId: "unit-test-generation",
      workflowStatus: "completed",
      shortResult: "Generated 1 test files; 3 tests proposed.",
      taskType: undefined,
    };
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [runMessage],
      }),
      { onOpenRunResult: openResult },
    );

    await user.click(screen.getByRole("button", { name: /open result/i }));

    expect(openResult).toHaveBeenCalledWith(runMessage);
  });

  it("renders persisted grounded evidence from the assistant message for a plural-only connectedScopes chat", () => {
    const chat = makeChat({
      connectedScopes: [{ kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 }],
    });
    const latestGrounded: GroundedAnswer = {
      groundingKind: "connected-context",
      userMessageId: "u",
      assistantMessageId: "a",
      content: "grounded",
      citations: [
        {
          scopePath: "src/a.ts",
          lineRange: { startLine: 1, endLine: 2 },
          score: 0.9,
          stableId: "atom-1",
        },
      ],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 5,
      contextPack: {
        schemaVersion: "1",
        scopeId: "cs-plural",
        scopeKind: "files",
        fileCount: 1,
        queryKind: "natural-language",
        usage: {
          searchCalls: 1,
          filesRead: 1,
          excerptBytes: 64,
          modelInputTokens: 10,
          modelOutputTokens: 5,
          elapsedMs: 5,
          rerankCalls: 0,
        },
        budget: {
          searchCallsMax: 16,
          filesReadMax: 32,
          excerptBytesMax: 131_072,
          modelInputTokensMax: 32_000,
          modelOutputTokensMax: 4_096,
          elapsedMsMax: 30_000,
          rerankCallsMax: 0,
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
          "unsupported-format": 0,
          "no-text-layer": 0,
          "malformed-document": 0,
          "encrypted-document": 0,
        },
        uncertaintyCount: 0,
        elapsedMs: 5,
      },
    };
    renderWindow(
      makeSession({
        activeChat: chat,
        messages: [
          {
            id: "a",
            chatId: "chat-1",
            role: "assistant",
            content: "grounded",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
            groundedAnswer: latestGrounded,
          },
        ],
      }),
    );
    expect(screen.getByText("src/a.ts:1-2")).toBeInTheDocument();
    expect(screen.getByText("Scope: 1 file in files (s-plural)")).toBeInTheDocument();
  });

  it("calls cancelGrounded when the cancel button is clicked", async () => {
    const cancelGrounded = vi.fn();
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: chat,
        sending: true,
        cancelGrounded,
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "hello",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel grounded request" }));
    expect(cancelGrounded).toHaveBeenCalledOnce();
  });
});

describe("ChatWindow memory disclosure", () => {
  it("exposes expanded state and disclosure linkage on the memory brain button", async () => {
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        draft: "hello",
        latestMemory: {
          context: {
            enabled: true,
            text: "Included memory context:\n- Use pnpm",
            memories: [
              {
                memoryId: "mem-1",
                bodyExcerpt: "Use pnpm",
                inclusionReason: "scope-match",
                sourceKind: "explicit-user-instruction",
                captureRationale: "user asked Keiko to remember this",
                sensitivity: "public",
                confidence: 1,
                status: "accepted",
                capturedAt: 1_700_000_000_000,
              },
            ],
            budget: { tokens: 1200, used: 42 },
          },
          actions: [],
        },
      }),
    );

    const disclosureButton = screen.getByRole("button", { name: /1 memories included/i });
    expect(disclosureButton).toHaveClass("chat-memory-disclosure-toggle");
    expect(document.querySelector(".chat-scope-header")).toContainElement(disclosureButton);
    expect(document.querySelector(".chat-memory-panel-head")).toBeNull();
    expect(disclosureButton).toHaveAttribute("data-empty", "false");
    expect(disclosureButton.querySelector(".chat-memory-count")).toHaveTextContent("1");
    expect(disclosureButton).toHaveAttribute("aria-expanded", "false");
    expect(disclosureButton.getAttribute("aria-controls")).toContain("chat-memory-disclosure");
    await user.click(disclosureButton);
    expect(disclosureButton).toHaveAttribute("aria-expanded", "true");
    const disclosureId = disclosureButton.getAttribute("aria-controls");
    expect(disclosureId).toBeTruthy();
    expect(document.getElementById(disclosureId ?? "")).toBeInTheDocument();
    expect(screen.getByText("Use pnpm")).toBeInTheDocument();
    expect(screen.getByText("explicit-user-instruction")).toBeInTheDocument();
    expect(screen.getByText("user asked Keiko to remember this")).toBeInTheDocument();
    expect(screen.getByText(/Used 42 of 1200 MemoriaViva tokens/i)).toBeInTheDocument();
  });

  it("renders the memory brain as visually disabled when no memories were included", () => {
    renderWindow(makeSession({ activeChat: makeChat() }));

    const disclosureButton = screen.getByRole("button", { name: /no memories included/i });
    expect(disclosureButton).toHaveAttribute("data-empty", "true");
    expect(document.querySelector(".chat-scope-header")).toContainElement(disclosureButton);
    expect(disclosureButton.querySelector(".chat-memory-count")).toBeNull();
    expect(disclosureButton.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("No memories included")).toBeNull();
  });

  it("uses unique disclosure ids for multiple chat windows", () => {
    render(
      <>
        <ChatSessionProvider value={makeSession({ activeChat: makeChat({ id: "chat-a" }) })}>
          <ChatWindow />
        </ChatSessionProvider>
        <ChatSessionProvider value={makeSession({ activeChat: makeChat({ id: "chat-b" }) })}>
          <ChatWindow />
        </ChatSessionProvider>
      </>,
    );

    const controls = screen
      .getAllByRole("button", { name: /no memories included/i })
      .map((button) => button.getAttribute("aria-controls"));
    expect(new Set(controls).size).toBe(2);
  });
});

describe("ChatWindow repository file focus picker", () => {
  it("searches connected repository roots and merges the selected file into the Files scope", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    const setDraft = vi.fn();
    const existingScope = {
      kind: "files" as const,
      root: "/repo",
      relativePaths: ["src/a.ts"],
      connectedAtMs: 1,
    };
    const updated = makeChat({
      projectPath: "/repo",
      connectedScopes: [
        { ...existingScope, relativePaths: ["src/a.ts", "src/context/coding-context.ts"] },
      ],
    });
    fetchFilesSearchMock.mockResolvedValue({
      root: "/repo",
      query: "coding",
      results: [
        {
          root: "/repo",
          path: "src/context/coding-context.ts",
          name: "coding-context.ts",
          directory: "src/context",
          extension: "ts",
          sizeBytes: 42,
          modifiedAt: 123,
          fileRole: "source",
          matchQuality: "exact",
          rootKind: "nested-git-root",
        },
        {
          root: "/repo",
          path: "dist/coding-context.js",
          name: "coding-context.js",
          directory: "dist",
          extension: "js",
          sizeBytes: 84,
          modifiedAt: 456,
          fileRole: "generated",
          matchQuality: "strong",
          rootKind: "selected-root",
        },
      ],
      truncated: false,
      scannedFileCount: 10,
    });
    updateChatMock.mockResolvedValueOnce({ chat: updated });

    renderStatefulWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/repo",
          connectedScopes: [existingScope],
          connectedScope: existingScope,
        }),
        draft: "",
        replaceChat,
        setDraft,
      }),
    );

    const input = screen.getByRole("textbox", { name: "Chat message" });
    await user.type(input, "Explain this @coding");

    const result = await screen.findByRole("option", {
      name: "Reference src/context/coding-context.ts",
    });
    expect(result).toHaveTextContent("Source");
    expect(result).toHaveTextContent("Nested repo");
    const generatedResult = screen.getByRole("option", {
      name: "Reference dist/coding-context.js",
    });
    expect(generatedResult).toHaveTextContent("Generated");
    expect(generatedResult).toHaveClass("repo-focus-result-secondary");
    await user.click(result);

    await waitFor(() => {
      expect(fetchFilesSearchMock).toHaveBeenCalledWith(
        "/repo",
        "coding",
        24,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(updateChatMock).toHaveBeenCalledWith("chat-1", {
        connectedScopes: [
          expect.objectContaining({
            kind: "files",
            root: "/repo",
            relativePaths: ["src/a.ts", "src/context/coding-context.ts"],
          }),
        ],
      });
    });
    expect(replaceChat).toHaveBeenCalledWith(updated);
    expect(setDraft).toHaveBeenCalledWith("Explain this @src/context/coding-context.ts ");
    expect(screen.getByRole("list", { name: "Referenced repository files" })).toHaveTextContent(
      "coding-context.ts",
    );
    expect(
      screen.getByRole("button", {
        name: "Remove repository reference src/context/coding-context.ts",
      }),
    ).toBeInTheDocument();
  });

  it("debounces repository searches and aborts stale in-flight requests", async () => {
    const signals: AbortSignal[] = [];
    fetchFilesSearchMock.mockImplementation((_root, query, _limit, init) => {
      if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);
      if (query === "ra") {
        return new Promise<never>(() => undefined);
      }
      return Promise.resolve({
        root: "/repo",
        query,
        results: [
          {
            root: "/repo",
            path: "src/range.ts",
            name: "range.ts",
            directory: "src",
            extension: "ts",
            sizeBytes: 42,
            modifiedAt: 123,
            fileRole: "source",
            matchQuality: "exact",
            rootKind: "selected-root",
          },
        ],
        truncated: false,
        scannedFileCount: 10,
      });
    });

    renderStatefulWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/repo",
          connectedScopes: [
            {
              kind: "workspace-root",
              root: "/repo",
              relativePaths: [],
              connectedAtMs: 1,
            },
          ],
        }),
        draft: "",
      }),
    );

    const input = screen.getByRole("textbox", { name: "Chat message" });
    fireEvent.change(input, {
      target: { value: "@ra", selectionStart: "@ra".length },
    });

    await waitFor(() => {
      expect(fetchFilesSearchMock).toHaveBeenCalledWith(
        "/repo",
        "ra",
        24,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(signals[0]?.aborted).toBe(false);

    fireEvent.change(input, {
      target: { value: "@range", selectionStart: "@range".length },
    });

    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await screen.findByRole("option", { name: "Reference src/range.ts" });
    expect(fetchFilesSearchMock).toHaveBeenCalledWith(
      "/repo",
      "range",
      24,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("removes typed repository references from the chip strip and draft", async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    const existingScope = {
      kind: "files" as const,
      root: "/repo",
      relativePaths: ["src/context/coding-context.ts"],
      connectedAtMs: 1,
    };
    fetchFilesSearchMock.mockResolvedValue({
      root: "/repo",
      query: "coding",
      results: [
        {
          root: "/repo",
          path: "src/context/coding-context.ts",
          name: "coding-context.ts",
          directory: "src/context",
          extension: "ts",
          sizeBytes: 42,
          modifiedAt: 123,
        },
      ],
      truncated: false,
      scannedFileCount: 10,
    });

    renderStatefulWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/repo",
          connectedScopes: [existingScope],
          connectedScope: existingScope,
        }),
        draft: "",
        setDraft,
      }),
    );

    const input = screen.getByRole("textbox", { name: "Chat message" });
    await user.type(input, "Explain this @coding");
    await user.click(
      await screen.findByRole("option", {
        name: "Reference src/context/coding-context.ts",
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Remove repository reference src/context/coding-context.ts",
      }),
    );

    expect(screen.queryByRole("list", { name: "Referenced repository files" })).toBeNull();
    expect(setDraft).toHaveBeenLastCalledWith("Explain this ");
  });

  it("clears the draft when removing the only typed repository reference", async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    const existingScope = {
      kind: "files" as const,
      root: "/repo",
      relativePaths: ["src/range.ts"],
      connectedAtMs: 1,
    };
    fetchFilesSearchMock.mockResolvedValue({
      root: "/repo",
      query: "range",
      results: [
        {
          root: "/repo",
          path: "src/range.ts",
          name: "range.ts",
          directory: "src",
          extension: "ts",
          sizeBytes: 42,
          modifiedAt: 123,
        },
      ],
      truncated: false,
      scannedFileCount: 10,
    });

    renderStatefulWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/repo",
          connectedScopes: [existingScope],
          connectedScope: existingScope,
        }),
        draft: "",
        setDraft,
      }),
    );

    const input = screen.getByRole("textbox", { name: "Chat message" });
    await user.type(input, "@range");
    await user.click(
      await screen.findByRole("option", {
        name: "Reference src/range.ts",
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Remove repository reference src/range.ts",
      }),
    );

    expect(screen.queryByRole("list", { name: "Referenced repository files" })).toBeNull();
    expect(setDraft).toHaveBeenLastCalledWith("");
  });

  it("reconstructs unverified repository chips from an existing draft", async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    renderStatefulWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/repo",
          connectedScopes: [
            {
              kind: "workspace-root",
              root: "/repo",
              relativePaths: [],
              connectedAtMs: 1,
            },
          ],
        }),
        draft: "Explain @packages/keiko-editor/src/range.ts",
        setDraft,
      }),
    );

    const list = await screen.findByRole("list", { name: "Referenced repository files" });
    expect(list).toHaveTextContent("range.ts");
    expect(list).toHaveTextContent("Unverified");
    expect(list).toHaveAccessibleName("Referenced repository files");

    await user.click(
      screen.getByRole("button", {
        name: "Remove repository reference packages/keiko-editor/src/range.ts",
      }),
    );

    expect(screen.queryByRole("list", { name: "Referenced repository files" })).toBeNull();
    expect(setDraft).toHaveBeenLastCalledWith("Explain ");
  });

  it("creates a focused Files scope when only the repository root is connected", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    const rootScope = {
      kind: "workspace-root" as const,
      root: "/repo",
      relativePaths: [],
      connectedAtMs: 1,
    };
    fetchFilesSearchMock.mockResolvedValue({
      root: "/repo",
      query: "readme",
      results: [
        {
          root: "/repo",
          path: "README.md",
          name: "README.md",
          directory: "",
          extension: "md",
          sizeBytes: 12,
          modifiedAt: 456,
        },
      ],
      truncated: false,
      scannedFileCount: 5,
    });
    updateChatMock.mockResolvedValueOnce({ chat: makeChat() });

    renderStatefulWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/repo",
          connectedScopes: [rootScope],
          connectedScope: rootScope,
        }),
        draft: "",
        replaceChat,
      }),
    );

    const input = screen.getByRole("textbox", { name: "Chat message" });
    await user.type(input, "@readme");
    await user.click(await screen.findByRole("option", { name: "Reference README.md" }));

    await waitFor(() => {
      expect(updateChatMock).toHaveBeenCalledWith("chat-1", {
        connectedScopes: [
          rootScope,
          expect.objectContaining({
            kind: "files",
            root: "/repo",
            relativePaths: ["README.md"],
          }),
        ],
      });
    });
  });

  it("does not open repository search for connector-only grounding", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat({
          localKnowledgeScopes: [
            { kind: "capsule", capsuleId: makeCapsuleId("cap-only"), connectedAtMs: 1 },
          ],
        }),
        draft: "@readme",
      }),
    );

    const input = screen.getByRole("textbox", { name: "Chat message" });
    fireEvent.change(input, {
      target: { value: "@readme", selectionStart: "@readme".length },
    });

    expect(screen.queryByRole("dialog", { name: "Reference repository file" })).toBeNull();
    expect(fetchFilesSearchMock).not.toHaveBeenCalled();
  });
});

describe("ChatWindow local knowledge scope disclosure", () => {
  it("shares the capsule catalog request across mounted chat windows", async () => {
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [
        {
          id: makeCapsuleId("cap-shared"),
          displayName: "Shared capsule",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
    });
    fetchCapsuleSetsMock.mockResolvedValueOnce({ capsuleSets: [] });
    const session = makeSession({ activeChat: makeChat() });

    render(
      <>
        <ChatSessionProvider value={session}>
          <ChatWindow />
        </ChatSessionProvider>
        <ChatSessionProvider value={{ ...session, activeChat: makeChat({ id: "chat-2" }) }}>
          <ChatWindow />
        </ChatSessionProvider>
      </>,
    );

    await waitFor(() => expect(fetchCapsulesMock).toHaveBeenCalledTimes(1));
    expect(fetchCapsuleSetsMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("combobox", { name: "Grounding mode" })).toHaveLength(2);
  });

  it("switches from Files grounding to a ready knowledge capsule and clears file scopes", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [
        {
          id: makeCapsuleId("cap-release"),
          displayName: "Release notes",
          lifecycleState: "ready",
          sourceCount: 6,
          updatedAt: 1,
        },
        {
          id: makeCapsuleId("cap-indexing"),
          displayName: "Still indexing",
          lifecycleState: "indexing",
          sourceCount: 2,
          updatedAt: 2,
        },
      ],
    });
    fetchCapsuleSetsMock.mockResolvedValueOnce({ capsuleSets: [] });
    const updated = makeChat({
      localKnowledgeScopes: [
        { kind: "capsule", capsuleId: makeCapsuleId("cap-release"), connectedAtMs: 123 },
      ],
    });
    updateChatMock.mockResolvedValueOnce({ chat: updated });
    renderWindow(
      makeSession({
        activeChat: makeChat({
          connectedScopes: [
            { kind: "directory", root: "/repo", relativePaths: ["docs"], connectedAtMs: 1 },
          ],
        }),
        replaceChat,
      }),
    );

    await openCombobox(user, "Grounding mode");
    expect(screen.getByRole("option", { name: "Live Files context" })).not.toBeDisabled();
    expect(screen.queryByRole("option", { name: /Still indexing/i })).toBeNull();

    await user.click(screen.getByRole("option", { name: "Knowledge capsule: Release notes" }));

    await waitFor(() => {
      // GRD-009: connecting a connector must NOT clear connected folders (no connectedScopes
      // key in the PATCH) and appends to the connector list — hybrid grounding is supported.
      expect(updateChatMock).toHaveBeenCalledWith("chat-1", {
        localKnowledgeScopes: [
          expect.objectContaining({ kind: "capsule", capsuleId: "cap-release" }),
        ],
      });
    });
    expect(updateChatMock.mock.calls[0]?.[1]).not.toHaveProperty("connectedScopes");
    expect(replaceChat).toHaveBeenCalledWith(updated);
  });

  it("appends a second connector and preserves connected folders + existing connector (GRD-009 hybrid)", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [
        {
          id: makeCapsuleId("cap-a"),
          displayName: "Alpha",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
        {
          id: makeCapsuleId("cap-b"),
          displayName: "Bravo",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
    });
    fetchCapsuleSetsMock.mockResolvedValueOnce({ capsuleSets: [] });
    updateChatMock.mockResolvedValueOnce({ chat: makeChat({}) });
    renderWindow(
      makeSession({
        activeChat: makeChat({
          connectedScopes: [
            { kind: "directory", root: "/repo", relativePaths: ["docs"], connectedAtMs: 1 },
          ],
          localKnowledgeScopes: [
            { kind: "capsule", capsuleId: makeCapsuleId("cap-a"), connectedAtMs: 2 },
          ],
        }),
        replaceChat,
      }),
    );

    await chooseComboboxOption(user, "Grounding mode", "Knowledge capsule: Bravo");

    await waitFor(() => {
      const arg = updateChatMock.mock.calls[0]?.[1] as {
        readonly localKnowledgeScopes?: readonly { readonly capsuleId?: string }[];
      };
      // Connected folders preserved (not cleared) — hybrid grounding holds.
      expect(updateChatMock.mock.calls[0]?.[1]).not.toHaveProperty("connectedScopes");
      // Appended, not replaced: both the pre-existing cap-a and the newly picked cap-b survive.
      expect(arg.localKnowledgeScopes).toEqual([
        expect.objectContaining({ kind: "capsule", capsuleId: "cap-a" }),
        expect.objectContaining({ kind: "capsule", capsuleId: "cap-b" }),
      ]);
    });
  });

  it("re-selecting an already-connected capsule does not duplicate it (GRD-009 dedupe)", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [
        {
          id: makeCapsuleId("cap-a"),
          displayName: "Alpha",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
        {
          id: makeCapsuleId("cap-b"),
          displayName: "Bravo",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
    });
    fetchCapsuleSetsMock.mockResolvedValueOnce({ capsuleSets: [] });
    updateChatMock.mockResolvedValueOnce({ chat: makeChat({}) });
    // Both already connected; the picker shows cap-a, so selecting cap-b is a real change event
    // that hits the dedupe branch (cap-b already present -> no duplicate, list unchanged).
    renderWindow(
      makeSession({
        activeChat: makeChat({
          localKnowledgeScopes: [
            { kind: "capsule", capsuleId: makeCapsuleId("cap-a"), connectedAtMs: 1 },
            { kind: "capsule", capsuleId: makeCapsuleId("cap-b"), connectedAtMs: 2 },
          ],
        }),
        replaceChat,
      }),
    );
    await chooseComboboxOption(user, "Grounding mode", "Knowledge capsule: Bravo");
    await waitFor(() => {
      const arg = updateChatMock.mock.calls[0]?.[1] as {
        readonly localKnowledgeScopes?: readonly { readonly capsuleId?: string }[];
      };
      expect(arg.localKnowledgeScopes).toEqual([
        expect.objectContaining({ kind: "capsule", capsuleId: "cap-a" }),
        expect.objectContaining({ kind: "capsule", capsuleId: "cap-b" }),
      ]);
    });
  });

  it("appends to a legacy single localKnowledgeScope chat (GRD-009 legacy normalisation)", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [
        {
          id: makeCapsuleId("cap-a"),
          displayName: "Alpha",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
        {
          id: makeCapsuleId("cap-b"),
          displayName: "Bravo",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
    });
    fetchCapsuleSetsMock.mockResolvedValueOnce({ capsuleSets: [] });
    updateChatMock.mockResolvedValueOnce({ chat: makeChat({}) });
    // Legacy singular field only (no plural list) — currentConnectorScopes must normalise it.
    renderWindow(
      makeSession({
        activeChat: makeChat({
          localKnowledgeScope: {
            kind: "capsule",
            capsuleId: makeCapsuleId("cap-a"),
            connectedAtMs: 1,
          },
        }),
        replaceChat,
      }),
    );
    await chooseComboboxOption(user, "Grounding mode", "Knowledge capsule: Bravo");
    await waitFor(() => {
      const arg = updateChatMock.mock.calls[0]?.[1] as {
        readonly localKnowledgeScopes?: readonly { readonly capsuleId?: string }[];
      };
      expect(arg.localKnowledgeScopes).toEqual([
        expect.objectContaining({ kind: "capsule", capsuleId: "cap-a" }),
        expect.objectContaining({ kind: "capsule", capsuleId: "cap-b" }),
      ]);
    });
  });

  it("switches to a capsule set and disables Files mode when no folder scope exists", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    fetchCapsulesMock.mockResolvedValueOnce({ capsules: [] });
    fetchCapsuleSetsMock.mockResolvedValueOnce({
      capsuleSets: [
        {
          id: makeCapsuleSetId("set-release"),
          displayName: "Release pack",
          capsuleCount: 4,
          composedAt: 2,
        },
      ],
    });
    const updated = makeChat({
      localKnowledgeScopes: [
        { kind: "capsule-set", capsuleSetId: makeCapsuleSetId("set-release"), connectedAtMs: 456 },
      ],
    });
    updateChatMock.mockResolvedValueOnce({ chat: updated });
    renderWindow(makeSession({ activeChat: makeChat(), replaceChat }));

    await openCombobox(user, "Grounding mode");
    expect(screen.getByRole("option", { name: "Live Files context" })).toBeDisabled();

    await user.click(screen.getByRole("option", { name: "Capsule set: Release pack" }));

    await waitFor(() => {
      // GRD-009: non-destructive — no connectedScopes clear; appends the capsule set.
      expect(updateChatMock).toHaveBeenCalledWith("chat-1", {
        localKnowledgeScopes: [
          expect.objectContaining({ kind: "capsule-set", capsuleSetId: "set-release" }),
        ],
      });
    });
    expect(updateChatMock.mock.calls[0]?.[1]).not.toHaveProperty("connectedScopes");
    expect(replaceChat).toHaveBeenCalledWith(updated);
  });

  it("clears mixed folder and knowledge grounding when Model only is selected", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    // #2 — selecting "none" with active scopes triggers window.confirm; auto-confirm here.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const updated = makeChat();
    updateChatMock.mockResolvedValueOnce({ chat: updated });
    renderWindow(
      makeSession({
        activeChat: makeChat({
          connectedScopes: [
            { kind: "workspace-root", root: "/repo", relativePaths: [], connectedAtMs: 1 },
          ],
          localKnowledgeScopes: [
            { kind: "capsule", capsuleId: makeCapsuleId("cap-release"), connectedAtMs: 2 },
          ],
        }),
        replaceChat,
      }),
    );

    await chooseComboboxOption(user, "Grounding mode", "Model only");

    await waitFor(() => {
      expect(updateChatMock).toHaveBeenCalledWith("chat-1", {
        connectedScopes: null,
        localKnowledgeScopes: null,
      });
    });
    expect(replaceChat).toHaveBeenCalledWith(updated);
    confirmSpy.mockRestore();
  });

  it("surfaces scope update failures without changing the active chat cache", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [
        {
          id: makeCapsuleId("cap-release"),
          displayName: "Release notes",
          lifecycleState: "ready",
          sourceCount: 6,
          updatedAt: 1,
        },
      ],
    });
    fetchCapsuleSetsMock.mockResolvedValueOnce({ capsuleSets: [] });
    updateChatMock.mockRejectedValueOnce(new Error("knowledge store unavailable"));
    renderWindow(makeSession({ activeChat: makeChat(), replaceChat }));

    await chooseComboboxOption(user, "Grounding mode", "Knowledge capsule: Release notes");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("knowledge store unavailable");
    });
    expect(replaceChat).not.toHaveBeenCalled();
  });

  it("keeps the active capsule visible when it is no longer in the ready capsule list", async () => {
    fetchCapsulesMock.mockResolvedValueOnce({ capsules: [] });
    fetchCapsuleSetsMock.mockResolvedValueOnce({ capsuleSets: [] });
    renderWindow(
      makeSession({
        activeChat: makeChat({
          localKnowledgeScope: {
            kind: "capsule",
            capsuleId: makeCapsuleId("cap-stale"),
            connectedAtMs: 1,
          },
        }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Grounding mode" })).toHaveTextContent(
        "Knowledge capsule: cap-stale (unavailable)",
      );
    });
    // uiux-fix F041 (C173) — "(unavailable)" is the single degraded suffix
    // (previously "(not ready)" for capsules vs "(unavailable)" for sets).
    await openCombobox(userEvent.setup(), "Grounding mode");
    expect(
      screen.getByRole("option", { name: "Knowledge capsule: cap-stale (unavailable)" }),
    ).toBeInTheDocument();
  });

  it("keeps the active capsule set visible and reports the load error when capsule sets fail to load", async () => {
    fetchCapsulesMock.mockResolvedValueOnce({ capsules: [] });
    fetchCapsuleSetsMock.mockRejectedValueOnce(new Error("capsule sets offline"));
    renderWindow(
      makeSession({
        activeChat: makeChat({
          localKnowledgeScope: {
            kind: "capsule-set",
            capsuleSetId: makeCapsuleSetId("set-1"),
            connectedAtMs: 1,
          },
        }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Grounding mode" })).toHaveTextContent(
        "Capsule set: set-1 (unavailable)",
      );
    });
    await openCombobox(userEvent.setup(), "Grounding mode");
    expect(
      screen.getByRole("option", { name: "Capsule set: set-1 (unavailable)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("capsule sets offline");
  });
});

// Issue #144 / Epic #142 AC #1 + #2: the conversation dropdown must only
// surface chat-eligible models. ChatWindow trusts `session.models` to arrive
// already filtered by `useChatSession.bootstrapSession` (which routes through
// `isConversationEligibleModel`). These tests pin the realistic production
// flow: when only chat-eligible models are provided, only chat options appear
// in the dropdown.
function chatModelCapability(id: string): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["Chat"],
    knownLimitations: ["test fixture"],
  };
}

describe("ChatWindow conversation model dropdown (Issue #144)", () => {
  it("renders every chat-eligible model id in the Model dropdown options", async () => {
    const user = userEvent.setup();
    // activeChat is required so the composer bar (containing the model select)
    // is rendered — without it the new NoChatState shows instead (#146).
    renderWindow(
      makeSession({
        models: [chatModelCapability("test-chat-1"), chatModelCapability("test-chat-2")],
        selectedModel: "test-chat-1",
        activeChat: makeChat(),
      }),
    );
    await openCombobox(user, "Models");
    expect(screen.getByRole("option", { name: "test-chat-1" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "test-chat-2" })).toBeInTheDocument();
  });

  it("does not render a non-chat model id in the dropdown when session.models is pre-filtered (AC #2)", async () => {
    const user = userEvent.setup();
    // UI rendering path only: ChatWindow renders whatever session.models
    // contains and never re-filters it. The bootstrap-level filter that keeps
    // embedding / ocr-vision models out of session.models is separately
    // pinned in Streaming.test.tsx ("useChatSession bootstrap eligibility
    // filter"). activeChat is required so the composer bar is rendered (#146).
    renderWindow(
      makeSession({
        models: [chatModelCapability("test-chat-1")],
        selectedModel: "test-chat-1",
        activeChat: makeChat(),
      }),
    );
    await openCombobox(user, "Models");
    expect(screen.queryByRole("option", { name: "test-embedding-1" })).toBeNull();
    expect(screen.getByRole("option", { name: "test-chat-1" })).toBeInTheDocument();
  });
});

describe("ChatWindow compact responsive controls (#1216)", () => {
  it("compacts model controls while keeping send anchored", () => {
    const model = { ...chatModelCapability("test-chat-1"), workflowEligible: true };
    const { container } = render(
      <ChatSessionProvider
        value={makeSession({
          models: [model],
          selectedModel: model.id,
          activeChat: makeChat({ selectedModel: model.id }),
          draft: "hello",
        })}
      >
        <ChatWindow compact controlsNarrow barCompact workflowCompact />
      </ChatSessionProvider>,
    );

    expect(container.querySelector(".chatw")).toHaveClass("chatw-compact");
    expect(screen.queryByRole("button", { name: "Launch workflow" })).toBeNull();

    const modelControl = container.querySelector(".cmp-model");
    expect(modelControl).toHaveClass("cmp-model-compact");
    expect(modelControl).toHaveAttribute("data-tip", "Change model");
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
      "data-tip",
      "Send message",
    );
  });

  it("keeps model controls compact when workflowCompact is requested by the window frame", () => {
    const model = { ...chatModelCapability("test-chat-1"), workflowEligible: true };
    const { container } = render(
      <ChatSessionProvider
        value={makeSession({
          models: [model],
          selectedModel: model.id,
          activeChat: makeChat({ selectedModel: model.id }),
        })}
      >
        <ChatWindow compact barCompact workflowCompact />
      </ChatSessionProvider>,
    );

    expect(screen.queryByRole("button", { name: "Launch workflow" })).toBeNull();
    expect(container.querySelector(".cmp-model")).toHaveClass("cmp-model-compact");
  });

  it("keeps attach and model controls left while action buttons stay right", () => {
    const model = {
      ...chatModelCapability("test-chat-1"),
      supportsDocumentInput: true,
      supportsImageInput: true,
    };
    const { container } = render(
      <ChatSessionProvider
        value={makeSession({
          models: [model],
          selectedModel: model.id,
          activeChat: makeChat({ selectedModel: model.id }),
        })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );

    const leftGroup = container.querySelector(".cmp-bar-model");
    const rightGroup = container.querySelector(".cmp-bar-main:not(.cmp-bar-main-voice-dialog)");
    const attachButton = screen.getByRole("button", { name: "Attach file" });
    const modelTrigger = screen.getByRole("combobox", { name: "Models" });
    const sendButton = screen.getByRole("button", { name: "Send message" });

    expect(leftGroup).toContainElement(attachButton);
    expect(leftGroup).toContainElement(modelTrigger);
    expect(rightGroup).not.toContainElement(attachButton);
    expect(rightGroup).toContainElement(sendButton);
    expect(
      Boolean(
        attachButton.compareDocumentPosition(modelTrigger) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(attachButton.querySelector('path[d="M12 5v14M5 12h14"]')).not.toBeNull();
  });

  it("opens the compact model picker with the same menu width as the compact full model button", async () => {
    const user = userEvent.setup();
    const model = { ...chatModelCapability("test-chat-1"), workflowEligible: true };
    render(
      <ChatSessionProvider
        value={makeSession({
          models: [model],
          selectedModel: model.id,
          activeChat: makeChat({ selectedModel: model.id }),
        })}
      >
        <ChatWindow compact controlsNarrow barCompact workflowCompact />
      </ChatSessionProvider>,
    );

    const trigger = screen.getByRole("combobox", { name: "Models" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 82,
      height: 34,
      left: 24,
      right: 58,
      top: 48,
      width: 34,
      x: 24,
      y: 48,
      toJSON: () => ({}),
    });

    await user.click(trigger);

    expect(document.querySelector(".cmp-model-menu")).toHaveStyle({ width: "118px" });
  });

  it("uses the memory brain disclosure icon and hides history controls in minimal mode", () => {
    const { container } = render(
      <ChatSessionProvider
        value={makeSession({
          activeChat: makeChat(),
        })}
      >
        <ChatWindow minimalChat compact />
      </ChatSessionProvider>,
    );

    expect(container.querySelector(".chatw")).toHaveClass("chatw-minimal");
    const disclosure = screen.getByRole("button", { name: "No memories included" });
    expect(disclosure).toHaveClass("chat-memory-disclosure-toggle");
    expect(disclosure).toHaveAttribute("data-empty", "true");
    expect(disclosure).toHaveAttribute("data-tip", "No memories included");
    expect(disclosure.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText(/Approximate context:/)).toBeNull();
    expect(screen.queryByRole("button", { name: /clear history/i })).toBeNull();
  });
});

describe("ChatWindow memory controls", () => {
  it("keeps MemoriaViva configuration out of the chat window while preserving disclosure", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
      }),
    );

    expect(screen.queryByRole("switch")).toBeNull();
    expect(document.querySelector(".chat-memory-budget")).toBeNull();
    expect(document.querySelector(".chat-memory-toggle")).toBeNull();
    expect(screen.getByRole("button", { name: /no memories included/i })).toHaveClass(
      "chat-memory-disclosure-toggle",
    );
  });

  it("discloses disabled no-memory responses without deleting stored memories", async () => {
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        memoryEnabled: false,
        latestMemory: {
          context: {
            enabled: false,
            text: "",
            memories: [],
            budget: { tokens: 0, used: 0 },
          },
          actions: [],
        },
      }),
    );

    const disclosureButton = screen.getByRole("button", { name: /no memories included/i });
    await user.click(disclosureButton);
    expect(screen.getByText(/MemoriaViva was disabled for the last request/i)).toBeInTheDocument();
  });

  it("renders memory disclosure and candidate actions from the latest response", async () => {
    const acceptMemoryCandidate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        latestMemory: {
          context: {
            enabled: true,
            text: "- pref: strict TypeScript",
            memories: [
              {
                memoryId: "mem-1",
                bodyExcerpt: "Use TypeScript strict mode.",
                inclusionReason: "top signal: lexical match",
                sourceKind: "system-default",
                captureRationale: "Automatically inferred from conversation (salience capture)",
                sensitivity: "public",
                confidence: 0.82,
                status: "accepted",
                capturedAt: 1_700_000_000_000,
              },
            ],
            budget: { tokens: 1200, used: 180 },
          },
          actions: [
            {
              kind: "candidate",
              proposalId: "prop-1",
              body: "Deploy after the green CI run.",
              scopeLabel: "User memory",
              requiresApproval: true,
            },
          ],
        },
        acceptMemoryCandidate,
      }),
    );

    await user.click(screen.getByRole("button", { name: /1 memories included/i }));
    expect(screen.getByText("Use TypeScript strict mode.")).toBeInTheDocument();
    expect(screen.getByText("top signal: lexical match")).toBeInTheDocument();
    expect(screen.getByText("system-default")).toBeInTheDocument();
    expect(screen.getByText("82%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(acceptMemoryCandidate).toHaveBeenCalledWith("prop-1"));
    await waitFor(() => {
      expect(screen.getByText("MemoriaViva proposal accepted.")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /1 memories included/i })).toHaveFocus();
  });

  it("routes proposed memory rejection from the conversation flow", async () => {
    const rejectMemoryCandidate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        latestMemory: {
          context: {
            enabled: true,
            text: "",
            memories: [],
            budget: { tokens: 1200, used: 0 },
          },
          actions: [
            {
              kind: "candidate",
              proposalId: "prop-reject-1",
              body: "Remember the rejected deployment note.",
              scopeLabel: "Conversation memory",
              requiresApproval: true,
            },
          ],
        },
        rejectMemoryCandidate,
      }),
    );

    await user.click(screen.getByRole("button", { name: /no memories included/i }));
    expect(screen.getByText("Remember the rejected deployment note.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(rejectMemoryCandidate).toHaveBeenCalledWith("prop-reject-1"));
  });

  it("surfaces explicit update intents returned by governed memory operations", async () => {
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        latestMemory: {
          context: {
            enabled: true,
            text: "",
            memories: [],
            budget: { tokens: 1200, used: 0 },
          },
          actions: [
            {
              kind: "update",
              memoryId: "mem-update-1",
              bodyPatch: "Test runner is vitest.",
            },
          ],
        },
      }),
    );

    await user.click(screen.getByRole("button", { name: /no memories included/i }));
    expect(screen.getByText("MemoriaViva update detected")).toBeInTheDocument();
    expect(screen.getByText("mem-update-1")).toBeInTheDocument();
    expect(screen.getByText("Suggested update: Test runner is vitest.")).toBeInTheDocument();
  });

  it("requires inline confirmation before executing a forget action", async () => {
    const forgetMemoryAction = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        latestMemory: {
          context: {
            enabled: true,
            text: "- pref: strict TypeScript",
            memories: [],
            budget: { tokens: 1200, used: 180 },
          },
          actions: [
            {
              kind: "forget",
              memoryId: "mem-forget-1",
              requiresConfirmation: true,
            },
          ],
        },
        forgetMemoryAction,
      }),
    );

    await user.click(screen.getByRole("button", { name: /no memories included/i }));
    await user.click(screen.getByRole("button", { name: /review forget/i }));
    await user.click(screen.getByRole("button", { name: /forget permanently/i }));
    await waitFor(() => expect(forgetMemoryAction).toHaveBeenCalledWith("mem-forget-1"));
  });

  it("shows an inline error when the forget action fails", async () => {
    const forgetMemoryAction = vi.fn().mockRejectedValue(new Error("forget failed"));
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        latestMemory: {
          context: {
            enabled: true,
            text: "- pref: strict TypeScript",
            memories: [],
            budget: { tokens: 1200, used: 180 },
          },
          actions: [
            {
              kind: "forget",
              memoryId: "mem-forget-1",
              requiresConfirmation: true,
            },
          ],
        },
        forgetMemoryAction,
      }),
    );

    await user.click(screen.getByRole("button", { name: /no memories included/i }));
    await user.click(screen.getByRole("button", { name: /review forget/i }));
    await user.click(screen.getByRole("button", { name: /forget permanently/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/forget failed/i)).toBeInTheDocument();
    });
  });
});

// ─── GAP-C1 / GAP-C2 / GAP-C3 / MINOR honesty tests (#146) ──────────────────

describe("ChatWindow: no ornamental Build-mode button (#146 GAP-C1)", () => {
  it("does not render a button with text 'Build' when a chat is active", () => {
    renderWindow(makeSession({ activeChat: makeChat() }));
    expect(screen.queryByRole("button", { name: /build/i })).toBeNull();
  });

  it("does not render a Launch workflow button when the model is workflow-eligible", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        selectedModel: "wf-model",
        models: [
          {
            id: "wf-model",
            kind: "chat",
            contextWindow: 8000,
            maxOutputTokens: 1000,
            toolCalling: true,
            structuredOutput: true,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: true,
            costClass: "medium",
            latencyClass: "standard",
            throughputHint: "test fixture",
            preferredUseCases: [],
            knownLimitations: [],
          },
        ],
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "hi",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );
    expect(screen.queryByRole("button", { name: /launch workflow/i })).toBeNull();
  });
});

describe("ChatWindow: no 'example-workspace' placeholder label (#146 MINOR)", () => {
  it("never renders the literal 'example-workspace' text anywhere in the tree", () => {
    // Neither in the no-project nor in the active-project path should a hardcoded
    // 'example-workspace' placeholder appear. EmptyComposerState shows a real
    // project name or a generic hint, never a fake placeholder.
    renderWindow(makeSession({ activeProject: undefined }));
    expect(screen.queryByText(/example-workspace/i)).toBeNull();
  });

  it("does not show project subtext in the empty state when a project is active", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: {
          path: "/home/user/myproject",
          name: "myproject",
          available: true,
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 2,
        },
      }),
    );
    expect(screen.getByText(/how can i help you today\\?/i)).toBeInTheDocument();
    expect(screen.queryByText(/Working in myproject/)).toBeNull();
  });
});

// uiux-fix F042 (C208) — per-bubble copy affordance for assistant messages.
describe("ChatWindow message copy", () => {
  it("renders user prompt right-aligned with the answer full-width below", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "Please explain the test strategy.",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Use focused unit tests and one browser verification.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );

    const thread = document.querySelector<HTMLElement>(".chatw-thread");
    const turn = document.querySelector<HTMLElement>(".chat-turn");
    const prompt = document.querySelector<HTMLElement>(".chat-turn-prompt");
    const answer = document.querySelector<HTMLElement>(".chat-turn-answer");
    expect(thread).not.toBeNull();
    expect(turn).not.toBeNull();
    expect(prompt).toHaveTextContent("Please explain");
    expect(answer).toHaveTextContent("focused unit tests");
    expect(prompt?.querySelector('[data-role="user"][data-layout="turn"]')).not.toBeNull();
    expect(answer?.querySelector('[data-role="assistant"][data-layout="turn"]')).not.toBeNull();
    expect(turn?.querySelector('[role="separator"]')).toBeNull();
  });

  it("renders a left-side question map and jumps to the selected prompt", () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "First question with a short body.",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "First answer.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
          {
            id: "m3",
            chatId: "chat-1",
            role: "user",
            content:
              "Second question has enough words to show a useful hover preview in the compact navigation rail.",
            timestamp: 3,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
          {
            id: "m4",
            chatId: "chat-1",
            role: "assistant",
            content: "Second answer.",
            timestamp: 4,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );

    const map = screen.getByRole("navigation", { name: "Conversation questions" });
    const buttons = screen.getAllByRole("button", { name: /Jump to question/u });
    expect(buttons).toHaveLength(2);
    const secondButton = buttons[1];
    if (secondButton === undefined) throw new Error("second question map marker missing");
    expect(map.querySelectorAll(".chat-question-map-mark")).toHaveLength(2);
    expect(map.querySelectorAll(".chat-question-map-card")).toHaveLength(2);
    expect(map.querySelector(".chat-question-map-card-title")).toHaveTextContent("First question");
    expect(secondButton).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Second question has enough words"),
    );
    expect(secondButton).not.toHaveAttribute("title");
    expect(document.querySelector('[data-chat-question-id="m3"]')).not.toBeNull();

    fireEvent.click(secondButton);
    expect(scrollSpy).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    scrollSpy.mockRestore();
  });

  it("windows long transcripts and mounts an older question before jumping to it", async () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const messages = Array.from({ length: 130 }, (_, index) => {
      const turn = index + 1;
      return [
        makeMessage({
          id: `u${String(turn)}`,
          role: "user",
          content: `Question ${String(turn)} body for a long transcript.`,
          timestamp: turn * 2 - 1,
        }),
        makeMessage({
          id: `a${String(turn)}`,
          role: "assistant",
          content: `Answer ${String(turn)} body.`,
          timestamp: turn * 2,
        }),
      ];
    }).flat();

    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages,
      }),
    );

    expect(document.querySelector(".chatw-thread")).toHaveAttribute("data-windowed", "true");
    expect(document.querySelectorAll(".chat-turn")).toHaveLength(80);
    expect(document.querySelector('[data-chat-question-id="u1"]')).toBeNull();
    expect(document.querySelector('[data-chat-question-id="u130"]')).not.toBeNull();
    expect(document.querySelector('[data-position="before"]')).toHaveAttribute(
      "data-hidden-turns",
      "50",
    );

    const buttons = screen.getAllByRole("button", { name: /Jump to question/u });
    expect(buttons).toHaveLength(130);
    const firstButton = buttons[0];
    if (firstButton === undefined) throw new Error("first question map marker missing");
    fireEvent.click(firstButton);

    await waitFor(() => {
      expect(document.querySelector('[data-chat-question-id="u1"]')).not.toBeNull();
    });
    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    });
    expect(document.querySelector('[data-position="after"]')).toHaveAttribute(
      "data-hidden-turns",
      "50",
    );
    scrollSpy.mockRestore();
  });

  it("keeps a single-question chat in the full-width log column", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "Guten Morgen",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Guten Morgen! Wie kann ich dir helfen?",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );

    const shell = document.querySelector<HTMLElement>(".chatw-log-shell");
    if (shell === null) throw new Error("chat log shell missing");

    expect(screen.queryByRole("navigation", { name: "Conversation questions" })).toBeNull();
    expect(shell).not.toHaveClass("chatw-log-shell-with-map");
    expect(shell.firstElementChild).toHaveClass("chatw-log");
    expect(screen.getByText("Guten Morgen! Wie kann ich dir helfen?")).toBeInTheDocument();
  });

  it("renders assistant identity as the Keiko logo without the visible wordmark", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Answer body.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );

    const assistantBubble = document.querySelector(
      'article[data-role="assistant"] .chat-msg-bubble',
    );
    expect(assistantBubble).not.toBeNull();
    expect(screen.getByRole("img", { name: "Keiko logo" })).toBeInTheDocument();
    expect(assistantBubble?.querySelector(".chat-msg-brand img")).toHaveAttribute(
      "src",
      "/assets/keiko-logo.svg",
    );
    expect(assistantBubble?.querySelector(".chat-msg-brand")).toHaveAttribute(
      "data-pulsing",
      "false",
    );
    expect(assistantBubble?.querySelector(".chat-msg-role")).toBeNull();
  });

  it("copies assistant plaintext with citation markers stripped; user bubbles get no copy button", async () => {
    // jsdom does not implement navigator.clipboard — same descriptor swap as
    // the SafeMarkdown code-block copy test.
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "What is the capital?",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Paris 【1】 is the capital [2].",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );

    // Exactly one copy button — the assistant bubble's. User bubbles carry none.
    expect(screen.getAllByRole("button", { name: "Copy answer" })).toHaveLength(1);
    const copyButton = screen.getByRole("button", { name: "Copy answer" });
    expect(copyButton).toHaveTextContent("");
    expect(copyButton).not.toHaveClass("ui-tip");
    expect(copyButton).not.toHaveAttribute("data-tip");
    const copyIcon = copyButton.querySelector("svg");
    expect(copyIcon).not.toBeNull();
    expect(copyIcon).toHaveAttribute("width", "20");
    expect(copyIcon).toHaveAttribute("height", "20");
    fireEvent.click(copyButton);
    await waitFor(() => {
      // Citation markers (ASCII + CJK/fullwidth glyphs) and their leading
      // whitespace are stripped from the copied plaintext.
      expect(writeText).toHaveBeenCalledWith("Paris is the capital.");
    });
    expect(await screen.findByText("Answer copied")).toBeInTheDocument();

    if (clipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
  });

  it("removes grounded source labels and duplicate repository references from copied answers", () => {
    expect(
      copyableMessageText(
        "Check [packages/keiko-harness/src/context.ts:49-58] [source: api] packages/keiko-harness/src/context.ts:49-58 【1】.",
      ),
    ).toBe("Check packages/keiko-harness/src/context.ts:49-58.");
  });

  it("removes standalone source labels without corrupting answer spacing", () => {
    expect(copyableMessageText("Alpha [source: api] beta.")).toBe("Alpha beta.");
  });

  it("surfaces assistant answer clipboard failures", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error("denied"));
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Answer body.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    expect(
      await screen.findByText("Clipboard access failed. Select the answer manually and copy it."),
    ).toBeInTheDocument();

    if (clipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
  });

  it("lets long assistant answers collapse without changing copy content", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const longAnswer = Array.from({ length: 34 }, (_, index) => `Line ${String(index + 1)}`).join(
      "\n",
    );

    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: longAnswer,
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );

    const content = document.querySelector(".chat-msg-content");
    expect(content).toHaveAttribute("data-collapsible", "true");
    expect(content).toHaveAttribute("data-collapsed", "false");

    const collapse = screen.getByRole("button", { name: "Collapse answer" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);

    expect(content).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "Expand answer" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(longAnswer);
    });

    if (clipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
  });

  it("opens assistant repository references directly when one repository root is connected", async () => {
    const user = userEvent.setup();
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Check packages/keiko-harness/src/context.ts:50-57 for this case.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
      { linkedRoot: "/repo", openEditorFile },
    );

    const referenceButton = screen.getByRole("button", {
      name: "Open packages/keiko-harness/src/context.ts at lines 50-57 in editor",
    });
    expect(referenceButton).toHaveTextContent("context.ts:50-57");
    expect(referenceButton).not.toHaveTextContent("packages/keiko-harness");
    expect(referenceButton).toHaveAttribute("title", "packages/keiko-harness/src/context.ts:50-57");

    await user.click(referenceButton);

    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo",
      path: "packages/keiko-harness/src/context.ts",
      lineStart: 50,
      lineEnd: 57,
    });
    expect(
      screen.getByText("Opened packages/keiko-harness/src/context.ts in editor."),
    ).toHaveAttribute("role", "status");
  });

  it("surfaces a clear status when repository references have no connected root", async () => {
    const user = userEvent.setup();
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    renderWindow(
      makeSession({
        activeChat: makeChat({
          connectedScopes: [],
          connectedScope: undefined,
        }),
        messages: [
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Check src/context.ts:50 before this change.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
      { linkedRoot: null, openEditorFile },
    );

    await user.click(
      screen.getByRole("button", { name: "Open src/context.ts at line 50 in editor" }),
    );

    expect(openEditorFile).not.toHaveBeenCalled();
    expect(
      screen.getByText("Connect a Files window to open repository references."),
    ).toHaveAttribute("role", "alert");
  });

  it("opens assistant repository references from chat connected scope roots", async () => {
    const user = userEvent.setup();
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    renderWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/Users/dev/Projects/Keiko",
          connectedScopes: [
            {
              kind: "files",
              root: "/Users/dev/Projects/Keiko",
              relativePaths: ["packages/keiko-editor/src/range.ts"],
              connectedAtMs: 1,
            },
          ],
        }),
        messages: [
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Use packages/keiko-editor/src/range.ts:10 for this behavior.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
      { openEditorFile },
    );

    await user.click(
      screen.getByRole("button", {
        name: "Open packages/keiko-editor/src/range.ts at line 10 in editor",
      }),
    );

    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/Users/dev/Projects/Keiko",
      path: "packages/keiko-editor/src/range.ts",
      lineStart: 10,
      lineEnd: 10,
    });
  });

  it("prefers nested chat repository roots over linked parent folder roots", async () => {
    const user = userEvent.setup();
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    renderWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/Users/dev/Projects",
          connectedScopes: [
            {
              kind: "workspace-root",
              root: "/Users/dev/Projects",
              relativePaths: [],
              connectedAtMs: 1,
            },
            {
              kind: "files",
              root: "/Users/dev/Projects/Keiko",
              relativePaths: ["packages/keiko-editor/src/range.ts"],
              connectedAtMs: 2,
            },
          ],
        }),
        messages: [
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Use packages/keiko-editor/src/range.ts:10 for this behavior.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
      { linkedRoot: "/Users/dev/Projects", openEditorFile },
    );

    await user.click(
      screen.getByRole("button", {
        name: "Open packages/keiko-editor/src/range.ts at line 10 in editor",
      }),
    );

    expect(screen.queryByRole("dialog", { name: "Select repository source" })).toBeNull();
    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/Users/dev/Projects/Keiko",
      path: "packages/keiko-editor/src/range.ts",
      lineStart: 10,
      lineEnd: 10,
    });
  });

  it("normalizes legacy parent-prefixed repository references against nested roots", async () => {
    const user = userEvent.setup();
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    renderWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/Users/dev/Projects",
          connectedScopes: [
            {
              kind: "workspace-root",
              root: "/Users/dev/Projects",
              relativePaths: [],
              connectedAtMs: 1,
            },
            {
              kind: "files",
              root: "/Users/dev/Projects/Keiko",
              relativePaths: ["packages/keiko-editor/src/range.ts"],
              connectedAtMs: 2,
            },
          ],
        }),
        messages: [
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Use Keiko/packages/keiko-editor/src/range.ts:10 for legacy citations.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
      { linkedRoot: "/Users/dev/Projects", openEditorFile },
    );

    const referenceButton = screen.getByRole("button", {
      name: "Open Keiko/packages/keiko-editor/src/range.ts at line 10 in editor",
    });
    expect(referenceButton).toHaveTextContent("range.ts:10");

    await user.click(referenceButton);

    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/Users/dev/Projects/Keiko",
      path: "packages/keiko-editor/src/range.ts",
      lineStart: 10,
      lineEnd: 10,
    });
  });

  it("requires a root choice for assistant repository references when multiple roots are connected", async () => {
    const user = userEvent.setup();
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "m2",
            chatId: "chat-1",
            role: "assistant",
            content: "Check src/context.ts:12 before editing.",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
      { linkedRoots: ["/repo-a", "/repo-b"], openEditorFile },
    );

    await user.click(
      screen.getByRole("button", { name: "Open src/context.ts at line 12 in editor" }),
    );
    const picker = screen.getByRole("dialog", { name: "Select repository source" });
    expect(picker).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "repo-b" }));

    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo-b",
      path: "src/context.ts",
      lineStart: 12,
      lineEnd: 12,
    });
  });
});

// ─── #2 / #19 — confirmation guard for "Model only" destructive clear ────────

describe("ChatWindow scope clear confirmation (#2 / #19)", () => {
  it("prompts for confirmation when active scopes exist and cancelling leaves chat unchanged", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    renderWindow(
      makeSession({
        activeChat: makeChat({
          connectedScopes: [
            { kind: "workspace-root", root: "/repo", relativePaths: [], connectedAtMs: 1 },
          ],
          localKnowledgeScopes: [
            { kind: "capsule", capsuleId: makeCapsuleId("cap-1"), connectedAtMs: 2 },
          ],
        }),
        replaceChat,
      }),
    );

    await chooseComboboxOption(user, "Grounding mode", "Model only");

    // Confirmation was shown.
    expect(confirmSpy).toHaveBeenCalledOnce();
    // updateChat must NOT have been called (user cancelled).
    expect(updateChatMock).not.toHaveBeenCalled();
    // replaceChat must NOT have been called.
    expect(replaceChat).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it("proceeds with the clear when the user confirms", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const updated = makeChat();
    updateChatMock.mockResolvedValueOnce({ chat: updated });

    renderWindow(
      makeSession({
        activeChat: makeChat({
          connectedScopes: [
            { kind: "workspace-root", root: "/repo", relativePaths: [], connectedAtMs: 1 },
          ],
        }),
        replaceChat,
      }),
    );

    await chooseComboboxOption(user, "Grounding mode", "Model only");

    await waitFor(() => {
      expect(updateChatMock).toHaveBeenCalledWith("chat-1", {
        connectedScopes: null,
        localKnowledgeScopes: null,
      });
    });
    expect(replaceChat).toHaveBeenCalledWith(updated);

    confirmSpy.mockRestore();
  });

  it("skips confirmation and clears immediately when no sources are active", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm");
    const updated = makeChat();
    updateChatMock.mockResolvedValueOnce({ chat: updated });

    renderWindow(makeSession({ activeChat: makeChat(), replaceChat }));

    await chooseComboboxOption(user, "Grounding mode", "Model only");

    // confirm must NOT have been called because there are no active sources.
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it("keeps connectedScopes when switching to 'files' arm (GRD-009 #19)", async () => {
    const user = userEvent.setup();
    const replaceChat = vi.fn();
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [
        {
          id: makeCapsuleId("cap-x"),
          displayName: "Cap X",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
    });
    fetchCapsuleSetsMock.mockResolvedValueOnce({ capsuleSets: [] });
    const updated = makeChat({
      connectedScopes: [{ kind: "files", relativePaths: ["src"], connectedAtMs: 1 }],
    });
    updateChatMock.mockResolvedValueOnce({ chat: updated });
    renderWindow(
      makeSession({
        activeChat: makeChat({
          connectedScopes: [{ kind: "files", relativePaths: ["src"], connectedAtMs: 1 }],
          localKnowledgeScopes: [
            { kind: "capsule", capsuleId: makeCapsuleId("cap-x"), connectedAtMs: 2 },
          ],
        }),
        replaceChat,
      }),
    );

    // The chat has 2 sources → "multi" is shown. Selecting "files" clears
    // localKnowledgeScopes but keeps connectedScopes (the "files" arm only
    // sends { localKnowledgeScopes: null }).
    await chooseComboboxOption(user, "Grounding mode", "Live Files context");

    await waitFor(() => {
      expect(updateChatMock).toHaveBeenCalledWith("chat-1", { localKnowledgeScopes: null });
    });
    expect(updateChatMock.mock.calls[0]?.[1]).not.toHaveProperty("connectedScopes");
    expect(replaceChat).toHaveBeenCalledWith(updated);
  });
});

// ─── #28 — multi-scope display sentinel ──────────────────────────────────────

describe("ChatWindow multi-scope grounding display (#28)", () => {
  it("shows 'Multiple sources' when two capsule scopes are active", async () => {
    fetchCapsulesMock.mockResolvedValueOnce({
      capsules: [
        {
          id: makeCapsuleId("cap-a"),
          displayName: "Alpha",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
        {
          id: makeCapsuleId("cap-b"),
          displayName: "Bravo",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
    });
    fetchCapsuleSetsMock.mockResolvedValueOnce({ capsuleSets: [] });

    renderWindow(
      makeSession({
        activeChat: makeChat({
          localKnowledgeScopes: [
            { kind: "capsule", capsuleId: makeCapsuleId("cap-a"), connectedAtMs: 1 },
            { kind: "capsule", capsuleId: makeCapsuleId("cap-b"), connectedAtMs: 2 },
          ],
        }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Grounding mode" })).toHaveTextContent(
        "Multiple sources",
      );
    });
    await openCombobox(userEvent.setup(), "Grounding mode");
    // A disabled read-only "Multiple sources" option is present.
    expect(screen.getByRole("option", { name: "Multiple sources" })).toBeInTheDocument();
  });
});

// ─── #28 — MemoryActionCard rejected kind ────────────────────────────────────

describe("ChatWindow MemoryActionCard rejected kind (#28)", () => {
  it("renders 'Memory proposal declined' title and the reason for a rejected action", async () => {
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        latestMemory: {
          context: {
            enabled: true,
            text: "",
            memories: [],
            budget: { tokens: 1200, used: 0 },
          },
          actions: [
            {
              kind: "rejected",
              reason: "Below salience threshold.",
            },
          ],
        },
      }),
    );

    await user.click(screen.getByRole("button", { name: /no memories included/i }));
    expect(screen.getByText("Memory proposal declined")).toBeInTheDocument();
    expect(screen.getByText("Below salience threshold.")).toBeInTheDocument();
  });

  it("renders the fallback reason when the rejected reason is empty", async () => {
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        latestMemory: {
          context: {
            enabled: true,
            text: "",
            memories: [],
            budget: { tokens: 1200, used: 0 },
          },
          actions: [
            {
              kind: "rejected",
              reason: "",
            },
          ],
        },
      }),
    );

    await user.click(screen.getByRole("button", { name: /no memories included/i }));
    expect(screen.getByText("Memory proposal declined")).toBeInTheDocument();
    expect(screen.getByText("No reason provided")).toBeInTheDocument();
  });
});
