import { memo, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatSessionApi } from "../hooks/useChatSession";
import {
  ChatSessionProvider,
  useChatSessionActions,
  useChatSessionCatalog,
  useChatSessionComposer,
  useChatSessionContext,
} from "./ChatSessionContext";

function session(overrides: Partial<ChatSessionApi> = {}): ChatSessionApi {
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
    regeneratingMessageId: undefined,
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn().mockResolvedValue(undefined),
    openProject: vi.fn().mockResolvedValue(undefined),
    openChat: vi.fn().mockResolvedValue(undefined),
    addProject: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    regenerateMessage: vi.fn().mockResolvedValue(undefined),
    cancelSend: vi.fn(),
    replaceChat: vi.fn(),
    latestGrounded: undefined,
    cancelGrounded: vi.fn(),
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: false, reason: "too-large" }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    lastSentDocuments: [],
    memoryEnabled: false,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 0,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn().mockResolvedValue(undefined),
    rejectMemoryCandidate: vi.fn().mockResolvedValue(undefined),
    forgetMemoryAction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const CatalogProbe = memo(function CatalogProbe(props: {
  readonly onRender: () => void;
}): ReactNode {
  useChatSessionCatalog();
  props.onRender();
  return null;
});

const ActionsProbe = memo(function ActionsProbe(props: {
  readonly onRender: () => void;
}): ReactNode {
  useChatSessionActions();
  props.onRender();
  return null;
});

const FullProbe = memo(function FullProbe(props: { readonly onRender: () => void }): ReactNode {
  useChatSessionContext();
  props.onRender();
  return null;
});

function Harness(props: {
  readonly value: ChatSessionApi;
  readonly onCatalogRender: () => void;
  readonly onActionsRender: () => void;
  readonly onFullRender: () => void;
}): ReactNode {
  return (
    <ChatSessionProvider value={props.value}>
      <CatalogProbe onRender={props.onCatalogRender} />
      <ActionsProbe onRender={props.onActionsRender} />
      <FullProbe onRender={props.onFullRender} />
    </ChatSessionProvider>
  );
}

// GEN-PERF-CHAT-002 — a settled chat bubble subscribes only to `activeChat`, which lives in the
// catalog context. This probe mirrors that exact subscription (memoized, reads only activeChat)
// so we can pin that a settled bubble stays inert across draft + streaming updates.
const SettledBubbleProbe = memo(function SettledBubbleProbe(props: {
  readonly onRender: () => void;
}): ReactNode {
  const { activeChat } = useChatSessionCatalog();
  props.onRender();
  return <span>{activeChat?.id ?? "none"}</span>;
});

function BubbleHarness(props: {
  readonly value: ChatSessionApi;
  readonly onBubbleRender: () => void;
}): ReactNode {
  return (
    <ChatSessionProvider value={props.value}>
      <SettledBubbleProbe onRender={props.onBubbleRender} />
    </ChatSessionProvider>
  );
}

