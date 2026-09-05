import { createHash } from "node:crypto";
import type {
  Chat,
  ChatConnectedScope,
  ChatGitChangeScope,
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

// Issue #3400 (epic #3384, contract correction 2) — no legacy single-object field exists for this
// scope kind.
function gitChangeScopes(chat: Chat): readonly ChatGitChangeScope[] {
  return chat.gitChangeScopes ?? [];
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

// Issue #3400 (epic #3384, contract correction 2) — only the fields that identify WHICH exact
// snapshot content a turn is grounded against: `relationshipId` (which comparison), `remoteDigest`
// (which repository) and `snapshotDigest` (which exact content). A snapshot re-check that finds a
// different snapshotDigest changes this identity, so the existing `admittedGroundingScopeFailure`
// 409 GROUNDING_SCOPE_CHANGED guard (grounded-qa.ts) rejects a turn after the head moved, with no
// second mechanism. Display-only fields (comparisonLabel, counts, descriptionStatus,
// connectedAtMs) are deliberately excluded — they never change what content a turn reads.
interface CanonicalGitChangeScope {
  readonly relationshipId: string;
  readonly remoteDigest: string;
  readonly snapshotDigest: string;
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

function canonicalGitChangeScope(scope: ChatGitChangeScope): CanonicalGitChangeScope {
  return {
    relationshipId: scope.relationshipId,
    remoteDigest: scope.remoteDigest,
    snapshotDigest: scope.snapshotDigest,
  };
}

function canonicalGroundingScope(chat: Chat): string {
  return JSON.stringify({
    connected: canonicalConnectedScopes(chat),
    local: deduplicateAndSort(localKnowledgeScopes(chat).map(canonicalLocalKnowledgeScope)),
    gitChange: deduplicateAndSort(gitChangeScopes(chat).map(canonicalGitChangeScope)),
  });
}

export function deriveChatGroundingScopeIdentity(chat: Chat): string {
  return `gsi-v1:${createHash("sha256").update(canonicalGroundingScope(chat)).digest("hex")}`;
}
