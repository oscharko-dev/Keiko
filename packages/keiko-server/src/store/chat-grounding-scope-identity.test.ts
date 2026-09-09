import { describe, expect, it } from "vitest";
import {
  isGroundingScopeIdentity,
  type Chat,
  type ChatConnectedScope,
  type ChatGitChangeScope,
  type ChatLocalKnowledgeScope,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { deriveChatGroundingScopeIdentity } from "./chat-grounding-scope-identity.js";

function gitChangeScope(patch: Partial<ChatGitChangeScope> = {}): ChatGitChangeScope {
  return {
    kind: "git-change",
    relationshipId: "rel-1",
    remoteDigest: "d".repeat(64),
    comparisonLabel: "main...feature/x",
    baseRef: "main",
    headRef: "feature/x",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
    snapshotDigest: "e".repeat(64),
    fileCount: 3,
    totalFiles: 3,
    omittedFiles: 0,
    truncatedFiles: 0,
    descriptionStatus: "current",
    connectedAtMs: 10,
    ...patch,
  };
}

function chat(patch: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/customer/repository",
    title: "Release",
    selectedModel: "chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: {
      kind: "directory",
      relativePaths: ["private/source"],
      root: "/customer/repository",
      connectedAtMs: 10,
    },
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function connectedScope(
  kind: ChatConnectedScope["kind"],
  relativePaths: readonly string[],
  connectedAtMs: number,
  root = "/customer/repository",
): ChatConnectedScope {
  return { kind, relativePaths, connectedAtMs, root };
}

function localScope(
  kind: ChatLocalKnowledgeScope["kind"],
  id: string,
  connectedAtMs: number,
): ChatLocalKnowledgeScope {
  return kind === "capsule"
    ? {
        kind,
        capsuleId: id as Extract<
          ChatLocalKnowledgeScope,
          { readonly kind: "capsule" }
        >["capsuleId"],
        connectedAtMs,
      }
    : {
        kind,
        capsuleSetId: id as Extract<
          ChatLocalKnowledgeScope,
          { readonly kind: "capsule-set" }
        >["capsuleSetId"],
        connectedAtMs,
      };
}

describe("deriveChatGroundingScopeIdentity", () => {
  it("is stable across non-scope updates", () => {
    const original = deriveChatGroundingScopeIdentity(chat());
    const updated = deriveChatGroundingScopeIdentity(
      chat({ title: "Renamed", selectedModel: "other-model", updatedAt: 999, status: "open" }),
    );

    expect(updated).toBe(original);
    expect(isGroundingScopeIdentity(original)).toBe(true);
  });

  it("ignores lifecycle metadata that does not change retrieval semantics", () => {
    const originalConnected = connectedScope("directory", ["private/source"], 10);
    const originalLocal = localScope("capsule", "capsule-a", 20);
    const original = deriveChatGroundingScopeIdentity(
      chat({
        connectedScopes: [originalConnected],
        connectedScope: originalConnected,
        localKnowledgeScopes: [originalLocal],
        localKnowledgeScope: originalLocal,
      }),
    );
    const updatedConnected = connectedScope("directory", ["private/source"], 999);
    const updatedLocal = localScope("capsule", "capsule-a", 888);
    const updated = deriveChatGroundingScopeIdentity(
      chat({
        status: "closed",
        connectedScopes: [updatedConnected],
        connectedScope: updatedConnected,
        localKnowledgeScopes: [updatedLocal],
        localKnowledgeScope: updatedLocal,
      }),
    );

    expect(updated).toBe(original);
  });

  it("canonicalizes scope order, duplicates, path order, and path separators", () => {
    const directory = connectedScope("directory", ["src/server"], 10);
    const files = connectedScope("files", ["docs/guide.md", "README.md"], 11);
    const capsule = localScope("capsule", "capsule-a", 20);
    const capsuleSet = localScope("capsule-set", "capsule-set-b", 21);
    const original = deriveChatGroundingScopeIdentity(
      chat({
        connectedScopes: [directory, files],
        connectedScope: directory,
        localKnowledgeScopes: [capsule, capsuleSet],
        localKnowledgeScope: capsule,
      }),
    );
    const reorderedFiles = connectedScope(
      "files",
      ["README.md", "docs\\guide.md", "README.md"],
      101,
      "\\customer\\repository",
    );
    const reorderedDirectory: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src\\server"],
      connectedAtMs: 102,
    };
    const reorderedCapsuleSet = localScope("capsule-set", "capsule-set-b", 201);
    const reordered = deriveChatGroundingScopeIdentity(
      chat({
        status: "closed",
        connectedScopes: [
          reorderedFiles,
          reorderedDirectory,
          connectedScope("files", ["docs/guide.md", "README.md"], 103),
        ],
        connectedScope: reorderedFiles,
        localKnowledgeScopes: [
          reorderedCapsuleSet,
          localScope("capsule", "capsule-a", 202),
          localScope("capsule", "capsule-a", 203),
        ],
        localKnowledgeScope: reorderedCapsuleSet,
      }),
    );

    expect(reordered).toBe(original);
  });

  it("changes for retrieval-semantic connected and local-knowledge revisions", () => {
    const original = deriveChatGroundingScopeIdentity(chat());
    const connected = deriveChatGroundingScopeIdentity(
      chat({
        connectedScope: {
          kind: "directory",
          relativePaths: ["different/source"],
          root: "/customer/repository",
          connectedAtMs: 11,
        },
      }),
    );
    const capsuleId = "capsule-sensitive-id" as Extract<
      ChatLocalKnowledgeScope,
      { readonly kind: "capsule" }
    >["capsuleId"];
    const local = deriveChatGroundingScopeIdentity(
      chat({ localKnowledgeScope: { kind: "capsule", capsuleId, connectedAtMs: 12 } }),
    );
    const differentRoot = deriveChatGroundingScopeIdentity(
      chat({
        connectedScope: connectedScope("directory", ["private/source"], 13, "/other/repository"),
      }),
    );

    expect(new Set([original, connected, local, differentRoot]).size).toBe(4);
  });

  it("never exposes source paths or connector identities", () => {
    const token = deriveChatGroundingScopeIdentity(chat());

    expect(token).not.toContain("customer");
    expect(token).not.toContain("private");
    expect(token).toMatch(/^gsi-v1:[0-9a-f]{64}$/u);
  });
});

