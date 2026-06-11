// Issue #185 AC3 — tests for the grounded-request cancel button in ChatWindow.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CapsuleSetId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat, GroundedAnswer, ModelCapability } from "@/lib/types";
import { fetchCapsules, fetchCapsuleSets } from "@/lib/local-knowledge-api";

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

function renderWindow(session: ChatSessionApi): void {
  render(
    <ChatSessionProvider value={session}>
      <ChatWindow />
    </ChatSessionProvider>,
  );
}

const fetchCapsulesMock = vi.mocked(fetchCapsules);
const fetchCapsuleSetsMock = vi.mocked(fetchCapsuleSets);

function makeCapsuleId(value: string): KnowledgeCapsuleId {
  return value as KnowledgeCapsuleId;
}

function makeCapsuleSetId(value: string): CapsuleSetId {
  return value as CapsuleSetId;
}

describe("ChatWindow cancel button", () => {
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
    expect(disclosureButton).toHaveAttribute("aria-controls", "chat-memory-disclosure");
    await user.click(disclosureButton);
    expect(disclosureButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Use pnpm")).toBeInTheDocument();
    expect(screen.getByText(/Used 42 of 1200 MemoriaViva tokens/i)).toBeInTheDocument();
  });
});

describe("ChatWindow local knowledge scope disclosure", () => {
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
      const select = screen.getByLabelText("Grounding mode") as HTMLSelectElement;
      expect(select.value).toBe("capsule:cap-stale");
    });
    // uiux-fix F041 (C173) — "(unavailable)" is the single degraded suffix
    // (previously "(not ready)" for capsules vs "(unavailable)" for sets).
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
      const select = screen.getByLabelText("Grounding mode") as HTMLSelectElement;
      expect(select.value).toBe("capsule-set:set-1");
    });
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
  it("renders every chat-eligible model id in the Model dropdown options", () => {
    // activeChat is required so the composer bar (containing the model select)
    // is rendered — without it the new NoChatState shows instead (#146).
    renderWindow(
      makeSession({
        models: [chatModelCapability("test-chat-1"), chatModelCapability("test-chat-2")],
        selectedModel: "test-chat-1",
        activeChat: makeChat(),
      }),
    );
    const select = screen.getByLabelText("Model");
    const options = Array.from(select.querySelectorAll("option")).map((option) => option.value);
    expect(options).toContain("test-chat-1");
    expect(options).toContain("test-chat-2");
  });

  it("does not render a non-chat model id in the dropdown when session.models is pre-filtered (AC #2)", () => {
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
    const select = screen.getByLabelText("Model");
    const options = Array.from(select.querySelectorAll("option")).map((option) => option.value);
    expect(options).not.toContain("test-embedding-1");
    expect(options).toContain("test-chat-1");
  });
});

describe("ChatWindow memory controls", () => {
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
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(acceptMemoryCandidate).toHaveBeenCalledWith("prop-1"));
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

  it("shows the real project name in the empty-state sub-heading when a project is active", () => {
    // EmptyComposerState renders "Working in <name>…" when an activeChat exists.
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
    // The empty-state sub renders "Working in myproject. What would you like to explore?"
    expect(screen.getByText(/Working in myproject/)).toBeInTheDocument();
  });
});

// uiux-fix F042 (C208) — per-bubble copy affordance for assistant messages.
describe("ChatWindow message copy", () => {
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
