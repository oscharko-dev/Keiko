import { useRef, useState } from "react";
import type { Chat } from "@/lib/types";
import { deleteHistoryChats, type ChatHistoryDeletionResult } from "./chatHistoryDeletion";

interface Selection {
  readonly scope: string;
  readonly ids: ReadonlySet<string>;
}

export interface ChatHistorySelection {
  readonly selectedChats: readonly Chat[];
  readonly toggleChat: (id: string) => void;
  readonly toggleAll: () => void;
  readonly clear: () => void;
  readonly retain: (ids: readonly string[], requestScope: string) => void;
}

/** Scope includes project, tab and query; hidden or stale rows never enter a delete request. */
export function useChatHistorySelection(
  scope: string,
  chats: readonly Chat[],
): ChatHistorySelection {
  const [selection, setSelection] = useState<Selection>({ scope, ids: new Set() });
  if (selection.scope !== scope) setSelection({ scope, ids: new Set() });
  const selectedChats = chats.filter(
    (chat) => selection.scope === scope && selection.ids.has(chat.id),
  );
  const clear = (): void => setSelection({ scope, ids: new Set() });
  return {
    selectedChats,
    clear,
    toggleChat: (id): void => {
      const ids = new Set(selectedChats.map((chat) => chat.id));
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      setSelection({ scope, ids });
    },
    toggleAll: (): void => {
      if (selectedChats.length === chats.length) clear();
      else setSelection({ scope, ids: new Set(chats.map((chat) => chat.id)) });
    },
    retain: (ids, requestScope): void => setSelection({ scope: requestScope, ids: new Set(ids) }),
  };
}

export interface ChatHistoryDeletion {
  readonly busy: boolean;
  readonly completed: number;
  readonly failure: ChatHistoryDeletionResult | null;
  readonly remove: (chats: readonly Chat[]) => Promise<ChatHistoryDeletionResult | undefined>;
}

export function useChatHistoryDeletion(scope: string): ChatHistoryDeletion {
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [failure, setFailure] = useState<ChatHistoryDeletionResult | null>(null);
  const [failureScope, setFailureScope] = useState(scope);
  if (failureScope !== scope) {
    setFailureScope(scope);
    setFailure(null);
  }
  const inFlight = useRef(false);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const remove = async (chats: readonly Chat[]): Promise<ChatHistoryDeletionResult | undefined> => {
    if (inFlight.current || chats.length === 0) return undefined;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const requestedScope = scope;
    try {
      const result = await deleteHistoryChats(chats);
      if (currentScope.current === requestedScope) {
        if (result.failedIds.length > 0) setFailure(result);
        setCompleted((previous) => previous + 1);
      }
      return result;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { busy, completed, failure, remove };
}