// Issue #3400 (epic #3384, contract correction 2) — before this change, deriveChatGroundingScopeIdentity
// hashed only connectedScopes/localKnowledgeScopes, so a chat's identity was blind to its
// gitChangeScopes entirely: two chats differing only in git-change scope (or the SAME chat before
// and after a head moved) produced an IDENTICAL identity, which is exactly the gap contract
// correction 2 and the "9400 test must prove" section name (a stale head is not detected by the
// existing 409 GROUNDING_SCOPE_CHANGED guard in grounded-qa.ts, which compares this identity).
describe("deriveChatGroundingScopeIdentity — git-change scope (Issue #3400)", () => {
  it("changes when a chat gains a git-change scope", () => {
    const withoutScope = deriveChatGroundingScopeIdentity(chat());
    const withScope = deriveChatGroundingScopeIdentity(
      chat({ gitChangeScopes: [gitChangeScope()] }),
    );
    expect(withScope).not.toBe(withoutScope);
  });

  it("changes when the snapshotDigest changes after a head moves (the stale-refresh case)", () => {
    const before = deriveChatGroundingScopeIdentity(
      chat({ gitChangeScopes: [gitChangeScope({ snapshotDigest: "1".repeat(64) })] }),
    );
    const afterHeadMoved = deriveChatGroundingScopeIdentity(
      chat({ gitChangeScopes: [gitChangeScope({ snapshotDigest: "2".repeat(64) })] }),
    );
    expect(afterHeadMoved).not.toBe(before);
  });

  it("changes when the relationshipId changes (a refresh archives and creates a new edge)", () => {
    const before = deriveChatGroundingScopeIdentity(
      chat({ gitChangeScopes: [gitChangeScope({ relationshipId: "rel-1" })] }),
    );
    const afterRefresh = deriveChatGroundingScopeIdentity(
      chat({ gitChangeScopes: [gitChangeScope({ relationshipId: "rel-2" })] }),
    );
    expect(afterRefresh).not.toBe(before);
  });

  it("changes when remoteDigest changes (a different repository — contract correction 6)", () => {
    const before = deriveChatGroundingScopeIdentity(
      chat({ gitChangeScopes: [gitChangeScope({ remoteDigest: "1".repeat(64) })] }),
    );
    const differentRepo = deriveChatGroundingScopeIdentity(
      chat({ gitChangeScopes: [gitChangeScope({ remoteDigest: "2".repeat(64) })] }),
    );
    expect(differentRepo).not.toBe(before);
  });

  it("ignores display-only fields that never change what content a turn reads", () => {
    const original = deriveChatGroundingScopeIdentity(
      chat({ gitChangeScopes: [gitChangeScope()] }),
    );
    const redisplayed = deriveChatGroundingScopeIdentity(
      chat({
        gitChangeScopes: [
          gitChangeScope({
            comparisonLabel: "renamed label",
            fileCount: 99,
            totalFiles: 99,
            descriptionStatus: "stale",
            connectedAtMs: 999,
          }),
        ],
      }),
    );
    expect(redisplayed).toBe(original);
  });
});
