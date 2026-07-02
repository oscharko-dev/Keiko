// Issue #153 — workflow evidence remains visible in chat, but workflow launches live exclusively
// in the Agent widget surface.

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { RunSummaryCard } from "./WorkflowHandoff";
import { useChatSession, type ChatSessionApi } from "./hooks/useChatSession";
import * as api from "@/lib/api";
import type { Chat, ChatMessage, ModelCapability, ProjectWithAvailability } from "@/lib/types";

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

function makeProject(overrides: Partial<ProjectWithAvailability> = {}): ProjectWithAvailability {
  return {
    path: "/proj",
    name: "proj",
    favorite: false,
    available: true,
    createdAt: 1,
    lastOpenedAt: 2,
    ...overrides,
  };
}

function workflowEligibleModel(id: string): ModelCapability {
  return {
    id,
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
    preferredUseCases: ["Workflow"],
    knownLimitations: ["test fixture"],
  };
}

function userMessage(content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    chatId: "chat-1",
    role: "user",
    content,
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
    ...overrides,
  };
}

function systemRunSummaryMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m-sys",
    chatId: "chat-1",
    role: "system",
    content: "Launched: Generate unit tests",
    timestamp: 2,
    runId: "run-42",
    workflowId: "unit-test-generation",
    workflowStatus: "running",
    shortResult: undefined,
    taskType: undefined,
    ...overrides,
  };
}

function connectedGroundedAnswer() {
  return {
    groundingKind: "connected-context" as const,
    userMessageId: "msg-u",
    assistantMessageId: "msg-a",
    messageId: "msg-a",
    content: "Repository-grounded answer.",
    citations: [],
    uncertainty: [],
    omittedCount: 0,
    elapsedMs: 20,
    contextPack: {
      schemaVersion: "1" as const,
      scopeId: "scope-1",
      scopeKind: "files" as const,
      fileCount: 1,
      queryKind: "natural-language" as const,
      usage: {
        searchCalls: 1,
        filesRead: 1,
        excerptBytes: 100,
        modelInputTokens: 50,
        modelOutputTokens: 20,
        elapsedMs: 0,
        rerankCalls: 0,
      },
      budget: {
        searchCallsMax: 10,
        filesReadMax: 10,
        excerptBytesMax: 1000,
        modelInputTokensMax: 1000,
        modelOutputTokensMax: 500,
        elapsedMsMax: 1000,
        rerankCallsMax: Number.POSITIVE_INFINITY,
      },
      citationCount: 0,
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
      elapsedMs: 20,
    },
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
    selectedModel: undefined,
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

function renderWindow(session: ChatSessionApi): void {
  render(
    <ChatSessionProvider value={session}>
      <ChatWindow />
    </ChatSessionProvider>,
  );
}

function strictModeWrapper({ children }: { readonly children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

describe("WorkflowHandoff — chat launch surfaces are retired", () => {
  it("does not render Launch workflow in the composer, even for workflow-capable models", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [userMessage("hi")],
      }),
    );

    expect(screen.queryByRole("button", { name: /^launch workflow$/i })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /^launch workflow$/i })).toBeNull();
  });

  it("does not render a grounded workflow launch action under grounded answers", () => {
    const groundedAnswer = connectedGroundedAnswer();
    renderWindow(
      makeSession({
        activeChat: makeChat({
          connectedScope: { kind: "files", relativePaths: ["src/example.ts"], connectedAtMs: 1 },
        }),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [
          userMessage("hi"),
          userMessage("Repository-grounded answer.", {
            id: "msg-a",
            role: "assistant",
            timestamp: 2,
            groundedAnswer,
          }),
        ],
      }),
    );

    expect(screen.queryByRole("button", { name: /launch grounded workflow/i })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /grounded workflow handoff/i })).toBeNull();
  });
});

describe("WorkflowHandoff — run summary rendering", () => {
  it("renders a system run-summary message as a RunSummaryCard with workflow id and status", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [
          userMessage("generate tests for src/example.ts"),
          systemRunSummaryMessage({ workflowStatus: "running" }),
        ],
      }),
    );
    const card = screen.getByTestId("run-summary-card");
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent("unit-test-generation");
    expect(card.getAttribute("data-status")).toBe("running");
    expect(card).toHaveTextContent("run-42");
  });

  it("falls back to a queued indicator when workflowStatus is missing", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [systemRunSummaryMessage({ workflowStatus: undefined })],
      }),
    );
    expect(screen.getByTestId("run-summary-card").getAttribute("data-status")).toBe("queued");
  });

  it("offers a result CTA and evidence link for a run-summary message", async () => {
    const user = userEvent.setup();
    const message = systemRunSummaryMessage({ workflowStatus: "completed" });
    const openResult = vi.fn();
    render(<RunSummaryCard message={message} onOpenResult={openResult} />);

    await user.click(screen.getByRole("button", { name: /open result/i }));

    expect(openResult).toHaveBeenCalledWith(message);
    expect(screen.getByRole("link", { name: /evidence/i })).toHaveAttribute(
      "href",
      "/api/evidence/run-42",
    );
  });

  it("does not render patch-apply or command-exec affordances in the chat run card", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [systemRunSummaryMessage({ workflowStatus: "completed" })],
      }),
    );

    expect(screen.queryByRole("button", { name: /apply patch/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /run command/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /execute/i })).toBeNull();
  });
});

