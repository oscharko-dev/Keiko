// Issue #146 — Redesign Conversation Center composer and empty state.
// Tests cover the Issue #146 acceptance criteria and empty-state deliverables.
//
// IMPORTANT: no module-level vi.mock("@/lib/api", ...) — per architecture
// invariant that rule pollutes capsule-actions.test.tsx. All session deps are
// injected via the ChatSessionProvider prop (prop-injection pattern).

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat, ModelCapability, ProjectWithAvailability } from "@/lib/types";
import { isConversationEligibleModel } from "@/lib/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/proj",
    title: "Test chat",
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
    name: "my-project",
    available: true,
    favorite: false,
    createdAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  };
}

function chatModelCapability(id: string): ModelCapability {
  const cap: ModelCapability = {
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
  // Verify isConversationEligibleModel accepts this fixture (static import, no mock).
  expect(isConversationEligibleModel(cap)).toBe(true);
  return cap;
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

// ── AC #1 — voice button is absent everywhere ─────────────────────────────────

describe("AC #1 — voice button removal", () => {
  it("does not render a voice button by role", () => {
    renderWindow(makeSession({ activeChat: makeChat() }));
    expect(screen.queryByRole("button", { name: /voice/i })).toBeNull();
  });

  it("does not render an element with a voice aria-label", () => {
    renderWindow(makeSession({ activeChat: makeChat() }));
    expect(screen.queryByLabelText(/voice/i)).toBeNull();
  });

  it("voice button is absent even when loading", () => {
    renderWindow(makeSession({ loading: true, activeChat: makeChat() }));
    expect(screen.queryByRole("button", { name: /voice/i })).toBeNull();
  });

  it("voice button is absent even when noEligibleModels", () => {
    renderWindow(makeSession({ noEligibleModels: true, selectedModel: undefined }));
    expect(screen.queryByRole("button", { name: /voice/i })).toBeNull();
  });
});

// ── AC #2 — disabled controls explain what is missing ────────────────────────

describe("AC #2 — disabled controls aria-describedby", () => {
  it("no-model select remains focusable and references the NoModelAlert id", () => {
    renderWindow(
      makeSession({
        noEligibleModels: true,
        selectedModel: undefined,
        activeChat: makeChat(),
      }),
    );
    const select = screen.getByLabelText("Model");
    expect(select).not.toHaveAttribute("disabled");
    expect(select).toHaveAttribute("aria-disabled", "true");
    const describedById = select.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    // The referenced element must exist and contain the alert text.
    const alertEl = document.getElementById(describedById ?? "");
    expect(alertEl).not.toBeNull();
    expect(alertEl?.getAttribute("role")).toBe("alert");
  });

  it("send button references the NoModelAlert id when noEligibleModels", () => {
    renderWindow(
      makeSession({
        noEligibleModels: true,
        selectedModel: undefined,
        activeChat: makeChat(),
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
    const sendBtn = screen.getByRole("button", { name: "Send message" });
    const describedById = sendBtn.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const alertEl = document.getElementById(describedById ?? "");
    expect(alertEl?.getAttribute("role")).toBe("alert");
  });

  it("send button references a 'Type a message to send' hint when only draft is empty", () => {
    renderWindow(
      makeSession({
        noEligibleModels: false,
        selectedModel: "example-chat-model",
        draft: "",
        loading: false,
        sending: false,
        activeChat: makeChat(),
        models: [chatModelCapability("example-chat-model")],
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
    const sendBtn = screen.getByRole("button", { name: "Send message" });
    expect(sendBtn).not.toHaveAttribute("disabled");
    expect(sendBtn).toHaveAttribute("aria-disabled", "true");
    const describedById = sendBtn.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const hintEl = document.getElementById(describedById ?? "");
    expect(hintEl).not.toBeNull();
    expect(hintEl?.textContent).toMatch(/type a message/i);
  });

  it("send button stays focusable and points to the loading status while bootstrapping", () => {
    renderWindow(
      makeSession({
        draft: "hello",
        loading: true,
        sending: false,
        activeChat: makeChat(),
        selectedModel: "example-chat-model",
        models: [chatModelCapability("example-chat-model")],
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
    const sendBtn = screen.getByRole("button", { name: "Send message" });
    expect(sendBtn).not.toHaveAttribute("disabled");
    expect(sendBtn).toHaveAttribute("aria-disabled", "true");
    expect(sendBtn).toHaveAttribute("title", "Connecting to your gateway");
    const describedById = sendBtn.getAttribute("aria-describedby");
    expect(describedById).toBe("cmp-loading-status");
    expect(document.getElementById(describedById ?? "")).toHaveTextContent(
      /connecting to your gateway/i,
    );
  });
});

// ── AC #3 — long setup / model-loading state ─────────────────────────────────

describe("AC #3 — loading state", () => {
  it("renders a role=status element with 'Connecting' or 'Loading' text while loading", () => {
    renderWindow(makeSession({ loading: true, activeChat: makeChat() }));
    // uiux-fix F041 (C170) — the send-lifecycle status region is now permanently
    // mounted (empty while idle), so the loading indicator is one of several
    // role=status regions rather than the only one.
    const statusEls = screen.getAllByRole("status");
    expect(statusEls.some((el) => /connecting|loading/i.test(el.textContent ?? ""))).toBe(true);
  });

  it("renders a 'Loading models…' option in the select while loading", () => {
    renderWindow(makeSession({ loading: true, activeChat: makeChat() }));
    // The loading option is disabled — query by text directly.
    const options = screen
      .getAllByRole("option")
      .filter((opt) => /loading models/i.test(opt.textContent ?? ""));
    expect(options.length).toBeGreaterThanOrEqual(1);
  });

  it("announces no status text once loading is false (lifecycle region stays mounted, empty)", () => {
    renderWindow(
      makeSession({
        loading: false,
        activeChat: makeChat(),
        models: [chatModelCapability("example-chat-model")],
      }),
    );
    // uiux-fix F041 (C170) — the persistent send-lifecycle live region remains in
    // the DOM but must be empty; the loading indicator itself must be gone.
    expect(screen.queryByText(/connecting to your gateway/i)).toBeNull();
    for (const statusEl of screen.queryAllByRole("status")) {
      expect(statusEl).toBeEmptyDOMElement();
    }
  });
});

// ── Deliverable — empty state variations ─────────────────────────────────────

describe("Deliverable — empty state (no messages, no active chat)", () => {
  it("instructs the user to pick a chat when activeChat is undefined", () => {
    renderWindow(makeSession({ activeChat: undefined, messages: [] }));
    // Should find text about picking or starting a chat from sidebar.
    expect(screen.getByText(/pick or start a chat/i)).toBeInTheDocument();
    expect(screen.getByText(/select a conversation from the project sidebar/i)).toBeInTheDocument();
  });
});

describe("Deliverable — empty state (no messages, active chat set)", () => {
  it("shows a welcoming headline when activeChat is defined", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [],
        models: [chatModelCapability("example-chat-model")],
      }),
    );
    expect(screen.getByText(/start a keiko conversation/i)).toBeInTheDocument();
  });

  it("shows 2 or 3 starter prompt buttons", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [],
        models: [chatModelCapability("example-chat-model")],
      }),
    );
    // Starter prompts are rendered as buttons inside the chatw-empty-prompts list.
    const promptsList = document.querySelector(".chatw-empty-prompts");
    expect(promptsList).not.toBeNull();
    const promptBtns = within(promptsList as HTMLElement).getAllByRole("button");
    expect(promptBtns.length).toBeGreaterThanOrEqual(2);
    expect(promptBtns.length).toBeLessThanOrEqual(3);
  });

  it("includes the project name in prompts when activeProject is set", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        activeProject: makeProject({ name: "my-project" }),
        messages: [],
        models: [chatModelCapability("example-chat-model")],
      }),
    );
    const promptsList = document.querySelector(".chatw-empty-prompts");
    expect(promptsList).not.toBeNull();
    const btns = within(promptsList as HTMLElement).getAllByRole("button");
    const texts = btns.map((b) => b.textContent ?? "");
    expect(texts.some((t) => t.includes("my-project"))).toBe(true);
  });

  it("clicking a starter prompt calls setDraft with the prompt text", async () => {
    const setDraft = vi.fn();
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [],
        models: [chatModelCapability("example-chat-model")],
        setDraft,
      }),
    );
    const promptsList = document.querySelector(".chatw-empty-prompts");
    expect(promptsList).not.toBeNull();
    const firstPrompt = within(promptsList as HTMLElement).getAllByRole("button")[0];
    expect(firstPrompt).toBeDefined();
    await user.click(firstPrompt!);
    expect(setDraft).toHaveBeenCalledOnce();
    const calledWith: unknown = setDraft.mock.calls[0]?.[0];
    expect(typeof calledWith).toBe("string");
    expect((calledWith as string).length).toBeGreaterThan(0);
  });

  it("does not render starter prompts when noEligibleModels is true", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [],
        noEligibleModels: true,
        selectedModel: undefined,
      }),
    );
    const promptsList = document.querySelector(".chatw-empty-prompts");
    expect(promptsList).toBeNull();
  });
});

