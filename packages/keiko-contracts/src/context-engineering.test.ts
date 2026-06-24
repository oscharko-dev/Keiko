// Unit tests for context-engineering.ts + context-engineering-validation.ts. Each validator
// test mutates exactly one field of a known-good fixture so a single-line implementation
// mutation is caught and the failure points at the broken invariant. Estimator tests assert
// totality, determinism, monotonicity, and the conservatism bounds from ADR-0052 gate 2.

import { describe, it, expect } from "vitest";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  CONTEXT_EVICTION_POLICIES,
  CONTEXT_LANE_IDS,
  DEFAULT_CONTEXT_PROFILE,
  DEFAULT_TOKEN_ESTIMATOR_ID,
  deriveContextProfile,
  estimateTokens,
  estimateTokensForSegments,
} from "./context-engineering.js";
import type {
  ContextAssemblyDiagnostics,
  ContextBudget,
  ContextLaneBudget,
  ContextLaneDiagnostics,
  ContextProfile,
} from "./context-engineering.js";
import {
  isContextLaneId,
  validateContextAssemblyDiagnostics,
  validateContextBudget,
  validateContextProfile,
} from "./context-engineering-validation.js";
import type { ContextValidationResult } from "./context-engineering-validation.js";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
} from "./connected-context.js";
import type {
  ConnectedContextPack,
  ContextPackDiagnostics,
  ExplorationUsage,
  RetrievalQuery,
  SelectedScope,
} from "./connected-context.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────
function happyProfile(): ContextProfile {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    maxInputTokens: 128_000,
    reservedOutputTokens: 8_000,
    safetyMarginTokens: 4_000,
    effectiveInputBudget: 116_000,
    tokenEstimatorId: DEFAULT_TOKEN_ESTIMATOR_ID,
  };
}

function happyLaneBudget(): ContextLaneBudget {
  return {
    laneId: "system-contract",
    priority: 0,
    maxTokens: 4_000,
    minReservedTokens: 1_000,
    eviction: "none",
  };
}

function happyBudget(): ContextBudget {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    profile: happyProfile(),
    lanes: [happyLaneBudget()],
  };
}

function happyLaneDiagnostics(): ContextLaneDiagnostics {
  return {
    laneId: "repo-evidence",
    estimatedTokens: 1_200,
    includedItems: 4,
    excludedItems: 1,
    budgetPressure: "moderate",
  };
}

function happyAssembly(): ContextAssemblyDiagnostics {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    profile: happyProfile(),
    totalEstimatedTokens: 1_200,
    budgetPressure: "moderate",
    lanes: [happyLaneDiagnostics()],
    orderedForRecency: true,
  };
}

function expectInvalidWithReason(result: ContextValidationResult, fragment: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.reasons.some((reason) => reason.includes(fragment))).toBe(true);
}

// ─── Schema + frozen vocabulary ─────────────────────────────────────────────────
describe("context-engineering vocabulary", () => {
  it("schema version is the literal '1'", () => {
    expect(CONTEXT_ENGINEERING_SCHEMA_VERSION).toBe("1");
  });

  it("declares exactly eight lane ids in allocation order", () => {
    expect(CONTEXT_LANE_IDS).toEqual([
      "system-contract",
      "user-task",
      "active-plan",
      "repo-evidence",
      "tool-observations",
      "working-memory",
      "history-summary",
      "verification-evidence",
    ]);
  });

  it("declares the four eviction policies", () => {
    expect(CONTEXT_EVICTION_POLICIES).toEqual([
      "none",
      "summarize-then-drop",
      "drop-oldest",
      "drop-lowest-score",
    ]);
  });
});

// ─── DEFAULT_CONTEXT_PROFILE ─────────────────────────────────────────────────────
describe("DEFAULT_CONTEXT_PROFILE", () => {
  it("has a 116000 effective input budget", () => {
    expect(DEFAULT_CONTEXT_PROFILE.effectiveInputBudget).toBe(116_000);
  });

  it("validates", () => {
    expect(validateContextProfile(DEFAULT_CONTEXT_PROFILE).ok).toBe(true);
  });

  it("carries the default estimator provenance id", () => {
    expect(DEFAULT_CONTEXT_PROFILE.tokenEstimatorId).toBe("keiko-conservative-utf8-v1");
  });

  it("omits the optional model metadata", () => {
    expect("model" in DEFAULT_CONTEXT_PROFILE).toBe(false);
  });
});

