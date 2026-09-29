"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { compactChatContext, fetchChatContextStatus } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import { ChatContextMeter } from "./ChatContextMeter";
import type { ChatSessionApi } from "./hooks/useChatSession";

type ContextSession = Pick<
  ChatSessionApi,
  "activeChat" | "selectedModel" | "messages" | "sending" | "regeneratingMessageId" | "loading"
>;

interface ContextState {
  readonly key: string;
  readonly status?: ChatContextStatusWire | undefined;
  readonly compacting: boolean;
  readonly error: boolean;
}

function useChatContext(session: ContextSession): {
  state: ContextState;
  compact: () => void;
  retry: () => void;
  busy: boolean;
} {
  const chatId = session.activeChat?.id;
  const projectPath = session.activeChat?.projectPath;
  const modelId = session.selectedModel;
  const key = JSON.stringify([chatId, projectPath, modelId]);
  const busy = session.sending || session.regeneratingMessageId !== undefined;
  const historyKey = JSON.stringify(session.messages.map((message) => message.id));
  const [state, setState] = useState<ContextState>({ key, compacting: false, error: false });
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(
    (compact: boolean): void => {
      controller.current?.abort();
      if (chatId === undefined || projectPath === undefined || modelId === undefined) return;
      const request = new AbortController();
      controller.current = request;
      setState((previous) => pendingContextState(previous, key, compact));
      const call = compact ? compactChatContext : fetchChatContextStatus;
      settleContextRequest(
        call(chatId, projectPath, modelId, request.signal),
        request,
        key,
        setState,
        compact,
      );
    },
    [chatId, projectPath, modelId, key],
  );
  useEffect(() => {
    if (session.loading) return;
    refresh(false);
    // The persisted user row may arrive after the optimistic UI row. Refresh local estimates
    // while the provider is pending; stream deltas never start additional status requests.
    const timer = busy ? setInterval(() => refresh(false), 1_000) : undefined;
    return (): void => {
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [refresh, busy, session.loading, historyKey, revision]);
  return {
    state: state.key === key ? state : { key, compacting: false, error: false },
    busy,
    compact: (): void => {
      if (!busy && !state.compacting) refresh(true);
    },
    retry: (): void => {
      setRevision((value) => value + 1);
    },
  };
}

export function ChatContextMeterContainer({
  session,
}: {
  readonly session: ContextSession;
}): ReactNode {
  const context = useChatContext(session);
  if (session.activeChat === undefined || session.selectedModel === undefined) return null;
  return (
    <ChatContextMeter
      status={context.state.status}
      busy={context.busy}
      compacting={context.state.compacting}
      error={context.state.error}
      onCompact={context.compact}
      onRetry={context.retry}
    />
  );
}

function settleContextRequest(
  promise: Promise<ChatContextStatusWire>,
  request: AbortController,
  key: string,
  setState: Dispatch<SetStateAction<ContextState>>,
  compact: boolean,
): void {
  void promise
    .then((status) => {
      if (!request.signal.aborted) setState({ key, status, compacting: false, error: false });
    })
    .catch((error: unknown) => {
      if (request.signal.aborted) return;
      reportClientDiagnostic(
        compact
          ? "Keiko manual context compaction request failed."
          : "Keiko context status request failed.",
        {
          correlationId: correlationIdOf(error),
          errorKind: bffRequestErrorKind(error),
          errorEvidence: clientErrorEvidence(error),
        },
      );
      setState((previous) => ({ ...previous, compacting: false, error: true }));
    });
}

function pendingContextState(
  previous: ContextState,
  key: string,
  compacting: boolean,
): ContextState {
  return {
    key,
    status: previous.key === key ? previous.status : undefined,
    compacting,
    error: false,
  };
}
