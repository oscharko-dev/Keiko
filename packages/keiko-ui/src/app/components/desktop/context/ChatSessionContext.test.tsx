import { memo, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatSessionApi } from "../hooks/useChatSession";
import {
  ChatSessionProvider,
  useChatSessionActions,
  useChatSessionCatalog,
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
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn().mockResolvedValue(undefined),
    openProject: vi.fn().mockResolvedValue(undefined),
    openChat: vi.fn().mockResolvedValue(undefined),
    addProject: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
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
