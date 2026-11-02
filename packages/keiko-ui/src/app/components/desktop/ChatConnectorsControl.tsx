"use client";
import { useRef, useState, type ReactNode } from "react";
import { CHAT_TOOL_DEFAULT_MODE } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { Chat } from "@/lib/types";
import type { UpdateChatInput } from "@/lib/api";
import { listAtlassianConnectors } from "@/lib/atlassian-connectors-api";
import { canonicalGroundingChat, updateGroundingScopes } from "@/lib/chat-grounding-mutation";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";
import { ConnectorsMenu } from "./ConnectorsMenu";
import { useConnectorRefresh } from "./useConnectorRefresh";
import { usePodChoices } from "./useJiraPodChoices";
import { useMcpServerChoices } from "./useMcpServerChoices";

export interface ChatConnectorsControlProps {
  readonly chat: Chat;
  readonly onChatChanged: (chat: Chat) => void;
  readonly onManageServers?: (() => void) | undefined;
  readonly onManagePods?: (() => void) | undefined;
  readonly persist?: typeof updateGroundingScopes;
  readonly list?: typeof listAtlassianConnectors;
}

function reportConnectorFailure(message: string, error: unknown): void {
  reportClientDiagnostic(message, {
    kind: "other",
    correlationId: newClientCorrelationId(),
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
  });
}

/** One PATCH at a time; a reply for another Chat, or older than the shown revision, is dropped. */
function useChatConnectorPatch(
  chat: Chat,
  onChatChanged: (chat: Chat) => void,
  persist: typeof updateGroundingScopes,
): { busy: boolean; failed: boolean; submit: (patch: UpdateChatInput) => void } {
  const locked = useRef(false);
  // The newest revision this control has seen or published for the shown Chat.
  const shown = useRef({ id: chat.id, updatedAt: chat.updatedAt });
  shown.current =
    shown.current.id === chat.id
      ? { id: chat.id, updatedAt: Math.max(shown.current.updatedAt, chat.updatedAt) }
      : { id: chat.id, updatedAt: chat.updatedAt };
  const [busy, setBusy] = useState(false);
  const [failedChat, setFailedChat] = useState<string>();
  const submit = (patch: UpdateChatInput): void => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFailedChat(undefined);
    const publish = (updated: Chat): void => {
      if (shown.current.id !== updated.id || updated.updatedAt < shown.current.updatedAt) return;
      shown.current = { id: updated.id, updatedAt: updated.updatedAt };
      onChatChanged(updated);
    };
    void persist(chat, patch, publish)
      .then(publish)
      .catch((error: unknown) => {
        reportConnectorFailure("Chat connector selection failed.", error);
        setFailedChat(chat.id);
      })
      .finally(() => {
        locked.current = false;
        setBusy(false);
      });
  };
  return { busy, failed: failedChat === chat.id, submit };
}

/** A pod deleted or re-verified elsewhere changes the binding; read the Chat again. */
function useCanonicalChatRefresh(chat: Chat, onChatChanged: (chat: Chat) => void): void {
  const latest = useRef(chat);
  latest.current = chat;
  useConnectorRefresh(() => {
    const before = latest.current;
    void canonicalGroundingChat(before)
      .then((updated) => {
        if (latest.current.id === updated.id && updated.updatedAt >= latest.current.updatedAt) {
          onChatChanged(updated);
        }
      })
      .catch((error: unknown) => {
        reportConnectorFailure("Chat connector refresh failed.", error);
      });
  });
}

export function ChatConnectorsControl({
  chat,
  onChatChanged,
  onManageServers,
  onManagePods,
  persist = updateGroundingScopes,
  list = listAtlassianConnectors,
}: ChatConnectorsControlProps): ReactNode {
  const servers = useMcpServerChoices();
  const pods = usePodChoices(list, true);
  const patch = useChatConnectorPatch(chat, onChatChanged, persist);
  useCanonicalChatRefresh(chat, onChatChanged);
  return (
    <ConnectorsMenu
      servers={servers.servers}
      selectedServers={chat.mcpServers}
      pods={pods.pods}
      boundPodId={chat.jiraPodBinding?.podId}
      loading={servers.loading || pods.loading}
      busy={patch.busy}
      failed={patch.failed || servers.failed || pods.failed}
      mode={{
        value: chat.effectiveToolMode ?? chat.toolMode ?? CHAT_TOOL_DEFAULT_MODE,
        ceiling: chat.toolModeCeiling ?? CHAT_TOOL_DEFAULT_MODE,
        onChange: (toolMode) => patch.submit({ toolMode }),
      }}
      onServersChange={(mcpServers) => patch.submit({ mcpServers })}
      onPodChange={(jiraPodId) => patch.submit({ jiraPodId })}
      onOpen={() => {
        servers.reload();
        pods.reload();
      }}
      onManageServers={onManageServers}
      onManagePods={onManagePods}
    />
  );
}
