"use client";
import { useRef, useState, type ReactNode, type RefObject } from "react";
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
import { beginChatConnectorEvidence } from "./chat-connector-evidence";

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

type PublicationOutcome = "applied" | "stale" | "dropped";
interface ChatPublication {
  readonly latest: RefObject<Chat>;
  readonly publish: (updated: Chat, readFrom?: Chat) => PublicationOutcome;
}

/** Reads and writes share one synchronous revision boundary, including before React renders. */
function useChatPublication(chat: Chat, onChatChanged: (chat: Chat) => void): ChatPublication {
  const latest = useRef(chat);
  const rendered = useRef(chat);
  if (
    rendered.current !== chat &&
    (latest.current.id !== chat.id ||
      latest.current.projectPath !== chat.projectPath ||
      chat.updatedAt >= latest.current.updatedAt)
  ) {
    latest.current = chat;
  }
  rendered.current = chat;
  return {
    latest,
    publish(updated, readFrom): PublicationOutcome {
      if (latest.current.id !== updated.id || latest.current.projectPath !== updated.projectPath)
        return "dropped";
      if (updated.updatedAt < latest.current.updatedAt) return "stale";
      // updatedAt is a millisecond timestamp: an earlier read cannot undo a confirmed PATCH
      // in the same millisecond, nor another read already adopted while this one was in flight.
      if (
        readFrom !== undefined &&
        latest.current !== readFrom &&
        updated.updatedAt === latest.current.updatedAt
      )
        return "stale";
      latest.current = updated;
      onChatChanged(updated);
      return "applied";
    },
  };
}

/** One PATCH at a time; canonical refreshes and PATCH replies use the same publication guard. */
function useChatConnectorPatch(
  chat: Chat,
  publication: ChatPublication,
  persist: typeof updateGroundingScopes,
): { busy: boolean; failed: boolean; submit: (patch: UpdateChatInput) => void } {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failedChat, setFailedChat] = useState<string>();
  const submit = (patch: UpdateChatInput): void => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFailedChat(undefined);
    const evidence = beginChatConnectorEvidence("chat connector selection");
    void persist(publication.latest.current, patch, publication.publish)
      .then((updated) => evidence.settle(publication.publish(updated)))
      .catch((error: unknown) => {
        evidence.settle("failed");
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

function selectedChatToolMode(chat: Chat): NonNullable<Chat["toolMode"]> {
  return chat.effectiveToolMode ?? chat.toolMode ?? CHAT_TOOL_DEFAULT_MODE;
}

/** A pod deleted or re-verified elsewhere changes the binding; read the Chat again. */
function useCanonicalChatRefresh(publication: ChatPublication): void {
  useConnectorRefresh(() => {
    const evidence = beginChatConnectorEvidence("chat connector refresh");
    const before = publication.latest.current;
    void canonicalGroundingChat(before, undefined, evidence.correlationId)
      .then((updated) => evidence.settle(publication.publish(updated, before)))
      .catch((error: unknown) => {
        evidence.settle("failed");
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
  const publication = useChatPublication(chat, onChatChanged);
  const patch = useChatConnectorPatch(chat, publication, persist);
  useCanonicalChatRefresh(publication);
  return (
    <ConnectorsMenu
      servers={servers.servers}
      selectedServers={chat.mcpServers}
      pods={pods.pods}
      boundPodId={chat.jiraPodBinding?.podId}
      jiraAdministrationEnabled={!pods.failed && chat.jiraAdministrationEnabled === true}
      onJiraAdministrationChange={(jiraAdministrationEnabled) =>
        patch.submit({ jiraAdministrationEnabled })
      }
      loading={servers.loading || pods.loading}
      busy={patch.busy}
      failed={patch.failed || servers.failed || pods.failed}
      mode={{
        value: selectedChatToolMode(chat),
        ceiling: chat.toolModeCeiling ?? CHAT_TOOL_DEFAULT_MODE,
        onChange: (toolMode) => patch.submit({ toolMode }),
      }}
      onServersChange={(mcpServers) => patch.submit({ mcpServers })}
      onPodChange={(jiraPodId) => patch.submit({ jiraPodId, jiraAdministrationEnabled: false })}
      onOpen={() => {
        servers.reload();
        pods.reload();
      }}
      onManageServers={onManageServers}
      onManagePods={onManagePods}
    />
  );
}
