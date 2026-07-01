// Issue #185 AC3 — tests for the grounded-request cancel button in ChatWindow.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapsuleSetId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat, ChatMessage, GroundedAnswer, ModelCapability } from "@/lib/types";
import { updateChat } from "@/lib/api";
import { fetchCapsules, fetchCapsuleSets } from "@/lib/local-knowledge-api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
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
    // Issue #147 — attachment fields
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    // Issue #151 — budget + clear-history fields default to "no known limits"
    // so the existing cancel-button tests keep their previous semantics.
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
    launchWorkflowFromConversation: vi.fn().mockResolvedValue({ ok: true, runId: "test-run" }),
    launchGroundedWorkflowHandoff: vi.fn().mockResolvedValue({ ok: true, runId: "test-run" }),
    lastSentDocuments: [],
    ...overrides,
  };
}

function renderWindow(
  session: ChatSessionApi,
  props: { readonly onOpenRunResult?: ((message: ChatMessage) => void) | undefined } = {},
): void {
  render(
    <ChatSessionProvider value={session}>
      <ChatWindow onOpenRunResult={props.onOpenRunResult} />
    </ChatSessionProvider>,
  );
}

const fetchCapsulesMock = vi.mocked(fetchCapsules);
const fetchCapsuleSetsMock = vi.mocked(fetchCapsuleSets);
const updateChatMock = vi.mocked(updateChat);

beforeEach(() => {
  fetchCapsulesMock.mockReset();
  fetchCapsulesMock.mockResolvedValue({ capsules: [] });
  fetchCapsuleSetsMock.mockReset();
  fetchCapsuleSetsMock.mockResolvedValue({ capsuleSets: [] });
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
  it("renders regenerate on the latest ungrounded assistant response", async () => {
    const regenerateMessage = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          {
            id: "u1",
            chatId: "chat-1",
            role: "user",
            content: "hello",
            timestamp: 1,
          },
          {
            id: "a1",
            chatId: "chat-1",
            role: "assistant",
            content: "answer",
            timestamp: 2,
          },
        ],
        regenerateMessage,
      }),
    );

    await user.click(screen.getByRole("button", { name: /regenerate response/i }));
    expect(regenerateMessage).toHaveBeenCalledWith("a1");
  });

  it("keeps cancel reachable while regeneration is in flight", async () => {
    const cancelSend = vi.fn();
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        sending: true,
        sendStatus: "contacting",
        regeneratingMessageId: "a1",
        cancelSend,
        messages: [
          {
            id: "u1",
            chatId: "chat-1",
            role: "user",
            content: "hello",
            timestamp: 1,
          },
          {
            id: "a1",
            chatId: "chat-1",
            role: "assistant",
            content: "answer",
            timestamp: 2,
          },
        ],
      }),
    );

    await user.click(screen.getByRole("button", { name: /cancel regeneration/i }));
    expect(cancelSend).toHaveBeenCalledTimes(1);
  });

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

  it("renders the grounded panel for a plural-only connectedScopes chat", () => {
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
        latestGrounded,
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
  it("exposes expanded state and disclosure linkage on the memory chip", async () => {
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

describe("ChatWindow local knowledge scope disclosure", () => {
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
  it("compacts workflow and model controls together while keeping send anchored", () => {
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
    const launch = screen.getByRole("button", { name: "Launch workflow" });
    expect(launch).toHaveClass("cmp-mode-compact");
    expect(launch).toHaveAttribute("data-tip", "Launch workflow");

    const modelControl = container.querySelector(".cmp-model");
    expect(modelControl).toHaveClass("cmp-model-compact");
    expect(modelControl).toHaveAttribute("data-tip", "Change model");
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
      "data-tip",
      "Send message",
    );
  });

  it("keeps model and workflow controls in the same compact state", () => {
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

    expect(screen.getByRole("button", { name: "Launch workflow" })).toHaveClass("cmp-mode-compact");
    expect(container.querySelector(".cmp-model")).toHaveClass("cmp-model-compact");
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

  it("uses the compact no-memory disclosure icon and hides budget in minimal mode", () => {
    const { container } = render(
      <ChatSessionProvider
        value={makeSession({
          activeChat: makeChat(),
          budget: {
            approximateBytes: 2_000,
            approximateTokens: 500,
            contextWindowTokens: 10_000,
            reservedOutputTokens: 2_000,
            availableInputTokens: 8_000,
            pressure: "low",
            breakdown: {
              draftBytes: 100,
              historyBytes: 1_900,
              documentBytes: 0,
              repoContextBytes: 0,
              knowledgeBytes: 0,
              memoryBytes: 0,
            },
          },
        })}
      >
        <ChatWindow minimalChat compact />
      </ChatSessionProvider>,
    );

    expect(container.querySelector(".chatw")).toHaveClass("chatw-minimal");
    const disclosure = screen.getByRole("button", { name: "No memories included" });
    expect(disclosure).toHaveClass("chat-memory-disclosure-toggle");
    expect(disclosure).toHaveAttribute("data-tip", "No memories included");
    expect(screen.queryByText(/Approximate context:/)).toBeNull();
  });
});

describe("ChatWindow memory controls", () => {
  it("lets users disable MemoriaViva for the next request and adjust the context budget", () => {
    const setMemoryEnabled = vi.fn();
    const setMemoryBudgetTokens = vi.fn();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        memoryEnabled: true,
        memoryBudgetTokens: 1200,
        setMemoryEnabled,
        setMemoryBudgetTokens,
      }),
    );

    const toggle = screen.getByRole("switch", {
      name: "Enable MemoriaViva for the next request",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(setMemoryEnabled).toHaveBeenCalledWith(false);

    fireEvent.change(screen.getByLabelText("Budget (tokens)"), { target: { value: "800" } });
    expect(setMemoryBudgetTokens).toHaveBeenCalledWith(800);

    fireEvent.click(screen.getByRole("button", { name: "Increase memory budget" }));
    expect(setMemoryBudgetTokens).toHaveBeenCalledWith(1300);

    fireEvent.click(screen.getByRole("button", { name: "Decrease memory budget" }));
    expect(setMemoryBudgetTokens).toHaveBeenCalledWith(1100);
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

    expect(screen.getByText("MemoriaViva off")).toBeInTheDocument();
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
    await user.type(screen.getByLabelText(/type forget/i), "FORGET");
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
    await user.type(screen.getByLabelText(/type forget/i), "FORGET");
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

  it("still renders the Launch workflow button when the model is workflow-eligible", () => {
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
    expect(screen.getByRole("button", { name: /launch workflow/i })).toBeInTheDocument();
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
    expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => {
      // Citation markers (ASCII + CJK/fullwidth glyphs) and their leading
      // whitespace are stripped from the copied plaintext.
      expect(writeText).toHaveBeenCalledWith("Paris is the capital.");
    });

    if (clipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
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
