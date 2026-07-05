// GEN-UI-TEST-GAP-002 (ChatWindow) — jest-axe smoke test for the desktop chat
// window. Renders a minimal idle / empty conversation and asserts the composed
// accessibility tree has no WCAG 2.2 AA violations. jsdom has no layout, so this
// covers role/name/aria wiring (the axe checks that survive jsdom); focus-ring
// visibility and other layout-dependent rules are covered by the browser gate.
//
// The harness (mocks + factories) mirrors ChatWindow.test.tsx because those
// helpers are not exported; keep the two in sync when the render contract moves.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow, clearKnowledgeCatalogCacheForTests } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat } from "@/lib/types";
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

vi.mock("@/lib/local-knowledge-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-knowledge-api")>();
  return {
    ...actual,
    fetchCapsules: vi.fn(async () => ({ capsules: [] })),
    fetchCapsuleSets: vi.fn(async () => ({ capsuleSets: [] })),
  };
});

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
  props: ComponentProps<typeof ChatWindow> = {},
): ReturnType<typeof render> {
  return render(
    <ChatSessionProvider value={session}>
      <ChatWindow {...props} />
    </ChatSessionProvider>,
  );
}

// The @-mention picker only opens on textarea change/select events, so opening
// it in a test needs a draft that actually updates in the DOM.
function renderStatefulWindow(session: ChatSessionApi): ReturnType<typeof render> {
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
        <ChatWindow />
      </ChatSessionProvider>
    );
  }
  return render(<StatefulWindow />);
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

describe("ChatWindow a11y", () => {
  it("jest-axe: idle empty conversation has no violations", async () => {
    const { container } = renderWindow(makeSession({ activeChat: makeChat(), draft: "" }));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: composer with a draft and eligible model has no violations", async () => {
    const { container } = renderWindow(
      makeSession({
        activeChat: makeChat(),
        draft: "Hello Keiko",
        models: [
          {
            id: "example-chat-model",
            supportsImageInput: false,
            supportsDocumentInput: false,
          } as ChatSessionApi["models"][number],
        ],
      }),
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // GEN-UI-A11Y-001 — combobox relationships survive an axe run even with the
  // @-mention picker open (aria-controls / aria-activedescendant idrefs resolve).
  it("jest-axe: open @-mention combobox has no violations and wires idrefs", async () => {
    const user = userEvent.setup();
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
          rootKind: "selected-root",
        },
      ],
      truncated: false,
      scannedFileCount: 10,
    });
    const existingScope = {
      kind: "files" as const,
      root: "/repo",
      relativePaths: ["src/a.ts"],
      connectedAtMs: 1,
    };
    const { container } = renderStatefulWindow(
      makeSession({
        activeChat: makeChat({
          projectPath: "/repo",
          connectedScopes: [existingScope],
          connectedScope: existingScope,
        }),
        draft: "",
      }),
    );

    const textbox = screen.getByRole("textbox", { name: "Chat message" });
    await user.type(textbox, "@coding");

    const combobox = await screen.findByRole("combobox", { name: "Chat message" });
    const listbox = await screen.findByRole("listbox", { name: "Repository file results" });
    await waitFor(() => {
      expect(combobox).toHaveAttribute("aria-controls", listbox.id);
    });
    const option = screen.getByRole("option", {
      name: "Reference src/context/coding-context.ts",
    });
    // The listbox idrefs must resolve so axe's aria-valid-attr-value passes.
    expect(textbox).toHaveAttribute("aria-activedescendant", option.id);

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
