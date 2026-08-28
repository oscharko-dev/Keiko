import { describe, expect, it } from "vitest";
import type { ConnectedContextPack, ContextExcerpt } from "@oscharko-dev/keiko-contracts";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
} from "@oscharko-dev/keiko-contracts/runtime/connected-context";

import { buildAnswerCitations } from "./grounded-citation-projection.js";

const NOW = 1_784_653_600_000;

function excerpt(
  scopePath: string,
  stableId: string,
  startLine: number,
  endLine: number,
  score: number,
): ContextExcerpt {
  return {
    atom: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId,
      scopePath,
      lineRange: { startLine, endLine },
      score,
      provenance: {
        kind: "lexical-search",
        tool: "repo.searchText",
        queryFingerprint: "query",
      },
      redactionState: "redacted",
      emittedAtMs: NOW,
      ledgerRef: undefined,
    },
    content: "evidence",
    contentBytes: 8,
  };
}

function pack(): ConnectedContextPack {
  const zeroUsage = {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
  };
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "scope",
      workspaceRoot: "/repo",
      kind: "workspace-root",
      relativePaths: [],
      conversationId: "chat",
      connectedAtMs: NOW,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text: "question",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    usage: zeroUsage,
    files: [
      {
        scopePath: "scripts/dev-runner.mjs",
        role: "read-only",
        selectionReason: "ranked candidate",
        excerpts: [
          excerpt("scripts/dev-runner.mjs", "single", 38, 38, 0.9),
          excerpt("scripts/dev-runner.mjs", "context-a", 18, 45, 0.2),
          excerpt("scripts/dev-runner.mjs", "context-b", 280, 308, 0.2),
        ],
      },
      {
        scopePath: "src/decoy.ts",
        role: "read-only",
        selectionReason: "ranked candidate",
        excerpts: [excerpt("src/decoy.ts", "decoy", 1, 20, 1)],
      },
    ],
    omitted: [],
    uncertainty: [],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function packWithPathLevelEvidence(): ConnectedContextPack {
  const base = pack();
  const file = base.files[0];
  const first = file?.excerpts[0];
  if (file === undefined || first === undefined) throw new Error("expected fixture evidence");
  return {
    ...base,
    files: [
      {
        ...file,
        scopePath: "AGENTS.md",
        excerpts: [
          {
            ...first,
            atom: {
              ...first.atom,
              stableId: "path-level",
              scopePath: "AGENTS.md",
              lineRange: undefined,
            },
          },
        ],
      },
    ],
  };
}

describe("buildAnswerCitations", () => {
  it("projects only evidence ranges the answer actually cites", () => {
    const citations = buildAnswerCitations(
      pack(),
      "The constant is here [scripts/dev-runner.mjs:18-45] and readiness here " +
        "[scripts/dev-runner.mjs:280-308].",
      (value) => value,
    );

    expect(citations.map((citation) => citation.stableId)).toEqual(["context-a", "context-b"]);
  });

  it("maps a narrower answer range to its containing evidence window once", () => {
    const citations = buildAnswerCitations(
      pack(),
      "One claim [scripts/dev-runner.mjs:30-33], repeated [scripts/dev-runner.mjs:30-33].",
      (value) => value,
    );

    expect(citations).toMatchObject([
      { stableId: "context-a", lineRange: { startLine: 30, endLine: 33 } },
    ]);
  });

  it("does not project a partially overlapping evidence range as support", () => {
    const citations = buildAnswerCitations(
      pack(),
      "The claimed range extends beyond the evidence [scripts/dev-runner.mjs:40-60].",
      (value) => value,
    );

    expect(citations).toEqual([]);
  });

  it("does not surface retrieved decoys or fabricated paths as used citations", () => {
    const citations = buildAnswerCitations(
      pack(),
      "Claim [scripts/dev-runner.mjs:18-45], fabricated [src/missing.ts:1-5].",
      (value) => value,
    );

    expect(citations.map((citation) => citation.scopePath)).toEqual(["scripts/dev-runner.mjs"]);
  });

  it("rejects an exact line range when only path-level evidence is available", () => {
    const citations = buildAnswerCitations(
      packWithPathLevelEvidence(),
      "The invariant is documented here [AGENTS.md:11-18].",
      (value) => value,
    );

    expect(citations).toEqual([]);
  });

  it("deduplicates repeated bare citations to path-level evidence", () => {
    const citations = buildAnswerCitations(
      packWithPathLevelEvidence(),
      "Invariant [AGENTS.md] and modes [AGENTS.md].",
      (value) => value,
    );

    expect(citations).toMatchObject([{ stableId: "path-level", lineRange: undefined }]);
  });

  it("matches before redaction so bracketed replacement tokens cannot drop valid citations", () => {
    const secret = "tenantcredentialvalue987";
    const base = pack();
    const file = base.files[0];
    const first = file?.excerpts[0];
    if (file === undefined || first === undefined) throw new Error("expected fixture evidence");
    const scopePath = `src/${secret}.ts`;
    const secretPack: ConnectedContextPack = {
      ...base,
      files: [
        {
          ...file,
          scopePath,
          excerpts: [{ ...first, atom: { ...first.atom, scopePath } }],
        },
      ],
    };

    const citations = buildAnswerCitations(secretPack, `Grounded [${scopePath}].`, (value) =>
      value.replaceAll(secret, "[REDACTED]"),
    );

    expect(citations).toHaveLength(1);
    expect(citations[0]?.scopePath).toBe("src/[REDACTED].ts");
  });
});
