import { describe, expect, it } from "vitest";
import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/connected-context";
import { createGroundedTurnRegistry } from "./grounded-turn-registry.js";

function packWithExcerpt(content: string): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "scope-1",
      workspaceRoot: "/workspace",
      kind: "directory",
      relativePaths: ["src"],
      conversationId: undefined,
      connectedAtMs: 1,
    },
    query: {
      kind: "natural-language",
      text: "Explain this code",
      caseSensitive: false,
      maxResults: 10,
      emittedAtMs: 1,
    },
    budget: {
      searchCallsMax: 1,
      filesReadMax: 1,
      excerptBytesMax: 1_000,
      modelInputTokensMax: 1_000,
      modelOutputTokensMax: 1_000,
      elapsedMsMax: 1_000,
      rerankCallsMax: 0,
    },
    usage: {
      searchCalls: 1,
      filesRead: 1,
      excerptBytes: content.length,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 10,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath: "src/secret.ts",
        role: "read-only",
        selectionReason: "test",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: "a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              scopePath: "src/secret.ts",
              lineRange: { startLine: 1, endLine: 1 },
              score: 1,
              provenance: {
                kind: "lexical-search",
                tool: "repo.searchText",
                queryFingerprint: "fp",
              },
              redactionState: "redacted",
              emittedAtMs: 1,
              ledgerRef: undefined,
            },
            content,
            contentBytes: content.length,
          },
        ],
      },
    ],
    omitted: [],
    uncertainty: [],
    emittedAtMs: 1,
    ledgerRef: undefined,
  };
}

describe("grounded turn registry", () => {
  it("retains handoff metadata without retaining excerpt content", () => {
    const registry = createGroundedTurnRegistry();
    registry.remember(
      {
        assistantMessageId: "assistant-1",
        chatId: "chat-1",
        workspaceRoot: "/workspace",
        packs: [packWithExcerpt("TOP-SECRET-CODE();")],
      },
      () => 1,
    );

    const record = registry.lookup("assistant-1", () => 2);
    if (record === undefined) {
      throw new Error("expected grounded turn record");
    }
    const pack = record.packs[0];
    if (pack === undefined) {
      throw new Error("expected grounded turn pack");
    }
    const file = pack.files[0];
    if (file === undefined) {
      throw new Error("expected grounded turn file");
    }
    const excerpt = file.excerpts[0];
    if (excerpt === undefined) {
      throw new Error("expected grounded turn excerpt");
    }

    expect(pack.stableId).toBe(
      "p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(file.scopePath).toBe("src/secret.ts");
    expect(excerpt.atom.stableId).toBe(
      "a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(excerpt.content).toBe("");
    expect(excerpt.contentBytes).toBe(0);
  });
});