// ─── isContextLaneId ─────────────────────────────────────────────────────────────
describe("isContextLaneId", () => {
  it("accepts every declared lane id", () => {
    for (const id of CONTEXT_LANE_IDS) {
      expect(isContextLaneId(id)).toBe(true);
    }
  });

  it("rejects unknown / non-string values", () => {
    expect(isContextLaneId("not-a-lane")).toBe(false);
    expect(isContextLaneId(42)).toBe(false);
    expect(isContextLaneId(undefined)).toBe(false);
    expect(isContextLaneId(null)).toBe(false);
  });
});

// ─── estimateTokens ──────────────────────────────────────────────────────────────
describe("estimateTokens", () => {
  it("empty string returns the structural overhead constant (never 0/NaN)", () => {
    const result = estimateTokens("");
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(2);
  });

  const cases: readonly string[] = [
    "",
    "hello world",
    "für eine Straße",
    "emoji 😀👨‍👩‍👧‍👦 and surrogate 😀",
    "x".repeat(1_048_576),
  ];

  it("is finite, non-negative, integer and never throws for all fixtures", () => {
    for (const input of cases) {
      const result = estimateTokens(input);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result)).toBe(true);
    }
  });

  it("is deterministic (same input -> same output)", () => {
    for (const input of cases) {
      expect(estimateTokens(input)).toBe(estimateTokens(input));
    }
  });

  it("is monotonic: appending text never lowers the estimate", () => {
    let previous = estimateTokens("");
    let text = "";
    for (const chunk of ["a", "bb", "ccc", "ümlaut", "😀"]) {
      text += chunk;
      const next = estimateTokens(text);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });

  it("is conservative: estimate >= ceil(byteLength / 4) for non-empty inputs", () => {
    for (const input of cases) {
      if (input.length === 0) continue;
      const bytes = new TextEncoder().encode(input).length;
      expect(estimateTokens(input)).toBeGreaterThanOrEqual(Math.ceil(bytes / 4));
    }
  });

  it("has a sane upper bound: estimate <= byteLength + overhead", () => {
    for (const input of cases) {
      const bytes = new TextEncoder().encode(input).length;
      expect(estimateTokens(input)).toBeLessThanOrEqual(bytes + 2);
    }
  });
});

// ─── estimateTokensForSegments ───────────────────────────────────────────────────
describe("estimateTokensForSegments", () => {
  it("empty array returns 0 and never throws", () => {
    expect(estimateTokensForSegments([])).toBe(0);
  });

  it("sums per-segment estimates (per-segment overhead included)", () => {
    const segments = ["alpha", "beta", "gamma"];
    const expected = segments.reduce((sum, s) => sum + estimateTokens(s), 0);
    expect(estimateTokensForSegments(segments)).toBe(expected);
  });

  it("counts empty segments via the structural overhead", () => {
    expect(estimateTokensForSegments(["", ""])).toBe(estimateTokens("") * 2);
  });

  it("is monotonic across appended segments", () => {
    const base = estimateTokensForSegments(["one", "two"]);
    const grown = estimateTokensForSegments(["one", "two", "three"]);
    expect(grown).toBeGreaterThanOrEqual(base);
  });
});

// ─── deriveContextProfile ────────────────────────────────────────────────────────
describe("deriveContextProfile", () => {
  it("derives effectiveInputBudget = max - reserved - safety", () => {
    const profile = deriveContextProfile({
      maxInputTokens: 64_000,
      reservedOutputTokens: 4_000,
      safetyMarginTokens: 2_000,
    });
    expect(profile.effectiveInputBudget).toBe(58_000);
  });

  it("clamps effectiveInputBudget to >= 0 when reserved + safety exceed max", () => {
    const profile = deriveContextProfile({
      maxInputTokens: 1_000,
      reservedOutputTokens: 4_000,
      safetyMarginTokens: 2_000,
    });
    expect(profile.effectiveInputBudget).toBe(0);
  });

  it("sets the schema version and the default estimator id", () => {
    const profile = deriveContextProfile({
      maxInputTokens: 10,
      reservedOutputTokens: 1,
      safetyMarginTokens: 1,
    });
    expect(profile.schemaVersion).toBe(CONTEXT_ENGINEERING_SCHEMA_VERSION);
    expect(profile.tokenEstimatorId).toBe(DEFAULT_TOKEN_ESTIMATOR_ID);
  });

  it("produces a profile that validates", () => {
    const profile = deriveContextProfile({
      maxInputTokens: 32_000,
      reservedOutputTokens: 2_000,
      safetyMarginTokens: 1_000,
    });
    expect(validateContextProfile(profile).ok).toBe(true);
  });

  it("is deterministic (same input -> same output)", () => {
    const input = {
      maxInputTokens: 100,
      reservedOutputTokens: 10,
      safetyMarginTokens: 5,
    };
    expect(deriveContextProfile(input)).toEqual(deriveContextProfile(input));
  });
});