describe("useChatSession run-summary patching", () => {
  beforeEach(() => {
    vi.spyOn(api, "fetchModels").mockResolvedValue({ models: [workflowEligibleModel("wf-model")] });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({ projects: [makeProject()] });
    vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [makeChat()] });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });
    vi.spyOn(api, "fetchRunReport").mockRejectedValue(
      new api.ApiError("RUN_STILL_STARTING", "Run report is not ready.", 409),
    );
    vi.spyOn(api, "fetchEvidenceManifest").mockRejectedValue(
      new api.ApiError("EVIDENCE_NOT_FOUND", "Evidence manifest not found.", 404),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("patches a unit-test run-summary when the run report reaches a terminal dry-run status", async () => {
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({
      messages: [systemRunSummaryMessage({ id: "m-unit", runId: "run-unit" })],
    });
    vi.spyOn(api, "fetchRunReport").mockResolvedValue({
      report: {
        status: "dry-run",
        addedTestFiles: [{ path: "tests/example.test.ts", estimatedTestCount: 2 }],
      },
    });
    const patch = vi.spyOn(api, "patchChatMessage").mockResolvedValue({
      message: systemRunSummaryMessage({
        id: "m-unit",
        runId: "run-unit",
        workflowStatus: "completed",
        shortResult: "Generated 1 test files; 2 tests proposed.",
      }),
    });

    const { result } = renderHook(() => useChatSession(), { wrapper: strictModeWrapper });

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("m-unit", "chat-1", "/proj", {
        workflowStatus: "completed",
        shortResult: "Generated 1 test files; 2 tests proposed.",
      }),
    );
    await waitFor(() =>
      expect(result.current.messages[0]).toMatchObject({
        id: "m-unit",
        workflowStatus: "completed",
        shortResult: "Generated 1 test files; 2 tests proposed.",
      }),
    );
  });

  it("patches a bug-investigation run-summary when the investigation report is terminal", async () => {
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({
      messages: [
        systemRunSummaryMessage({
          id: "m-bug",
          runId: "run-bug",
          workflowId: "bug-investigation",
          content: "Launched: Investigate bug",
        }),
      ],
    });
    vi.spyOn(api, "fetchRunReport").mockResolvedValue({
      report: { status: "investigation-only" },
    });
    const patch = vi.spyOn(api, "patchChatMessage").mockResolvedValue({
      message: systemRunSummaryMessage({
        id: "m-bug",
        runId: "run-bug",
        workflowId: "bug-investigation",
        workflowStatus: "completed",
        shortResult: "Investigation complete; root cause documented.",
      }),
    });

    const { result } = renderHook(() => useChatSession());

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("m-bug", "chat-1", "/proj", {
        workflowStatus: "completed",
        shortResult: "Investigation complete; root cause documented.",
      }),
    );
    await waitFor(() =>
      expect(result.current.messages[0]).toMatchObject({
        id: "m-bug",
        workflowStatus: "completed",
        shortResult: "Investigation complete; root cause documented.",
      }),
    );
  });

  it("deduplicates run-summary polling across hook instances for the same run", async () => {
    const pending = systemRunSummaryMessage({ id: "m-shared", runId: "run-shared" });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [pending] });
    const report = vi.spyOn(api, "fetchRunReport").mockResolvedValue({
      report: {
        status: "dry-run",
        addedTestFiles: [{ path: "tests/shared.test.ts", estimatedTestCount: 1 }],
      },
    });

    let resolvePatch:
      | ((value: { readonly message: ReturnType<typeof systemRunSummaryMessage> }) => void)
      | undefined;
    const patch = vi.spyOn(api, "patchChatMessage").mockReturnValue(
      new Promise<{ readonly message: ReturnType<typeof systemRunSummaryMessage> }>((resolve) => {
        resolvePatch = resolve;
      }),
    );

    const first = renderHook(() => useChatSession());
    const second = renderHook(() => useChatSession());

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledTimes(1);

    act(() => {
      resolvePatch?.({
        message: systemRunSummaryMessage({
          id: "m-shared",
          runId: "run-shared",
          workflowStatus: "completed",
          shortResult: "Generated 1 test files; 1 tests proposed.",
        }),
      });
    });

    await waitFor(() => {
      expect(first.result.current.messages[0]?.workflowStatus).toBe("completed");
      expect(second.result.current.messages[0]?.workflowStatus).toBe("completed");
    });
  });
});
