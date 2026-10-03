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
  const currentStatus = useRef(state.status);
  currentStatus.current = state.status;
  const refresh = useContextRefresh(chatId, projectPath, modelId, key, controller, setState);
  useEffect(() => {
    if (session.loading) return;
    const cancel = pollPendingContext(refresh, busy, currentStatus.current?.estimatedInputTokens);
    return (): void => {
      cancel();
      controller.current?.abort();
      controller.current = null;
    };
  }, [refresh, busy, session.loading, historyKey, revision]);
  return {
    state: state.key === key ? state : { key, compacting: false, error: false },
    busy,
    compact: (): void => {
      if (!busy && !state.compacting) void refresh(true);
    },
    retry: (): void => {
      setRevision((value) => value + 1);
    },
  };
}

function useContextRefresh(
  chatId: string | undefined,
  projectPath: string | undefined,
  modelId: string | undefined,
  key: string,
  controller: { current: AbortController | null },
  setState: Dispatch<SetStateAction<ContextState>>,
): (compact: boolean) => Promise<ChatContextStatusWire | undefined> {
  return useCallback(
    async (compact: boolean): Promise<ChatContextStatusWire | undefined> => {
      if (controller.current !== null) {
        if (!compact) return undefined;
        controller.current.abort();
        controller.current = null;
      }
      if (chatId === undefined || projectPath === undefined || modelId === undefined)
        return undefined;
      const request = new AbortController();
      controller.current = request;
      if (compact) setState((previous) => pendingContextState(previous, key, compact));
      const call = compact ? compactChatContext : fetchChatContextStatus;
      try {
        return await settleContextRequest(
          call(chatId, projectPath, modelId, request.signal),
          request,
          key,
          setState,
          compact,
        );
      } finally {
        if (controller.current === request) controller.current = null;
      }
    },
    [chatId, projectPath, modelId, key, controller, setState],
  );
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

async function settleContextRequest(
  promise: Promise<ChatContextStatusWire>,
  request: AbortController,
  key: string,
  setState: Dispatch<SetStateAction<ContextState>>,
  compact: boolean,
): Promise<ChatContextStatusWire | undefined> {
  try {
    const status = await promise;
    if (request.signal.aborted) return undefined;
    setState({ key, status, compacting: false, error: false });
    return status;
  } catch (error) {
    if (request.signal.aborted) return undefined;
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
    return undefined;
  }
}

// A running turn reads again until its persisted answer changes the estimate. A window probe the
// server is still waiting for reads again until its answer is in, even in an idle chat — otherwise
// the meter kept the assumed window until the next send (PR #3678 review).
function shouldReadAgain(
  status: ChatContextStatusWire,
  busy: boolean,
  baseline: number | undefined,
): boolean {
  if (status.contextWindowProbePending === true) return true;
  return busy && (baseline === undefined || status.estimatedInputTokens === baseline);
}

/** Serial, bounded refresh until the persisted turn changes the estimate; never per-token polling. */
function pollPendingContext(
  refresh: (compact: boolean) => Promise<ChatContextStatusWire | undefined>,
  busy: boolean,
  baseline: number | undefined,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  const next = async (): Promise<void> => {
    const status = await refresh(false);
    if (cancelled || status === undefined || attempts >= 6) return;
    if (!shouldReadAgain(status, busy, baseline)) return;
    baseline = status.estimatedInputTokens;
    const delay = Math.min(1_000 * 2 ** attempts++, 8_000);
    timer = setTimeout(() => {
      void next();
    }, delay);
  };
  void next();
  return (): void => {
    cancelled = true;
    clearTimeout(timer);
  };
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
