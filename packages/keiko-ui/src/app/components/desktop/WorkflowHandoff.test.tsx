// Issue #153 — governed workflow handoff from the Conversation Center.
//
// Pins all four AC sub-cases listed in the task spec, plus a structural
// AC #4 check (no apply / no exec affordance is exposed by the chat surface):
//
//   1. AC#2: launch affordance hidden when no workflow-eligible model is selected.
//   2. AC#2: launch affordance enabled when the selected model carries tool-call +
//            structured-output (the stricter chat+toolCalling+structuredOutput filter).
//   3. AC#1: clicking launch opens the workflow picker — explicit user action.
//   4. Workflow + free-text input → calls the launch action (startChatRun with
//      apply omitted/false). AC#3: the system run-summary message lands in chat.
//   5. AC#3: assistant/system pair renders with a RunSummaryCard that shows the
//            workflow id and status without exposing patch or shell affordances.
//   6. AC#4: the in-chat RunSummaryCard never renders "Apply patch" / shell exec
//            controls — those stay behind the existing workflow surfaces.
//
// The tests prop-inject a `ChatSessionApi` so we can drive the UI without booting
// the full network mock. The hook-level launchWorkflowFromConversation is covered
// indirectly: the WorkflowHandoff component calls the hook method via context,
// and a hook-level test pins the API-shape contract (#153 launch action) at the
// bottom of the file using renderHook + mocked @/lib/api.

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { useChatSession, type ChatSessionApi } from "./hooks/useChatSession";
import * as api from "@/lib/api";
import type { Chat, ChatMessage, ModelCapability, ProjectWithAvailability } from "@/lib/types";

// ─── helpers ──────────────────────────────────────────────────────────────────

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

function plainChatModel(id: string): ModelCapability {
  return { ...workflowEligibleModel(id), id, toolCalling: false, structuredOutput: false };
}

function userMessage(content: string): ChatMessage {
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
    launchWorkflowFromConversation: vi.fn().mockResolvedValue({ ok: true, runId: "run-42" }),
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

// ─── 1. AC #2: launch affordance hidden for non-workflow-eligible models ──────

describe("WorkflowHandoff — model gating (AC#2)", () => {
  it("hides the Launch workflow button when the selected model is plain chat (no tool calling)", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [plainChatModel("plain-chat")],
        selectedModel: "plain-chat",
        messages: [userMessage("hi")],
      }),
    );
    expect(screen.queryByRole("button", { name: /launch workflow/i })).toBeNull();
  });

  it("renders the Launch workflow button when the model carries chat+tool+structuredOutput", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [userMessage("hi")],
      }),
    );
    expect(screen.getByRole("button", { name: /launch workflow/i })).toBeInTheDocument();
  });
});

// ─── 2. AC #1: explicit user action opens the picker ─────────────────────────

describe("WorkflowHandoff — picker requires an explicit click (AC#1)", () => {
  it("does not auto-open the workflow picker on mount", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [userMessage("hi")],
      }),
    );
    expect(screen.queryByRole("dialog", { name: /launch workflow/i })).toBeNull();
  });

  it("opens the picker only when the user clicks Launch workflow", async () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [userMessage("hi")],
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /launch workflow/i }));
    expect(screen.getByRole("dialog", { name: /launch workflow/i })).toBeInTheDocument();
    // Both catalog workflows are offered.
    expect(screen.getByRole("button", { name: /generate unit tests/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /investigate bug/i })).toBeInTheDocument();
  });
});

// ─── 3. Selecting a workflow + input calls the launch action ─────────────────

describe("WorkflowHandoff — launch action (AC#1, AC#3)", () => {
  it("calls launchWorkflowFromConversation with the workflowId, user text, and the active model", async () => {
    const launch = vi.fn().mockResolvedValue({ ok: true as const, runId: "run-42" });
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [userMessage("hi")],
        launchWorkflowFromConversation: launch,
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /launch workflow/i }));
    await user.click(screen.getByRole("button", { name: /generate unit tests/i }));
    const textbox = await screen.findByLabelText(/target file/i);
    await user.type(textbox, "src/example.ts");
    await user.click(screen.getByRole("button", { name: /^launch$/i }));

    await waitFor(() => expect(launch).toHaveBeenCalledOnce());
    const call = launch.mock.calls[0]?.[0] as
      | { workflowId: string; modelId: string; text: string }
      | undefined;
    expect(call?.workflowId).toBe("unit-test-generation");
    expect(call?.modelId).toBe("wf-model");
    expect(call?.text).toBe("src/example.ts");
  });
});

// ─── 4. AC #3: system run-summary message renders as a RunSummaryCard ────────

describe("WorkflowHandoff — run summary rendering (AC#3)", () => {
  it("renders a system run-summary message as a RunSummaryCard with workflow id + status", () => {
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
    // The card carries a stable run-id slug for the user.
    expect(card).toHaveTextContent("run-42");
  });

  it("falls back to a 'queued' indicator when workflowStatus is missing", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [
          systemRunSummaryMessage({
            workflowStatus: undefined,
            content: "Launched: Generate unit tests",
          }),
        ],
      }),
    );
    const card = screen.getByTestId("run-summary-card");
    expect(card.getAttribute("data-status")).toBe("queued");
  });
});

