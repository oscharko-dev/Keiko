// PR4-W1 unit tests for the grounded diagnostics observer (ADR-0055 D1). Pure, no IO, no clock.
// Proves the five W1 gates at the observer level:
//  - ac5ByteIdentical:  buildGroundedGatewayMessages is deep-equal with vs without the observer.
//  - diagnosticsPresent: pack.diagnostics.contextBudget is defined + validates.
//  - firstRingPreserved: existing rankedCandidates survive unchanged.
//  - stableIdUnchanged:  pack.stableId before === after.
//  - additive isolation: files / budget / usage are reference-identical after the observer.

import { describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  DEFAULT_CONTEXT_PROFILE,
  validateContextAssemblyDiagnostics,
  validateContextBudget,
  type ConnectedContextPack,
  type ContextPackDiagnostics,
} from "@oscharko-dev/keiko-contracts";
import {
  attachContextBudgetDiagnostics,
  deriveGroundedContextAssembly,
} from "./grounded-context-diagnostics.js";
import { buildGroundedGatewayMessages } from "./grounded-qa.js";

const NOW = 1_700_000_000_000;
const identity = <T>(value: T): T => value;

function basePack(): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-w1-observer",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "cs-test",
      workspaceRoot: "/repo",
      kind: "directory",
      relativePaths: ["src"],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "How does MyClass work?",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: {
      searchCallsMax: 1,
      filesReadMax: 4,
      excerptBytesMax: 1024,
      modelInputTokensMax: 1024,
      modelOutputTokensMax: 256,
      elapsedMsMax: 1000,
      rerankCallsMax: 0,
    },
    usage: {
      searchCalls: 1,
      filesRead: 2,
      excerptBytes: 68,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 5,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath: "src/foo.ts",
        role: "read-only",
        selectionReason: "ranked by alpha",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: "atom-low",
              scopePath: "src/foo.ts",
              lineRange: { startLine: 10, endLine: 20 },
              score: 0.3,
              provenance: {
                kind: "lexical-search",
                tool: "repo.searchText",
                queryFingerprint: "fp-1",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            content: "function MyClass() { return 'foo'; }",
            contentBytes: 36,
          },
        ],
      },
      {
        scopePath: "src/bar.ts",
        role: "read-only",
        selectionReason: "ranked by alpha",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: "atom-high",
              scopePath: "src/bar.ts",
              lineRange: undefined,
              score: 0.9,
              provenance: {
                kind: "structural",
                tool: "structural.importGraph",
                queryFingerprint: "fp-2",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            content: "import { MyClass } from './foo';",
            contentBytes: 32,
          },
        ],
      },
    ],
    omitted: [{ scopePath: "src/baz.ts", reason: "low-relevance", omittedAtMs: NOW }],
    uncertainty: [
      {
        kind: "no-evidence",
        claim: "excerpt unavailable for src/baz.ts",
        impactedAtomIds: [],
        emittedAtMs: NOW,
      },
    ],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

const RANKED: ContextPackDiagnostics = {
  rankedCandidates: [
    {
      scopePath: "src/bar.ts",
      bucket: "import-graph",
      score: 0.9,
      ecosystem: undefined,
      signals: [{ name: "path-term", value: 1 }],
    },
  ],
};

function packWithRanked(): ConnectedContextPack {
  return { ...basePack(), diagnostics: RANKED };
}

function emptyPack(): ConnectedContextPack {
  return { ...basePack(), files: [] };
}

describe("attachContextBudgetDiagnostics — AC5 (grounded prompt byte-identical)", () => {
  it("produces a deep-equal message array with vs without the observer (files present)", () => {
    const pack = basePack();
    const observed = attachContextBudgetDiagnostics(pack, DEFAULT_CONTEXT_PROFILE);
    expect(buildGroundedGatewayMessages("How does MyClass work?", observed, identity)).toEqual(
      buildGroundedGatewayMessages("How does MyClass work?", pack, identity),
    );
  });

  it("produces a deep-equal message array on an empty pack", () => {
    const pack = emptyPack();
    const observed = attachContextBudgetDiagnostics(pack, DEFAULT_CONTEXT_PROFILE);
    expect(buildGroundedGatewayMessages("q", observed, identity)).toEqual(
      buildGroundedGatewayMessages("q", pack, identity),
    );
  });

  it("produces a deep-equal message array when a pre-existing ranked diagnostics block exists", () => {
    const pack = packWithRanked();
    const observed = attachContextBudgetDiagnostics(pack, DEFAULT_CONTEXT_PROFILE);
    expect(buildGroundedGatewayMessages("q", observed, identity)).toEqual(
      buildGroundedGatewayMessages("q", pack, identity),
    );
  });
});