// ── AC #4 — keyboard and screen-reader preservation ──────────────────────────

describe("AC #4 — keyboard and screen-reader preservation", () => {
  it("tab order visits textarea, model select, then send button in the footer composer", async () => {
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        draft: "hello",
        loading: false,
        sending: false,
        noEligibleModels: false,
        selectedModel: "example-chat-model",
        models: [chatModelCapability("example-chat-model")],
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
    // Focus the body first, then tab through the elements.
    (document.body as HTMLElement).focus();
    await user.tab();
    // Merge-resolution note (PR #355 + Epic #142): the merged ChatScopeHeader
    // unconditionally renders a Grounding <select> above the message log even
    // when no scope is bound. Skip past any pre-composer elements until we
    // reach the composer textarea — that is the element this AC pins.
    let pre = 0;
    while (document.activeElement?.tagName.toLowerCase() !== "textarea" && pre < 20) {
      await user.tab();
      pre++;
    }
    const focused = document.activeElement;
    expect(focused?.tagName.toLowerCase()).toBe("textarea");

    await user.tab();
    // Next is a button (attach), then mode button, then model select.
    // Tab until we hit the select.
    let iterations = 0;
    while (document.activeElement?.tagName.toLowerCase() !== "select" && iterations < 10) {
      await user.tab();
      iterations++;
    }
    expect(document.activeElement?.tagName.toLowerCase()).toBe("select");

    // After the select the send button is the next interactive element.
    await user.tab();
    // May hit spacer or other buttons — keep tabbing until we find send.
    iterations = 0;
    while (
      document.activeElement?.getAttribute("aria-label") !== "Send message" &&
      iterations < 10
    ) {
      await user.tab();
      iterations++;
    }
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Send message");
  });

  it("send button has cmp-send class (enabling :focus-visible ring via CSS)", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
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
    const sendBtn = screen.getByRole("button", { name: "Send message" });
    expect(sendBtn.classList.contains("cmp-send")).toBe(true);
  });

  it("starter prompt buttons have focusable class with suggest (enabling :focus-visible ring)", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [],
        models: [chatModelCapability("example-chat-model")],
      }),
    );
    const promptsList = document.querySelector(".chatw-empty-prompts");
    expect(promptsList).not.toBeNull();
    const btns = within(promptsList as HTMLElement).getAllByRole("button");
    btns.forEach((btn) => {
      expect(btn.classList.contains("suggest")).toBe(true);
    });
  });

  it("NoModelAlert is role=alert and its id is stable", () => {
    renderWindow(
      makeSession({
        noEligibleModels: true,
        selectedModel: undefined,
        activeChat: makeChat(),
      }),
    );
    const alert = screen.getByRole("alert");
    expect(alert.id).toBe("cmp-no-model-alert");
  });
});

// ── Regression — existing 286 tests still pass ───────────────────────────────
// (verified by running vitest; no explicit test needed here — the suite runs
// all files and the prior ChatWindow.test.tsx tests are unmodified)
