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

interface CanonicalConnectedScope {
  readonly kind: ChatConnectedScope["kind"];
  readonly relativePaths: readonly string[];
  readonly root: string;
}

interface CanonicalLocalKnowledgeScope {
  readonly kind: ChatLocalKnowledgeScope["kind"];
  readonly id: string;
}

function compareCanonical(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map(normalizePath))].sort(compareCanonical);
}

function deduplicateAndSort<T>(values: readonly T[]): readonly T[] {
  const byCanonicalValue = new Map(values.map((value) => [JSON.stringify(value), value]));
  return [...byCanonicalValue.entries()]
    .sort(([left], [right]) => compareCanonical(left, right))
    .map(([, value]) => value);
}

function canonicalConnectedScopes(chat: Chat): readonly CanonicalConnectedScope[] {
  return deduplicateAndSort(
    connectedScopes(chat).map((scope) => ({
      kind: scope.kind,
      relativePaths: normalizePaths(scope.relativePaths),
      root: normalizePath(scope.root ?? chat.projectPath),
    })),
  );
}

function canonicalLocalKnowledgeScope(
  scope: ChatLocalKnowledgeScope,
): CanonicalLocalKnowledgeScope {
  return {
    kind: scope.kind,
    id: scope.kind === "capsule" ? scope.capsuleId : scope.capsuleSetId,
  };
}

function canonicalGroundingScope(chat: Chat): string {
  return JSON.stringify({
    connected: canonicalConnectedScopes(chat),
    local: deduplicateAndSort(localKnowledgeScopes(chat).map(canonicalLocalKnowledgeScope)),
  });
}

export function deriveChatGroundingScopeIdentity(chat: Chat): string {
  return `gsi-v1:${createHash("sha256").update(canonicalGroundingScope(chat)).digest("hex")}`;
}
