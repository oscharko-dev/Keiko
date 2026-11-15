// GEN-UI-TEST-GAP-002 (ChatWindow) — jest-axe smoke test for the desktop chat
// window. Renders a minimal idle / empty conversation and asserts the composed
// accessibility tree has no WCAG 2.2 AA violations. jsdom has no layout, so this
// covers role/name/aria wiring (the axe checks that survive jsdom); focus-ring
// visibility and other layout-dependent rules are covered by the browser gate.
//
// The harness (mocks + factories) mirrors ChatWindow.test.tsx because those
// helpers are not exported; keep the two in sync when the render contract moves.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow, clearKnowledgeCatalogCacheForTests } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat, ChatMessage, ProjectWithAvailability } from "@/lib/types";
import { fetchFilesSearch, updateChat } from "@/lib/api";
import { fetchCapsules, fetchCapsuleSets } from "@/lib/local-knowledge-api";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";

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

function makeProject(path: string): ProjectWithAvailability {
  return {
    path,
    name: "Project",
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 2,
    available: true,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    chatId: "chat-1",
    role: "assistant",
    content: "Answer",
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
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

  it("jest-axe: assistant code copy control has no violations", async () => {
    const workspaceRoot = "/workspace/exact";
    const { container } = renderWindow(
      makeSession({
        activeProject: makeProject(workspaceRoot),
        activeChat: makeChat({ projectPath: workspaceRoot }),
        messages: [
          makeMessage({ content: "```diff\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n```" }),
        ],
      }),
    );

    expect(screen.queryByRole("button", { name: "Apply to editor" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy code block" })).toBeInTheDocument();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: response-version selector has no violations", async () => {
    const { container } = renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          makeMessage({
            content: "Current answer",
            timestamp: 20,
            responseVersion: 2,
            supersedesResponseVersion: 1,
            responseVersions: [
              { version: 1, content: "Original answer", timestamp: 10 },
              {
                version: 2,
                content: "Current answer",
                timestamp: 20,
                supersedesVersion: 1,
              },
            ],
          }),
        ],
      }),
    );

    expect(screen.getByRole("combobox", { name: "Response version" })).toBeInTheDocument();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // GEN-UI-A11Y-001 — the native textbox, controlled semantic list, and named result buttons
  // survive an axe run with every idref resolvable.
  it("jest-axe: open @-mention result list has no violations and wires idrefs", async () => {
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

    const resultList = await screen.findByRole("list", { name: "Repository file results" });
    expect(textbox).toHaveAttribute("aria-controls", resultList.id);
    expect(
      within(resultList).getByRole("button", {
        name: "Reference src/context/coding-context.ts",
      }),
    ).toBeVisible();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// #4371 AC4 — the Knowledge Pod picker and the composer while an answer runs pass the accessibility
// checks in English and in German. The locale comes from the same stored preference the product reads.
describe.each([
  {
    locale: "en",
    groundingMode: "Grounding mode",
    cancel: "Cancel response",
    sendRunning: "Send is unavailable while a response is running",
  },
  {
    locale: "de",
    groundingMode: "Grounding-Modus",
    cancel: "Antwort abbrechen",
    sendRunning: "Senden ist nicht möglich, solange eine Antwort läuft",
  },
] as const)(
  "ChatWindow a11y — picker and running answer in $locale",
  ({ locale, groundingMode, cancel, sendRunning }) => {
    beforeEach(() => {
      window.localStorage.setItem(I18N_STORAGE_KEY, locale);
    });
    afterEach(() => {
      window.localStorage.removeItem(I18N_STORAGE_KEY);
    });

    it("jest-axe: the known Knowledge Pods are listed while a refresh is still pending", async () => {
      const user = userEvent.setup();
      const pod = {
        id: "cap-known" as KnowledgeCapsuleId,
        displayName: "Requirements",
        lifecycleState: "ready" as const,
        sourceCount: 1,
        updatedAt: 1,
      };
      fetchCapsulesMock
        .mockResolvedValueOnce({ capsules: [pod] })
        .mockReturnValueOnce(new Promise(() => undefined));
      const { container } = render(
        <I18nProvider>
          <ChatSessionProvider value={makeSession({ activeChat: makeChat() })}>
            <ChatWindow />
          </ChatSessionProvider>
        </I18nProvider>,
      );
      await vi.waitFor(() => expect(fetchCapsulesMock).toHaveBeenCalledTimes(1));
      await user.click(await screen.findByRole("combobox", { name: groundingMode }));
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("combobox", { name: groundingMode }));
      await vi.waitFor(() => expect(fetchCapsulesMock).toHaveBeenCalledTimes(2));

      // Listed and selectable before the refresh answers.
      const option = await screen.findByRole("option", { name: /Requirements/u });
      expect(option).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("combobox", { name: groundingMode })).toBeEnabled();
      // The open menu sits in a portal outside any page landmark; the page-level `region` rule does
      // not describe a component, so it is the one rule left out (the component tests above run axe on
      // their container, where it does not apply either).
      const results = await axe(document.body, { rules: { region: { enabled: false } } });
      expect(results).toHaveNoViolations();
      expect(container).toBeTruthy();
    });

    it("jest-axe: no Send-like control cancels a running answer and a second message is refused with a reason", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <I18nProvider>
          <ChatSessionProvider
            value={makeSession({
              activeChat: makeChat(),
              draft: "next message",
              sendStatus: "streaming",
              sending: true,
              models: [
                {
                  id: "example-chat-model",
                  supportsImageInput: false,
                  supportsDocumentInput: false,
                } as ChatSessionApi["models"][number],
              ],
            })}
          >
            <ChatWindow />
          </ChatSessionProvider>
        </I18nProvider>,
      );
      // The German catalogs load on demand: wait for the localized window before reading names.
      await screen.findByRole("combobox", { name: groundingMode }, { timeout: 5000 });
      const stop = screen.getByRole("button", { name: cancel });
      const inertSend = screen.getByRole("button", { name: sendRunning });
      // The control that cancels is not the Send control, and Send is inert.
      expect(stop).not.toBe(inertSend);
      expect(stop).not.toHaveClass("cmp-send");
      expect(inertSend).toHaveAttribute("aria-disabled", "true");
      expect(inertSend).toHaveAttribute("type", "button");

      // A second message is refused with a readable reason, announced politely.
      const input = document.querySelector<HTMLElement>('[role="textbox"]');
      if (input === null) throw new Error("Missing composer input");
      await user.click(input);
      await user.keyboard("{Enter}");
      const status = container.querySelector('[data-send-status="streaming"]');
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(
        status?.querySelector("[data-send-refusal]")?.textContent?.trim().length,
      ).toBeGreaterThan(10);

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  },
);
