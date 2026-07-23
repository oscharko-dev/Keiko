import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeUiStore } from "./store/index.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import {
  canonicalChatTurnIdentityContent,
  type CanonicalChatTurnSemanticProjection,
} from "./chat-turn-identity.js";

type PlainProjection = Extract<CanonicalChatTurnSemanticProjection, { routeKind: "plain" }>;

const MEMORY_CONTEXT = {
  userId: "local-operator",
  workspaceId: "/workspace/example",
  projectId: "/workspace/example",
  conversationId: "chat-1",
} as unknown as ConversationMemoryRuntimeContext;

function plainProjection(overrides: Partial<PlainProjection> = {}): PlainProjection {
  return {
    routeKind: "plain",
    content: "scope-sensitive question",
    modelId: "chat-model",
    groundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
    memory: null,
    documentContext: [],
    attachments: [],
    discussionMode: null,
    ...overrides,
  };
}

describe("canonicalChatTurnIdentityContent", () => {
  it("binds every semantic plain-turn input and the route kind", () => {
    const base = plainProjection();
    const identities = [
      base,
      { ...base, content: "different question" },
      { ...base, modelId: "different-model" },
      { ...base, groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}` },
      { ...base, memory: { enabled: true, budgetTokens: 10, context: MEMORY_CONTEXT } },
      {
        ...base,
        documentContext: [
          {
            id: "doc-1",
            displayName: "one.txt",
            mimeType: "text/plain",
            sizeBytes: 3,
            extractedBytes: 3,
            truncated: false,
            text: "one",
          },
        ],
      },
      {
        ...base,
        attachments: [{ kind: "document" as const, mimeType: "text/plain", sizeBytes: 3 }],
      },
      { ...base, discussionMode: "challenge" as const },
      {
        routeKind: "grounded" as const,
        content: base.content,
        modelId: base.modelId,
        groundingScopeIdentity: base.groundingScopeIdentity,
        memory: base.memory,
      },
    ].map((projection) => canonicalChatTurnIdentityContent(projection));

    expect(new Set(identities).size).toBe(identities.length);
  });

  it("canonicalizes object key order while preserving array order", () => {
    const reorderedContext = {
      conversationId: "chat-1",
      projectId: "/workspace/example",
      workspaceId: "/workspace/example",
      userId: "local-operator",
    } as unknown as ConversationMemoryRuntimeContext;
    const left = plainProjection({
      memory: { enabled: true, budgetTokens: 256, context: MEMORY_CONTEXT },
    });
    const right = plainProjection({
      memory: { context: reorderedContext, budgetTokens: 256, enabled: true },
    });

    expect(canonicalChatTurnIdentityContent(left)).toBe(canonicalChatTurnIdentityContent(right));
  });

  it("returns only a versioned digest and never raw semantic content", () => {
    const identity = canonicalChatTurnIdentityContent(
      plainProjection({
        content: "raw-user-transcript-canary",
        documentContext: [
          {
            id: "doc-secret",
            displayName: "secret.txt",
            mimeType: "text/plain",
            sizeBytes: 16,
            extractedBytes: 16,
            truncated: false,
            text: "raw-document-canary",
          },
        ],
        memory: { enabled: true, context: MEMORY_CONTEXT },
      }),
    );

    expect(identity).toMatch(/^\["canonical-chat-turn-v3","[0-9a-f]{64}"\]$/);
    expect(identity).not.toContain("raw-user-transcript-canary");
    expect(identity).not.toContain("raw-document-canary");
    expect(identity).not.toContain("/workspace/example");
  });

  it("persists neither document nor memory identity content in the UI database", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-turn-identity-"));
    const dbPath = join(root, "ui.db");
    const store = createNodeUiStore(dbPath);
    let closed = false;
    try {
      store.createProject(root, "identity audit");
      const chat = store.createChat(root, "identity audit", "chat-model");
      const identity = canonicalChatTurnIdentityContent(
        plainProjection({
          documentContext: [
            {
              id: "doc-1",
              displayName: "secret.txt",
              mimeType: "text/plain",
              sizeBytes: 20,
              extractedBytes: 20,
              truncated: false,
              text: "database-document-canary",
            },
          ],
          memory: { enabled: true, context: MEMORY_CONTEXT },
        }),
      );
      expect(
        store.admitChatTurn(
          "database-redaction-turn",
          {
            chatId: chat.id,
            role: "user",
            content: "ordinary user content",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
          { identityContent: identity },
        ).kind,
      ).toBe("admitted");
      store.close();
      closed = true;

      const databaseBytes = readFileSync(dbPath).toString("utf8");
      expect(databaseBytes).not.toContain("database-document-canary");
      expect(databaseBytes).not.toContain("/workspace/example");
    } finally {
      if (!closed) store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