// ─── validateContextProfile ──────────────────────────────────────────────────────
describe("validateContextProfile", () => {
  it("accepts the happy fixture", () => {
    expect(validateContextProfile(happyProfile()).ok).toBe(true);
  });

  it("accepts an optional valid model metadata block", () => {
    expect(
      validateContextProfile({
        ...happyProfile(),
        model: { id: "m", provider: "p", notes: "n" },
      }).ok,
    ).toBe(true);
  });

  it("rejects a non-object", () => {
    expectInvalidWithReason(validateContextProfile(null), "profile invalid");
  });

  it("rejects a wrong schema version", () => {
    expectInvalidWithReason(
      validateContextProfile({ ...happyProfile(), schemaVersion: "2" }),
      "schemaVersion",
    );
  });

  it("rejects a negative maxInputTokens", () => {
    expectInvalidWithReason(
      validateContextProfile({ ...happyProfile(), maxInputTokens: -1 }),
      "maxInputTokens",
    );
  });

  it("rejects a non-finite reservedOutputTokens", () => {
    expectInvalidWithReason(
      validateContextProfile({ ...happyProfile(), reservedOutputTokens: Number.NaN }),
      "reservedOutputTokens",
    );
  });

  it("rejects a non-numeric safetyMarginTokens", () => {
    expectInvalidWithReason(
      validateContextProfile({ ...happyProfile(), safetyMarginTokens: "x" }),
      "safetyMarginTokens",
    );
  });

  it("rejects an effectiveInputBudget that breaks the identity", () => {
    expectInvalidWithReason(
      validateContextProfile({ ...happyProfile(), effectiveInputBudget: 999 }),
      "effectiveInputBudget mismatch",
    );
  });

  it("rejects an empty tokenEstimatorId", () => {
    expectInvalidWithReason(
      validateContextProfile({ ...happyProfile(), tokenEstimatorId: "  " }),
      "tokenEstimatorId",
    );
  });

  it("rejects a non-string model field", () => {
    expectInvalidWithReason(
      validateContextProfile({ ...happyProfile(), model: { id: 42 } }),
      "model.id",
    );
  });

  it("rejects a non-object model", () => {
    expectInvalidWithReason(
      validateContextProfile({ ...happyProfile(), model: "nope" }),
      "model invalid",
    );
  });

  it("is deterministic", () => {
    const value = happyProfile();
    expect(validateContextProfile(value)).toEqual(validateContextProfile(value));
  });
});