// ─── 5. AC #4: the chat RunSummaryCard never exposes patch apply / shell exec ──

describe("WorkflowHandoff — patch/exec stay gated (AC#4)", () => {
  it("does not render an Apply patch or Run command affordance in the chat run card", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [systemRunSummaryMessage({ workflowStatus: "completed" })],
      }),
    );
    // Patch apply / exec are reserved for the gated workflow surfaces. The chat card
    // must never surface them — covered by AC#4.
    expect(screen.queryByRole("button", { name: /apply patch/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /run command/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /execute/i })).toBeNull();
  });
});

// ─── 6. Hook-level: launchWorkflowFromConversation drives /api/chats/runs ────

describe("useChatSession.launchWorkflowFromConversation (Issue #153)", () => {
  beforeEach(() => {
    vi.spyOn(api, "fetchModels").mockResolvedValue({ models: [workflowEligibleModel("wf-model")] });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({
      projects: [makeProject()],
    });
    vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [makeChat()] });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/chats/runs with apply omitted (dry-run only) and returns the runId", async () => {
    const startChatRun = vi.spyOn(api, "startChatRun").mockResolvedValue({
      run: { runId: "run-42", fingerprint: "fp" },
      messages: [userMessage("test draft"), systemRunSummaryMessage({ workflowStatus: "running" })],
    });

    const { result } = renderHook(() => useChatSession());
    // Wait for bootstrap to settle.
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { ok: true; runId: string } | { ok: false; reason: string } | undefined;
    await act(async () => {
      outcome = await result.current.launchWorkflowFromConversation({
        workflowId: "unit-test-generation",
        modelId: "wf-model",
        text: "src/example.ts",
      });
    });

    expect(outcome?.ok).toBe(true);
    expect(startChatRun).toHaveBeenCalledOnce();
    const body = startChatRun.mock.calls[0]?.[0];
    expect(body?.run.workflowId).toBe("unit-test-generation");
    expect(body?.run.modelId).toBe("wf-model");
    // AC#4: chat handoff never applies — apply is omitted (or strictly false).
    expect(body?.run.apply ?? false).toBe(false);
    // Chat row is preserved.
    expect(body?.chatId).toBe("chat-1");
  });

  it("rejects when the requested modelId is not workflow-eligible (AC#2)", async () => {
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [plainChatModel("plain")],
    });

    const startChatRun = vi.spyOn(api, "startChatRun");

    const { result } = renderHook(() => useChatSession());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { ok: true; runId: string } | { ok: false; reason: string } | undefined;
    await act(async () => {
      outcome = await result.current.launchWorkflowFromConversation({
        workflowId: "unit-test-generation",
        modelId: "plain",
        text: "src/example.ts",
      });
    });

    expect(outcome?.ok).toBe(false);
    expect(startChatRun).not.toHaveBeenCalled();
  });

  // WH-05 — hook error paths. Each asserts the exact discriminated reason and that
  // no run is started. Mutation note: these pin the guard branches at the top of
  // launchWorkflowFromConversation.
  it("returns reason 'missing-input' when the text is blank (WH-05)", async () => {
    const startChatRun = vi.spyOn(api, "startChatRun");
    const { result } = renderHook(() => useChatSession());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { ok: true; runId: string } | { ok: false; reason: string } | undefined;
    await act(async () => {
      outcome = await result.current.launchWorkflowFromConversation({
        workflowId: "unit-test-generation",
        modelId: "wf-model",
        text: "   ",
      });
    });

    expect(outcome).toEqual({ ok: false, reason: "missing-input" });
    expect(startChatRun).not.toHaveBeenCalled();
  });

  it("returns reason 'unknown-workflow' for an id absent from the catalog (WH-05)", async () => {
    const startChatRun = vi.spyOn(api, "startChatRun");
    const { result } = renderHook(() => useChatSession());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { ok: true; runId: string } | { ok: false; reason: string } | undefined;
    await act(async () => {
      outcome = await result.current.launchWorkflowFromConversation({
        workflowId: "this-workflow-does-not-exist",
        modelId: "wf-model",
        text: "src/example.ts",
      });
    });

    expect(outcome?.ok).toBe(false);
    expect(outcome).toMatchObject({ reason: "unknown-workflow" });
    expect(startChatRun).not.toHaveBeenCalled();
  });

  it("returns reason 'missing-chat' when no active chat exists (WH-05)", async () => {
    // No eligible model → bootstrap creates no chat, leaving activeChat undefined.
    // missing-chat is checked before model eligibility, so we still reach it.
    vi.spyOn(api, "fetchModels").mockResolvedValue({ models: [] });
    vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [] });
    const startChatRun = vi.spyOn(api, "startChatRun");

    const { result } = renderHook(() => useChatSession());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeChat).toBeUndefined();

    let outcome: { ok: true; runId: string } | { ok: false; reason: string } | undefined;
    await act(async () => {
      outcome = await result.current.launchWorkflowFromConversation({
        workflowId: "unit-test-generation",
        modelId: "wf-model",
        text: "src/example.ts",
      });
    });

    expect(outcome).toMatchObject({ reason: "missing-chat" });
    expect(startChatRun).not.toHaveBeenCalled();
  });
});
