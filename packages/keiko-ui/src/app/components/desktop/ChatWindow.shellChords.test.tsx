// Audit — the shell chords must reach the chat composer, the product's primary input.
//
// `useKeyboardShortcuts`' editable-target guard suppresses every chord inside a text field, so
// Cmd/Ctrl+P, Cmd/Ctrl+Shift+P and Cmd/Ctrl+Shift+F were dead while the cursor sat in the composer.
// The composer now carries the substrate's opt-in marker, and this suite exercises the whole path:
// the REAL composer textarea, the REAL shell binding table (`resolveShellShortcutState`), and the
// REAL substrate — so it fails if either half of the seam is removed.
//
// It also pins the other half of the rule: Cmd/Ctrl+Z stays with the field (it means "undo my
// typing"), and no bare arrow/plain key is stolen from the caret.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { resolveShellShortcutState } from "./shellShortcutState";
import { SHELL_CHORD_BYPASS_ATTRIBUTE, useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchFilesSearch: vi.fn(), updateChat: vi.fn() };
});

vi.mock("@/lib/local-knowledge-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-knowledge-api")>();
  return {
    ...actual,
    fetchCapsules: vi.fn(async () => ({ capsules: [] })),
    fetchCapsuleSets: vi.fn(async () => ({ capsuleSets: [] })),
  };
});

function makeChat(): Chat {
  return {
    id: "chat-1",
    projectPath: "/repo",
    title: "t",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
  };
}

function makeSession(): ChatSessionApi {
  return {
    projects: [],
    chats: [],
    messages: [],
    models: [],
    activeProject: undefined,
    activeChat: makeChat(),
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
  };
}

// Mirrors the AppShell wiring: the live shell binding table dispatched through the substrate.
function ShellChordHarness({
  dispatch,
}: {
  readonly dispatch: (commandId: string) => void;
}): ReactElement {
  useKeyboardShortcuts({
    bindings: resolveShellShortcutState([]).bindings,
    dispatch,
    platform: "mac",
  });
  return (
    <ChatSessionProvider value={makeSession()}>
      <ChatWindow />
    </ChatSessionProvider>
  );
}

function composer(): HTMLElement {
  return screen.getByRole("textbox", { name: "Chat message" });
}

describe("chat composer — shell chord dispatch (audit)", () => {
  it("opts into shell chord dispatch through the substrate's own marker", () => {
    render(<ShellChordHarness dispatch={vi.fn()} />);

    expect(composer()).toHaveAttribute(SHELL_CHORD_BYPASS_ATTRIBUTE);
  });

  it("dispatches Cmd+P, Cmd+Shift+P and Cmd+Shift+F from inside the composer", () => {
    const dispatch = vi.fn();
    render(<ShellChordHarness dispatch={dispatch} />);
    const input = composer();
    input.focus();

    fireEvent.keyDown(input, { key: "p", metaKey: true });
    fireEvent.keyDown(input, { key: "p", metaKey: true, shiftKey: true });
    fireEvent.keyDown(input, { key: "f", metaKey: true, shiftKey: true });

    expect(dispatch.mock.calls.map(([id]) => id)).toEqual([
      "quick-access.files",
      "quick-access.commands",
      "focus-workspace-search",
    ]);
  });

  it("leaves Cmd+Z with the composer so it undoes the user's typing", () => {
    const dispatch = vi.fn();
    render(<ShellChordHarness dispatch={dispatch} />);
    const input = composer();
    input.focus();

    fireEvent.keyDown(input, { key: "z", metaKey: true });
    fireEvent.keyDown(input, { key: "z", metaKey: true, shiftKey: true });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never steals a plain key from the caret", () => {
    const dispatch = vi.fn();
    render(<ShellChordHarness dispatch={dispatch} />);
    const input = composer();
    input.focus();

    fireEvent.keyDown(input, { key: "p" });
    fireEvent.keyDown(input, { key: "f", shiftKey: true });

    expect(dispatch).not.toHaveBeenCalled();
  });
});
