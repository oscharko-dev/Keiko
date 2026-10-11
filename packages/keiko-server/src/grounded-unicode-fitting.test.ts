import { describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { withPromptExcerptBudget } from "./grounded-qa.js";
import { evidenceAtomStableId } from "@oscharko-dev/keiko-workspace";

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

function matchingPack(
  content: string,
  lineRange: { readonly startLine: number; readonly endLine: number } | undefined,
): ConnectedContextPack {
  const original = pack(content);
  const first = original.files[0];
  const excerpt = first?.excerpts[0];
  if (first === undefined || excerpt === undefined) throw new TypeError("fixture missing");
  return {
    ...original,
    query: { ...original.query, text: "Explain TARGET in src/astral.ts." },
    files: [{ ...first, excerpts: [{ ...excerpt, atom: { ...excerpt.atom, lineRange } }] }],
  };
}

describe("grounded excerpt UTF-8 boundaries", () => {
  it.each([
    ["aa\nTARGET\nbb\n" + "x".repeat(30), 12, "aa\nTARGET\nbb", 51, 53],
    ["x".repeat(30) + "\nTARGET\nbb", 9, "TARGET\nbb", 52, 53],
    ["x".repeat(30) + "\nTARGET\n", 7, "TARGET\n", 52, 52],
    ["TARGET\n" + "x".repeat(30), 6, "TARGET", 51, 51],
    ["TARGET " + "😀".repeat(30) + "\nTARGET", 6, "TARGET", 52, 52],
    ["x\nTARGET " + "😀".repeat(30), 2, "x\n", 51, 51],
  ])(
    "fits %j within %i bytes with truthful source coordinates",
    (content, bytes, expected, startLine, endLine) => {
      const original = matchingPack(content, { startLine: 51, endLine: 54 });
      const fitted = withPromptExcerptBudget(original, bytes);
      expect(fitted.files[0]?.excerpts[0]).toMatchObject({
        content: expected,
        contentBytes: Buffer.byteLength(expected),
        atom: { lineRange: { startLine, endLine } },
      });
      expect(original.files[0]?.excerpts[0]?.content).toBe(content);
    },
  );

  it("keeps prefix fitting for an unlocated excerpt instead of inventing line coordinates", () => {
    const original = matchingPack("pre😀\nTARGET", undefined);
    const fitted = withPromptExcerptBudget(original, 6);
    expect(fitted.files[0]?.excerpts[0]).toMatchObject({
      content: "pre",
      contentBytes: 3,
      atom: { stableId: "unicode-atom", lineRange: undefined },
    });
  });

  it("keeps a fitting late matching line and rebinds its physical range and identity", () => {
    const fact = "const LAST_BOUNDARY_0807 = 7;";
    const original = pack(`header\n${"😀".repeat(2_040)}\n${fact}`);
    const first = original.files[0];
    const excerpt = first?.excerpts[0];
    if (first === undefined || excerpt === undefined) throw new TypeError("fixture missing");
    const located = {
      ...original,
      query: { ...original.query, text: "Explain LAST_BOUNDARY_0807 in src/astral.ts:1-3." },
      files: [
        {
          ...first,
          excerpts: [
            {
              ...excerpt,
              atom: {
                ...excerpt.atom,
                lineRange: { startLine: 1, endLine: 3 },
              },
            },
          ],
        },
      ],
    };
    const fitted = withPromptExcerptBudget(located, Buffer.byteLength(fact));
    const sent = fitted.files[0]?.excerpts[0];
    expect(sent).toMatchObject({
      content: fact,
      contentBytes: Buffer.byteLength(fact),
      atom: {
        lineRange: { startLine: 3, endLine: 3 },
        stableId: evidenceAtomStableId({
          scopeId: located.scope.scopeId,
          scopePath: excerpt.atom.scopePath,
          lineRange: { startLine: 3, endLine: 3 },
          provenanceKind: excerpt.atom.provenance.kind,
          provenanceTool: excerpt.atom.provenance.tool,
          queryFingerprint: excerpt.atom.provenance.queryFingerprint,
        }),
      },
    });
    expect(excerpt.content).toContain("😀");
  });

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