describe("attachContextBudgetDiagnostics — diagnosticsPresent", () => {
  it("populates a defined, valid ContextBudget carrying the supplied profile", () => {
    const observed = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    const budget = observed.diagnostics?.contextBudget;
    expect(budget).toBeDefined();
    expect(validateContextBudget(budget).ok).toBe(true);
    expect(budget?.profile).toBe(DEFAULT_CONTEXT_PROFILE);
    expect(budget?.schemaVersion).toBe(CONTEXT_ENGINEERING_SCHEMA_VERSION);
    expect(budget?.lanes.some((lane) => lane.laneId === "repo-evidence")).toBe(true);
  });

  it("populates a valid ContextBudget even when the pack has no evidence", () => {
    const observed = attachContextBudgetDiagnostics(emptyPack(), DEFAULT_CONTEXT_PROFILE);
    expect(validateContextBudget(observed.diagnostics?.contextBudget).ok).toBe(true);
  });
});

describe("attachContextBudgetDiagnostics — firstRingPreserved", () => {
  it("preserves an existing rankedCandidates block unchanged", () => {
    const observed = attachContextBudgetDiagnostics(packWithRanked(), DEFAULT_CONTEXT_PROFILE);
    expect(observed.diagnostics?.rankedCandidates).toEqual(RANKED.rankedCandidates);
  });

  it("creates an empty rankedCandidates array when no diagnostics existed", () => {
    const observed = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    expect(observed.diagnostics?.rankedCandidates).toEqual([]);
  });
});

describe("attachContextBudgetDiagnostics — additive isolation", () => {
  it("leaves stableId unchanged", () => {
    const pack = basePack();
    expect(attachContextBudgetDiagnostics(pack, DEFAULT_CONTEXT_PROFILE).stableId).toBe(
      pack.stableId,
    );
  });

  it("returns reference-identical files, budget and usage", () => {
    const pack = basePack();
    const observed = attachContextBudgetDiagnostics(pack, DEFAULT_CONTEXT_PROFILE);
    expect(observed.files).toBe(pack.files);
    expect(observed.budget).toBe(pack.budget);
    expect(observed.usage).toBe(pack.usage);
    expect(observed.scope).toBe(pack.scope);
    expect(observed.query).toBe(pack.query);
  });

  it("does not mutate the input pack diagnostics", () => {
    const pack = packWithRanked();
    attachContextBudgetDiagnostics(pack, DEFAULT_CONTEXT_PROFILE);
    expect(pack.diagnostics).toBe(RANKED);
    expect(pack.diagnostics?.contextBudget).toBeUndefined();
  });
});

describe("deriveGroundedContextAssembly — evidence producer (ADR-0056 W3)", () => {
  it("returns a valid ContextAssemblyDiagnostics for a pack with excerpts", () => {
    const diagnostics = deriveGroundedContextAssembly(basePack(), DEFAULT_CONTEXT_PROFILE);
    expect(validateContextAssemblyDiagnostics(diagnostics).ok).toBe(true);
    expect(diagnostics.schemaVersion).toBe(CONTEXT_ENGINEERING_SCHEMA_VERSION);
    expect(diagnostics.profile).toBe(DEFAULT_CONTEXT_PROFILE);
    expect(diagnostics.lanes.some((lane) => lane.laneId === "repo-evidence")).toBe(true);
    expect(diagnostics.orderedForRecency).toBe(true);
  });

  it("returns the richer ContextAssemblyDiagnostics type, not the ContextBudget slot value", () => {
    const diagnostics = deriveGroundedContextAssembly(basePack(), DEFAULT_CONTEXT_PROFILE);
    // ContextAssemblyDiagnostics carries totalEstimatedTokens + budgetPressure + lanes; the
    // ContextBudget the observer attaches carries `lanes: ContextLaneBudget[]` (maxTokens rows).
    expect(typeof diagnostics.totalEstimatedTokens).toBe("number");
    expect(diagnostics.budgetPressure).toBeDefined();
    expect(diagnostics.lanes.every((lane) => "estimatedTokens" in lane)).toBe(true);
  });

  it("is deterministic across repeated calls", () => {
    const first = deriveGroundedContextAssembly(basePack(), DEFAULT_CONTEXT_PROFILE);
    const second = deriveGroundedContextAssembly(basePack(), DEFAULT_CONTEXT_PROFILE);
    expect(first).toEqual(second);
  });

  it("validates even when the pack has no evidence", () => {
    const diagnostics = deriveGroundedContextAssembly(emptyPack(), DEFAULT_CONTEXT_PROFILE);
    expect(validateContextAssemblyDiagnostics(diagnostics).ok).toBe(true);
  });

  it("does not mutate the input pack", () => {
    const pack = packWithRanked();
    deriveGroundedContextAssembly(pack, DEFAULT_CONTEXT_PROFILE);
    expect(pack.diagnostics).toBe(RANKED);
    expect(pack.diagnostics?.contextBudget).toBeUndefined();
  });
});
