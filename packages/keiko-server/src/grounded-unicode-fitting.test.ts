import { describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { withPromptExcerptBudget } from "./grounded-qa.js";

function pack(content: string): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "unicode-pack",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "unicode-scope",
      workspaceRoot: "/fixture",
      kind: "files",
      relativePaths: ["src/astral.ts"],
      conversationId: "unicode-chat",
      connectedAtMs: 1,
    },
    query: {
      kind: "natural-language",
      text: "Explain src/astral.ts.",
      caseSensitive: false,
      maxResults: 1,
      emittedAtMs: 1,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    usage: {
      searchCalls: 0,
      filesRead: 1,
      excerptBytes: Buffer.byteLength(content),
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath: "src/astral.ts",
        role: "read-only",
        selectionReason: "selected file",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: "unicode-atom",
              scopePath: "src/astral.ts",
              score: 1,
              lineRange: { startLine: 1, endLine: 1 },
              provenance: {
                kind: "excerpt-read",
                tool: "repo.selectedFile",
                queryFingerprint: "unicode",
              },
              redactionState: "redacted",
              emittedAtMs: 1,
              ledgerRef: undefined,
            },
            content,
            contentBytes: Buffer.byteLength(content),
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

describe("grounded excerpt UTF-8 boundaries", () => {
  it.each([
    [0, ""],
    [1, "a"],
    [2, "a"],
    [3, "a"],
    [4, "a"],
    [5, "a😀"],
    [6, "a😀b"],
    [7, "a😀b"],
    [8, "a😀b"],
    [9, "a😀b"],
    [10, "a😀b🚀"],
  ])("retains complete code points under the exact %i-byte grant", (bytes, expected) => {
    const original = pack("a😀b🚀z");
    const fitted = withPromptExcerptBudget(original, bytes);
    const excerpt = fitted.files[0]?.excerpts[0];
    const content = excerpt?.content ?? "";
    expect(content).toBe(expected);
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(bytes);
    if (excerpt !== undefined) expect(excerpt.contentBytes).toBe(Buffer.byteLength(content));
    expect(original.files[0]?.excerpts[0]?.content).toBe("a😀b🚀z");
  });

  it.each(["a\ud83dz", "a\ude00z"])("preserves an existing lone surrogate in %j", (content) => {
    const fitted = withPromptExcerptBudget(pack(content), 4);
    expect(fitted.files[0]?.excerpts[0]?.content).toBe(content.slice(0, 2));
    expect(fitted.files[0]?.excerpts[0]?.contentBytes).toBe(4);
  });

  it.each(["é中😀", "untrimmed \ud83d source"])("preserves full-fit source text %j", (content) => {
    expect(
      withPromptExcerptBudget(pack(content), Buffer.byteLength(content)).files[0]?.excerpts[0]
        ?.content,
    ).toBe(content);
  });
});
