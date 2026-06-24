// Issue #153 — workflow evidence remains visible in chat, but workflow launches live exclusively
// in the Agent widget surface.

import { render, renderHook, screen, waitFor } from "@testing-library/react";
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

  it("hides grounded workflow handoff for multi-source connected answers", () => {
    const launch = vi.fn().mockResolvedValue({ ok: true as const, runId: "run-99" });
    renderWindow(
      makeSession({
        activeChat: makeChat({
          connectedScopes: [
            { kind: "workspace-root", relativePaths: [], root: "/alpha", connectedAtMs: 1 },
            { kind: "workspace-root", relativePaths: [], root: "/beta", connectedAtMs: 2 },
          ],
        }),
        activeProject: makeProject(),
        models: [workflowEligibleModel("wf-model")],
        selectedModel: "wf-model",
        messages: [userMessage("hi")],
        latestGrounded: {
          ...connectedGroundedAnswer(),
          citations: [
            {
              stableId: "atom-1",
              scopePath: "README.md",
              lineRange: { startLine: 1, endLine: 2 },
              score: 0.9,
              source: "alpha",
            },
          ],
        },
        launchGroundedWorkflowHandoff: launch,
      }),
    );

    expect(screen.queryByRole("button", { name: /launch grounded workflow/i })).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("WorkflowHandoff — dialog edge cases and grounded input matrix", () => {
  it("keeps the workflow picker open on launch failure, supports Back, and closes on Escape", async () => {
    const user = userEvent.setup();
    const launch = vi
      .fn()
      .mockResolvedValue({ ok: false as const, reason: "request-failed", message: "gateway down" });
    render(<LaunchWorkflowButton selectedModel={workflowEligibleModel("wf-model")} launch={launch} />);

    await user.click(screen.getByRole("button", { name: /launch workflow/i }));
    const dialog = await screen.findByRole("dialog", { name: /launch workflow/i });
    await user.click(within(dialog).getByRole("button", { name: /generate unit tests/i }));
    await user.type(within(dialog).getByLabelText(/target file/i), "src/example.ts");
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("gateway down");
    await user.click(within(dialog).getByRole("button", { name: /^back$/i }));
    expect(within(dialog).getByRole("button", { name: /investigate bug/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /launch workflow/i })).toBeNull(),
    );
  });

  it("validates grounded unit-test targets and submits changed-files input with explicit checks", async () => {
    const user = userEvent.setup();
    const launch = vi.fn().mockResolvedValue({ ok: true as const, runId: "run-1" });
    render(
      <LaunchGroundedWorkflowButton
        answer={connectedGroundedAnswer()}
        modelId="wf-model"
        launch={launch}
      />,
    );

    await user.click(screen.getByRole("button", { name: /launch grounded workflow/i }));
    const dialog = await screen.findByRole("dialog", { name: /grounded workflow handoff/i });
    await user.click(within(dialog).getByRole("button", { name: /generate unit tests/i }));
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Provide a target file.");

    await chooseComboboxOption(user, within(dialog).getByLabelText(/target mode/i), "Module");
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Provide a module directory.",
    );

    await chooseComboboxOption(
      user,
      within(dialog).getByLabelText(/target mode/i),
      "Changed files",
    );
    await user.type(
      within(dialog).getByLabelText(/changed files \(one per line\)/i),
      "src/a.ts\nsrc/b.ts",
    );
    await user.type(
      within(dialog).getByLabelText(/editable paths \(explicit, workspace-relative, one per line\)/i),
      "tests/a.test.ts\ntests/b.test.ts",
    );
    await user.type(within(dialog).getByLabelText(/unknowns/i), "Confirm exported API");
    await user.click(within(dialog).getByRole("checkbox", { name: "tests" }));
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Select at least one expected check.",
    );

    await user.click(within(dialog).getByRole("checkbox", { name: "lint" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "manual" }));
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));

    await waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(launch).toHaveBeenCalledWith({
      assistantMessageId: "msg-a",
      modelId: "wf-model",
      workflowKind: "unit-test-generation",
      input: { target: { kind: "changedFiles", filePaths: ["src/a.ts", "src/b.ts"] } },
      editablePaths: ["tests/a.test.ts", "tests/b.test.ts"],
      expectedChecks: ["lint", "manual"],
      unknowns: ["Confirm exported API"],
    });
  });

  it("builds grounded bug-investigation input from description and suspected files", async () => {
    const user = userEvent.setup();
    const launch = vi.fn().mockResolvedValue({ ok: true as const, runId: "run-bug" });
    render(
      <LaunchGroundedWorkflowButton
        answer={connectedGroundedAnswer()}
        modelId="wf-model"
        launch={launch}
      />,
    );

    await user.click(screen.getByRole("button", { name: /launch grounded workflow/i }));
    const dialog = await screen.findByRole("dialog", { name: /grounded workflow handoff/i });
    await user.click(within(dialog).getByRole("button", { name: /investigate bug/i }));
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Provide at least a bug description or one suspected target file.",
    );

    await user.type(
      within(dialog).getByLabelText(/bug description/i),
      "Chat grounding loses a selected capsule after retry.",
    );
    await user.type(
      within(dialog).getByLabelText(/suspected target files/i),
      "src/chat.ts\nsrc/grounding.ts",
    );
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));

    await waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      workflowKind: "bug-investigation",
      input: {
        report: {
          description: "Chat grounding loses a selected capsule after retry.",
          targetFiles: ["src/chat.ts", "src/grounding.ts"],
        },
      },
      expectedChecks: ["verify"],
    });
  });

  it("builds grounded verification input and shows the default failure copy without backend detail", async () => {
    const user = userEvent.setup();
    const launch = vi.fn().mockResolvedValue({ ok: false as const, reason: "request-failed" });
    render(
      <LaunchGroundedWorkflowButton
        answer={connectedGroundedAnswer()}
        modelId="wf-model"
        launch={launch}
      />,
    );

    await user.click(screen.getByRole("button", { name: /launch grounded workflow/i }));
    const dialog = await screen.findByRole("dialog", { name: /grounded workflow handoff/i });
    await user.click(within(dialog).getByRole("button", { name: /run verification/i }));
    await user.type(within(dialog).getByLabelText(/target files/i), "src/app.ts, src/api.ts");
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));

    await waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      workflowKind: "verification",
      input: { targetFiles: ["src/app.ts", "src/api.ts"] },
      expectedChecks: ["verify"],
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Could not launch the grounded workflow.",
    );
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

  it("merges grounded handoff messages with the existing chat history", async () => {
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({
      messages: [userMessage("previous grounded turn", { id: "m-prev-grounded" })],
    });
    vi.spyOn(api, "startGroundedWorkflowHandoff").mockResolvedValue({
      run: { runId: "run-grounded", fingerprint: "fp" },
      messages: [
        userMessage("Requested grounded unit-test generation.", {
          id: "m-grounded-user",
          timestamp: 3,
        }),
        systemRunSummaryMessage({
          id: "m-grounded-system",
          runId: "run-grounded",
          timestamp: 4,
        }),
      ],
    });

    const { result } = renderHook(() => useChatSession());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.launchGroundedWorkflowHandoff({
        assistantMessageId: "msg-a",
        modelId: "wf-model",
        workflowKind: "unit-test-generation",
        input: { target: { kind: "file", filePath: "src/example.ts" } },
        editablePaths: ["tests/example.test.ts"],
        expectedChecks: ["tests"],
        unknowns: [],
      });
    });

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "m-prev-grounded",
      "m-grounded-user",
      "m-grounded-system",
    ]);
  });
});
