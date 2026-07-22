import { createHash } from "node:crypto";
import type {
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
} from "@oscharko-dev/keiko-contracts/bff-wire";

function connectedScopes(chat: Chat): readonly ChatConnectedScope[] {
  return chat.connectedScopes ?? (chat.connectedScope === undefined ? [] : [chat.connectedScope]);
}

function localKnowledgeScopes(chat: Chat): readonly ChatLocalKnowledgeScope[] {
  return (
    chat.localKnowledgeScopes ??
    (chat.localKnowledgeScope === undefined ? [] : [chat.localKnowledgeScope])
  );
}

function canonicalGroundingScope(chat: Chat): string {
  return JSON.stringify({
    status: chat.status ?? "open",
    connected: connectedScopes(chat).map((scope) => ({
      kind: scope.kind,
      relativePaths: scope.relativePaths,
      connectedAtMs: scope.connectedAtMs,
      root: scope.root ?? null,
    })),
    local: localKnowledgeScopes(chat).map((scope) =>
      scope.kind === "capsule"
        ? {
            kind: scope.kind,
            capsuleId: scope.capsuleId,
            connectedAtMs: scope.connectedAtMs,
          }
        : {
            kind: scope.kind,
            capsuleSetId: scope.capsuleSetId,
            connectedAtMs: scope.connectedAtMs,
          },
    ),
  });
}

export function deriveChatGroundingScopeIdentity(chat: Chat): string {
  return `gsi-v1:${createHash("sha256").update(canonicalGroundingScope(chat)).digest("hex")}`;
}