// ─── validateContextBudget ───────────────────────────────────────────────────────
describe("validateContextBudget", () => {
  it("accepts the happy fixture", () => {
    expect(validateContextBudget(happyBudget()).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expectInvalidWithReason(validateContextBudget(7), "budget invalid");
  });

  it("rejects a wrong schema version", () => {
    expectInvalidWithReason(
      validateContextBudget({ ...happyBudget(), schemaVersion: "0" }),
      "budget.schemaVersion",
    );
  });

  it("propagates an invalid nested profile", () => {
    expectInvalidWithReason(
      validateContextBudget({
        ...happyBudget(),
        profile: { ...happyProfile(), maxInputTokens: -5 },
      }),
      "budget.profile.maxInputTokens",
    );
  });

  it("rejects non-array lanes", () => {
    expectInvalidWithReason(
      validateContextBudget({ ...happyBudget(), lanes: "x" }),
      "budget.lanes invalid",
    );
  });

  it("rejects a lane with an invalid laneId", () => {
    expectInvalidWithReason(
      validateContextBudget({
        ...happyBudget(),
        lanes: [{ ...happyLaneBudget(), laneId: "bogus" }],
      }),
      "laneId",
    );
  });

  it("rejects a lane with a negative maxTokens", () => {
    expectInvalidWithReason(
      validateContextBudget({
        ...happyBudget(),
        lanes: [{ ...happyLaneBudget(), maxTokens: -1 }],
      }),
      "maxTokens",
    );
  });

  it("rejects a lane with an invalid eviction policy", () => {
    expectInvalidWithReason(
      validateContextBudget({
        ...happyBudget(),
        lanes: [{ ...happyLaneBudget(), eviction: "evict-all" }],
      }),
      "eviction",
    );
  });
});

// ─── validateContextAssemblyDiagnostics ────────────────────────────────────────
describe("validateContextAssemblyDiagnostics", () => {
  it("accepts the happy fixture", () => {
    expect(validateContextAssemblyDiagnostics(happyAssembly()).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expectInvalidWithReason(validateContextAssemblyDiagnostics(undefined), "assembly invalid");
  });

  it("rejects a wrong schema version", () => {
    expectInvalidWithReason(
      validateContextAssemblyDiagnostics({ ...happyAssembly(), schemaVersion: "x" }),
      "assembly.schemaVersion",
    );
  });

  it("rejects a negative totalEstimatedTokens", () => {
    expectInvalidWithReason(
      validateContextAssemblyDiagnostics({ ...happyAssembly(), totalEstimatedTokens: -1 }),
      "totalEstimatedTokens",
    );
  });

  it("rejects an invalid budgetPressure", () => {
    expectInvalidWithReason(
      validateContextAssemblyDiagnostics({ ...happyAssembly(), budgetPressure: "panic" }),
      "budgetPressure",
    );
  });

  it("rejects a non-boolean orderedForRecency", () => {
    expectInvalidWithReason(
      validateContextAssemblyDiagnostics({ ...happyAssembly(), orderedForRecency: "yes" }),
      "orderedForRecency",
    );
  });

  it("rejects non-array lanes", () => {
    expectInvalidWithReason(
      validateContextAssemblyDiagnostics({ ...happyAssembly(), lanes: {} }),
      "assembly.lanes invalid",
    );
  });

  it("rejects a lane diagnostic with an invalid laneId", () => {
    expectInvalidWithReason(
      validateContextAssemblyDiagnostics({
        ...happyAssembly(),
        lanes: [{ ...happyLaneDiagnostics(), laneId: "nope" }],
      }),
      "laneId",
    );
  });

  it("rejects a lane diagnostic with a non-string compactionReason", () => {
    expectInvalidWithReason(
      validateContextAssemblyDiagnostics({
        ...happyAssembly(),
        lanes: [{ ...happyLaneDiagnostics(), compactionReason: 5 }],
      }),
      "compactionReason",
    );
  });

  it("rejects a lane diagnostic with a non-numeric provenanceCounts value", () => {
    expectInvalidWithReason(
      validateContextAssemblyDiagnostics({
        ...happyAssembly(),
        lanes: [{ ...happyLaneDiagnostics(), provenanceCounts: { a: "x" } }],
      }),
      "provenanceCounts",
    );
  });

  it("accepts a valid provenanceCounts block", () => {
    expect(
      validateContextAssemblyDiagnostics({
        ...happyAssembly(),
        lanes: [{ ...happyLaneDiagnostics(), provenanceCounts: { lexical: 3, semantic: 0 } }],
      }).ok,
    ).toBe(true);
  });
});

// ─── Backward compatibility: ContextPackDiagnostics.contextBudget? ──────────────
function happyScope(): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-1",
    workspaceRoot: "/abs/workspace",
    kind: "workspace-root",
    relativePaths: [],
    conversationId: undefined,
    connectedAtMs: 1_000,
  };
}

function happyQuery(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "where is the budget governor",
    caseSensitive: false,
    maxResults: 10,
    emittedAtMs: 3_000,
  };
}

function happyUsage(): ExplorationUsage {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
  };
}

function packWithDiagnostics(diagnostics: ContextPackDiagnostics): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-1",
    scope: happyScope(),
    query: happyQuery(),
    budget: DEFAULT_EXPLORATION_BUDGET,
    usage: happyUsage(),
    files: [],
    omitted: [],
    uncertainty: [],
    emittedAtMs: 4_000,
    ledgerRef: undefined,
    diagnostics,
  };
}

describe("ContextPackDiagnostics.contextBudget? backward compatibility", () => {
  it("a legacy pack with no diagnostics validates", () => {
    const pack: ConnectedContextPack = {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: "pack-legacy",
      scope: happyScope(),
      query: happyQuery(),
      budget: DEFAULT_EXPLORATION_BUDGET,
      usage: happyUsage(),
      files: [],
      omitted: [],
      uncertainty: [],
      emittedAtMs: 4_000,
      ledgerRef: undefined,
    };
    expect(validateConnectedContextPack(pack).ok).toBe(true);
  });

  it("diagnostics with contextBudget ABSENT validates", () => {
    const pack = packWithDiagnostics({ rankedCandidates: [] });
    expect(validateConnectedContextPack(pack).ok).toBe(true);
  });

  it("diagnostics with a VALID contextBudget validates", () => {
    const pack = packWithDiagnostics({ rankedCandidates: [], contextBudget: happyBudget() });
    expect(validateConnectedContextPack(pack).ok).toBe(true);
  });

  it("diagnostics with an INVALID contextBudget fails with a scoped reason", () => {
    const pack = packWithDiagnostics({
      rankedCandidates: [],
      // @ts-expect-error invalid schemaVersion literal exercises the runtime validator rejection path
      contextBudget: { ...happyBudget(), schemaVersion: "9" },
    });
    const result = validateConnectedContextPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.some((r) => r.includes("contextBudget"))).toBe(true);
    }
  });
});
