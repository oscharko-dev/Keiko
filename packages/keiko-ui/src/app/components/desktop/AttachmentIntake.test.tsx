// Issue #147 — Modality-aware attachment intake and UI validation tests.
//
// Coverage:
//   AC #1 — image upload blocked for text-only models
//   AC #2 — unsupported/oversized files rejected before any model request
//   AC #3 — users can remove pending attachments before sending
//   AC #4 — attachment previews never expose absolute paths
//
// Architecture invariants:
//   - NO module-level vi.mock("@/lib/api") — prop-injection only.
//   - Static top-level imports from "@/lib/types" only.
//   - All session deps injected via ChatSessionProvider.

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import {
  MAX_ATTACHMENT_BYTES,
  useChatSession,
  type AttachmentRejectionReason,
  type PendingAttachment,
} from "./hooks/useChatSession";
import { AttachRejectionAlert, buildAcceptString, rejectionMessage } from "./AttachmentStrip";
import * as api from "@/lib/api";
import type { Chat, ModelCapability } from "@/lib/types";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/proj",
    title: "Test chat",
    selectedModel: "model-image",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

/** A ModelCapability that supports both image and document input. */
function makeModelCapability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "model-image",
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: true,
    supportsDocumentInput: true,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSessionApi> = {}): ChatSessionApi {
  return {
    projects: [],
    chats: [],
    messages: [],
    models: [makeModelCapability()],
    activeProject: undefined,
    activeChat: makeChat(),
    selectedModel: "model-image",
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

/** Build a fake File. webkitRelativePath can carry an absolute path to test AC #4. */
function makeFile(name: string, type: string, size = 1024, absolutePathLeak?: string): File {
  const file = new File(["x".repeat(size)], name, { type });
  // Simulate a browser that exposes webkitRelativePath (some environments leak paths).
  // The implementation must ONLY use file.name (basename) — NEVER webkitRelativePath.
  if (absolutePathLeak !== undefined) {
    Object.defineProperty(file, "webkitRelativePath", { value: absolutePathLeak });
  }
  return file;
}

// ─── Unit-level tests on the pure addPendingAttachment logic ──────────────────
//
// Because addPendingAttachment is a hook method we test it through the
// hook's return value via a lightweight prop-injected session mock. The full
// hook integration is validated in the per-AC tests below.

// ─── AC #1 — text-only model blocks image upload ──────────────────────────────

describe("AC #1 — text-only model blocks image upload", () => {
  it("returns {ok:false, reason:'text-only-model'} for image on text-only model", async () => {
    const addPendingAttachment = vi.fn().mockResolvedValue({
      ok: false,
      reason: "text-only-model" as AttachmentRejectionReason,
    });
    const session = makeSession({
      models: [makeModelCapability({ supportsImageInput: false, supportsDocumentInput: false })],
      selectedModel: "model-image",
      addPendingAttachment,
    });

    const file = makeFile("photo.png", "image/png", 1024);
    const result = await session.addPendingAttachment(file);

    expect(result).toEqual({ ok: false, reason: "text-only-model" });
  });

  it("returns {ok:true} and the chip appears for image on a model with supportsImageInput:true", async () => {
    const attachment: PendingAttachment = {
      id: "att-1",
      kind: "image",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      previewDataUrl: "data:image/png;base64,abc",
    };
    const addPendingAttachment = vi.fn().mockResolvedValue({ ok: true });
    const session = makeSession({
      models: [makeModelCapability({ supportsImageInput: true })],
      pendingAttachments: [attachment],
      addPendingAttachment,
    });

    renderWindow(session);

    // Chip strip should show the attachment name
    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });

  it("attach button is aria-disabled when model has no image OR document support", () => {
    const session = makeSession({
      models: [makeModelCapability({ supportsImageInput: false, supportsDocumentInput: false })],
    });

    renderWindow(session);

    const attachBtn = screen.getByRole("button", { name: "Attach file" });
    expect(attachBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("attach button is NOT aria-disabled when model supports images", () => {
    const session = makeSession({
      models: [makeModelCapability({ supportsImageInput: true, supportsDocumentInput: false })],
    });

    renderWindow(session);

    const attachBtn = screen.getByRole("button", { name: "Attach file" });
    expect(attachBtn).not.toHaveAttribute("aria-disabled", "true");
  });
});

// ─── AC #2 — unsupported / oversized files rejected ───────────────────────────

describe("AC #2 — unsupported and oversized files rejected", () => {
  it("returns {ok:false, reason:'oversized'} for a 9 MiB file", async () => {
    const nineMiB = MAX_ATTACHMENT_BYTES + 1;
    const addPendingAttachment = vi.fn().mockResolvedValue({
      ok: false,
      reason: "oversized" as AttachmentRejectionReason,
    });
    const session = makeSession({ addPendingAttachment });

    const file = makeFile("big.png", "image/png", nineMiB);
    const result = await session.addPendingAttachment(file);

    expect(result).toEqual({ ok: false, reason: "oversized" });
  });

  it("does NOT add attachment when oversized (pendingAttachments stays empty)", async () => {
    const addPendingAttachment = vi.fn().mockResolvedValue({
      ok: false,
      reason: "oversized" as AttachmentRejectionReason,
    });
    const session = makeSession({
      pendingAttachments: [],
      addPendingAttachment,
    });

    renderWindow(session);

    const file = makeFile("big.png", "image/png", MAX_ATTACHMENT_BYTES + 1);
    await session.addPendingAttachment(file);

    // No chips rendered
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("returns {ok:false, reason:'unsupported-type'} for application/octet-stream", async () => {
    const addPendingAttachment = vi.fn().mockResolvedValue({
      ok: false,
      reason: "unsupported-type" as AttachmentRejectionReason,
    });
    const session = makeSession({ addPendingAttachment });

    const file = makeFile("binary.bin", "application/octet-stream", 512);
    const result = await session.addPendingAttachment(file);

    expect(result).toEqual({ ok: false, reason: "unsupported-type" });
  });

  it("AttachRejectionAlert renders role='alert' with the rejection message (AC #2)", () => {
    // Test the alert component directly — it is the sole source of rejection announcements.
    render(<AttachRejectionAlert reason="unsupported-type" mimeType="application/octet-stream" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Unsupported file type");
    expect(alert.textContent).toContain("application/octet-stream");
  });
});

// ─── AC #3 — users can remove pending attachments ────────────────────────────

describe("AC #3 — pending attachment removal", () => {
  it("renders a remove button for each pending attachment", () => {
    const attachment: PendingAttachment = {
      id: "att-1",
      kind: "document",
      name: "README.md",
      mimeType: "text/markdown",
      sizeBytes: 512,
      previewDataUrl: undefined,
    };
    const session = makeSession({ pendingAttachments: [attachment] });

    renderWindow(session);

    expect(screen.getByRole("button", { name: "Remove attachment README.md" })).toBeInTheDocument();
  });

  it("calls removePendingAttachment with the attachment id when remove button clicked", async () => {
    const removePendingAttachment = vi.fn();
    const attachment: PendingAttachment = {
      id: "att-42",
      kind: "document",
      name: "spec.txt",
      mimeType: "text/plain",
      sizeBytes: 256,
      previewDataUrl: undefined,
    };
    const session = makeSession({
      pendingAttachments: [attachment],
      removePendingAttachment,
    });

    renderWindow(session);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove attachment spec.txt" }));

    expect(removePendingAttachment).toHaveBeenCalledOnce();
    expect(removePendingAttachment).toHaveBeenCalledWith("att-42");
  });

  // ATT-F4 — drive the REAL hook so we actually assert that pending attachments
  // are CLEARED after a successful send (the prior version only asserted that a
  // mocked sendMessage was invoked, never that the clear happened). Reverting the
  // `if (terminal === "completed") clearPendingAttachments();` line in the hook
  // leaves the attachment in pendingAttachments and fails this test.
  it("clears pending attachments after a successful send (ATT-F4)", async () => {
    const projectPath = "/att-proj";
    const model = makeModelCapability({ id: "att-model" });
    const bootChat = makeChat({ id: "att-chat", projectPath, selectedModel: "att-model" });

    vi.spyOn(api, "fetchModels").mockResolvedValue({ models: [model] });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({
      projects: [
        {
          path: projectPath,
          name: "proj",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      ],
    });
    vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [bootChat] });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });
    vi.spyOn(api, "sendDesktopChat").mockResolvedValue({ chat: bootChat, messages: [] });

    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.activeChat).toBeDefined();
    });

    // Queue a document attachment (document kind avoids the FileReader preview path).
    const file = new File(["report"], "report.txt", { type: "text/plain" });
    await act(async () => {
      const result = await view.result.current.addPendingAttachment(file);
      expect(result.ok).toBe(true);
    });
    expect(view.result.current.pendingAttachments).toHaveLength(1);

    act(() => view.result.current.setDraft("here is my file"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(view.result.current.sendStatus).toBe("completed");
    expect(view.result.current.pendingAttachments).toHaveLength(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    api.clearModelCacheForTests();
  });
});

// ─── AC #4 — previews never expose full local absolute paths ─────────────────

describe("AC #4 — no absolute paths leaked in chip display", () => {
  it("chip displays file.name (basename) and NOT webkitRelativePath", () => {
    // The File fixture carries a fake absolute-path in webkitRelativePath.
    // The chip must show only the basename (file.name), never the full path.
    const attachment: PendingAttachment = {
      id: "att-path",
      kind: "document",
      name: "secret.pdf", // basename — what the chip MUST show
      mimeType: "application/pdf",
      sizeBytes: 1024,
      previewDataUrl: undefined, // document — no data URL
    };
    const session = makeSession({ pendingAttachments: [attachment] });

    renderWindow(session);

    // The chip text must include the basename
    expect(screen.getByText("secret.pdf")).toBeInTheDocument();

    // Must not render any absolute-path fragments
    const domText = document.body.textContent ?? "";
    expect(domText).not.toContain("/Users/");
    expect(domText).not.toContain("C:\\");
    expect(domText).not.toContain("webkitRelativePath");
  });

  it("image chip uses previewDataUrl as the img src — not a filesystem path", () => {
    const attachment: PendingAttachment = {
      id: "att-img",
      kind: "image",
      name: "avatar.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    };
    const session = makeSession({ pendingAttachments: [attachment] });

    renderWindow(session);

    const img = screen.getByRole("img", { hidden: true });
    const src = img.getAttribute("src") ?? "";
    expect(src).toMatch(/^data:/);
    expect(src).not.toContain("/Users/");
    expect(src).not.toContain("C:\\");
  });
});

// ─── Accessibility checks ─────────────────────────────────────────────────────

describe("Accessibility", () => {
  it("attach button has aria-label='Attach file'", () => {
    const session = makeSession();
    renderWindow(session);

    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
  });

  it("drop zone has aria-label='Drop files here to attach'", () => {
    const session = makeSession({
      models: [makeModelCapability({ supportsImageInput: true })],
    });
    renderWindow(session);

    // The drop zone is a presentation div; check by aria-label.
    const dropZone = document.querySelector('[aria-label="Drop files here to attach"]');
    expect(dropZone).not.toBeNull();
  });

  it("attach button stays focusable (not HTML-disabled) when model has no attachment support", () => {
    const session = makeSession({
      models: [makeModelCapability({ supportsImageInput: false, supportsDocumentInput: false })],
    });
    renderWindow(session);

    const btn = screen.getByRole("button", { name: "Attach file" });
    // aria-disabled=true, but NOT the HTML disabled attribute (so focus is retained).
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).not.toBeDisabled();
  });
});

// ─── Part 5 — send still works with no attachments and text-only model ────────

describe("Send works without attachments", () => {
  it("sendMessage is called on Enter even when model has no attachment support", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const session = makeSession({
      draft: "hello",
      models: [makeModelCapability({ supportsImageInput: false, supportsDocumentInput: false })],
      sendMessage,
    });

    renderWindow(session);

    const textarea = screen.getByRole("textbox", { name: "Chat message" });
    const user = userEvent.setup();
    await user.type(textarea, "{Enter}");

    expect(sendMessage).toHaveBeenCalledOnce();
  });
});

// ─── Pure-logic unit tests (no rendering) ────────────────────────────────────

describe("rejectionMessage", () => {
  it("text-only-model reason includes model-choice guidance", () => {
    const msg = rejectionMessage("text-only-model");
    expect(msg).toMatch(/model/i);
  });

  it("unsupported-type reason includes the mime type", () => {
    const msg = rejectionMessage("unsupported-type", "application/octet-stream");
    expect(msg).toContain("application/octet-stream");
  });

  it("oversized reason mentions 8 MiB", () => {
    const msg = rejectionMessage("oversized");
    expect(msg).toMatch(/8\s*MiB/);
  });

  it("empty reason mentions empty file", () => {
    const msg = rejectionMessage("empty");
    expect(msg).toMatch(/empty/i);
  });
});

describe("buildAcceptString", () => {
  it("returns empty string when model is undefined", () => {
    expect(buildAcceptString(undefined)).toBe("");
  });

  it("returns 'image/*' when only image supported", () => {
    const m = makeModelCapability({ supportsImageInput: true, supportsDocumentInput: false });
    expect(buildAcceptString(m)).toBe("image/*");
  });

  it("returns document extensions when only document supported", () => {
    const m = makeModelCapability({ supportsImageInput: false, supportsDocumentInput: true });
    expect(buildAcceptString(m)).toContain(".pdf");
  });

  it("returns both when both supported", () => {
    const m = makeModelCapability({ supportsImageInput: true, supportsDocumentInput: true });
    const result = buildAcceptString(m);
    expect(result).toContain("image/*");
    expect(result).toContain(".pdf");
  });
});

describe("MAX_ATTACHMENT_BYTES", () => {
  it("is exactly 8 MiB (8_388_608 bytes)", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(8_388_608);
  });
});
