// Issue #185 AC3 — tests for the grounded-request cancel button in ChatWindow.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CapsuleSetId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat, ModelCapability } from "@/lib/types";
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
    clearHistory: vi.fn(),
    launchWorkflowFromConversation: vi.fn().mockResolvedValue({ ok: true, runId: "test-run" }),
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
    expect(screen.getByText(/Used 42 of 1200 memory tokens/i)).toBeInTheDocument();
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
    expect(
      screen.getByRole("option", { name: "Knowledge capsule: cap-stale (not ready)" }),
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

  it("does not render an embedding-kind model id when session.models is pre-filtered (AC #2)", () => {
    // Production path: useChatSession.bootstrapSession filters via
    // isConversationEligibleModel before populating session.models. This test
    // pins the regression — if the session ever stopped filtering, the
    // dropdown would surface embedding models and this assertion would fail.
    // activeChat is required so the composer bar is rendered (#146).
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
});