describe("GEN-PERF-CHAT-002 — settled bubble render insulation", () => {
  it("does not re-render a catalog-only bubble across draft + streaming updates", () => {
    const onBubbleRender = vi.fn();
    const initial = session();
    const { rerender } = render(<BubbleHarness value={initial} onBubbleRender={onBubbleRender} />);
    expect(onBubbleRender).toHaveBeenCalledTimes(1);

    // 10 draft updates (per-keystroke) + 10 streaming-message updates (per token). A bubble that
    // read the full-state context would re-render on each; a catalog-only bubble must not.
    for (let i = 0; i < 10; i += 1) {
      rerender(
        <BubbleHarness
          value={{ ...initial, draft: `d${String(i)}` }}
          onBubbleRender={onBubbleRender}
        />,
      );
    }
    for (let i = 0; i < 10; i += 1) {
      rerender(
        <BubbleHarness
          value={{
            ...initial,
            streamingAssistantMessage: {
              id: "live",
              chatId: "c1",
              role: "assistant",
              content: "x".repeat(i + 1),
              timestamp: 1,
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
          }}
          onBubbleRender={onBubbleRender}
        />,
      );
    }

    // Still exactly the initial render: 20 draft/streaming updates produced ZERO extra bubble renders.
    expect(onBubbleRender).toHaveBeenCalledTimes(1);
  });

  it("does re-render the bubble when activeChat itself changes", () => {
    const onBubbleRender = vi.fn();
    const initial = session({ activeChat: undefined });
    const { rerender } = render(<BubbleHarness value={initial} onBubbleRender={onBubbleRender} />);
    expect(onBubbleRender).toHaveBeenCalledTimes(1);

    rerender(
      <BubbleHarness
        value={{
          ...initial,
          activeChat: {
            id: "chat-A",
            projectPath: "/p",
            title: "t",
            selectedModel: "m",
            branchLabel: undefined,
            status: undefined,
            connectedScope: undefined,
            localKnowledgeScope: undefined,
            createdAt: 1,
            updatedAt: 2,
          },
        }}
        onBubbleRender={onBubbleRender}
      />,
    );
    expect(onBubbleRender).toHaveBeenCalledTimes(2);
  });
});

// GEN-PERF-CHAT-014 — the composer (and every non-bubble sibling in ChatWindow) reads the
// settled slice. It must stay inert across per-frame streaming flushes — that is the whole
// point of the slice — while remaining reactive to drafts, and the full-context hook must
// keep delivering the live streaming delta unchanged.
const ComposerProbe = memo(function ComposerProbe(props: {
  readonly onRender: () => void;
}): ReactNode {
  useChatSessionComposer();
  props.onRender();
  return null;
});

function ComposerHarness(props: {
  readonly value: ChatSessionApi;
  readonly onComposerRender: () => void;
  readonly onFullRender: () => void;
}): ReactNode {
  return (
    <ChatSessionProvider value={props.value}>
      <ComposerProbe onRender={props.onComposerRender} />
      <FullProbe onRender={props.onFullRender} />
    </ChatSessionProvider>
  );
}

function streamingMessage(content: string): ChatSessionApi["streamingAssistantMessage"] {
  return {
    id: "live",
    chatId: "c1",
    role: "assistant",
    content,
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

describe("GEN-PERF-CHAT-014 — composer render insulation from streaming flushes", () => {
  it("does not re-render a settled-slice consumer on streaming-only updates", () => {
    const onComposerRender = vi.fn();
    const onFullRender = vi.fn();
    const initial = session();
    const { rerender } = render(
      <ComposerHarness
        value={initial}
        onComposerRender={onComposerRender}
        onFullRender={onFullRender}
      />,
    );
    expect(onComposerRender).toHaveBeenCalledTimes(1);

    // 10 coalesced token flushes: only streamingAssistantMessage changes.
    for (let i = 0; i < 10; i += 1) {
      rerender(
        <ComposerHarness
          value={{ ...initial, streamingAssistantMessage: streamingMessage("x".repeat(i + 1)) }}
          onComposerRender={onComposerRender}
          onFullRender={onFullRender}
        />,
      );
    }

    // The settled-slice consumer stayed inert; the full-context consumer saw every flush.
    expect(onComposerRender).toHaveBeenCalledTimes(1);
    expect(onFullRender).toHaveBeenCalledTimes(11);
  });

  it("still re-renders the settled-slice consumer on draft changes", () => {
    const onComposerRender = vi.fn();
    const onFullRender = vi.fn();
    const initial = session();
    const { rerender } = render(
      <ComposerHarness
        value={initial}
        onComposerRender={onComposerRender}
        onFullRender={onFullRender}
      />,
    );
    rerender(
      <ComposerHarness
        value={{ ...initial, draft: "typed" }}
        onComposerRender={onComposerRender}
        onFullRender={onFullRender}
      />,
    );
    expect(onComposerRender).toHaveBeenCalledTimes(2);
  });

  it("keeps delivering the streaming delta through the full-context hook", () => {
    const seen: (string | undefined)[] = [];
    function StreamReader(): ReactNode {
      const { streamingAssistantMessage } = useChatSessionContext();
      seen.push(streamingAssistantMessage?.content);
      return <span>{streamingAssistantMessage?.content ?? "idle"}</span>;
    }
    const initial = session();
    const { rerender, getByText } = render(
      <ChatSessionProvider value={initial}>
        <StreamReader />
      </ChatSessionProvider>,
    );
    expect(getByText("idle")).toBeTruthy();
    rerender(
      <ChatSessionProvider
        value={{ ...initial, streamingAssistantMessage: streamingMessage("abc") }}
      >
        <StreamReader />
      </ChatSessionProvider>,
    );
    expect(getByText("abc")).toBeTruthy();
    expect(seen.at(-1)).toBe("abc");
  });
});

describe("ChatSessionContext", () => {
  it("does not notify catalog/action consumers for transcript-only changes", () => {
    const onCatalogRender = vi.fn();
    const onActionsRender = vi.fn();
    const onFullRender = vi.fn();
    const initial = session();
    const { rerender } = render(
      <Harness
        value={initial}
        onCatalogRender={onCatalogRender}
        onActionsRender={onActionsRender}
        onFullRender={onFullRender}
      />,
    );

    rerender(
      <Harness
        value={{
          ...initial,
          messages: [
            {
              id: "m1",
              chatId: "c1",
              role: "assistant",
              content: "streamed",
              timestamp: 1,
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
          ],
          draft: "new draft",
        }}
        onCatalogRender={onCatalogRender}
        onActionsRender={onActionsRender}
        onFullRender={onFullRender}
      />,
    );

    expect(onCatalogRender).toHaveBeenCalledTimes(1);
    expect(onActionsRender).toHaveBeenCalledTimes(1);
    expect(onFullRender).toHaveBeenCalledTimes(2);
  });
});
