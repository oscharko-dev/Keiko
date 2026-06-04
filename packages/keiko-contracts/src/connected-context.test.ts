// Unit tests for connected-context.ts. Each test mutates exactly one field of a known-good
// fixture so failures point precisely at the broken invariant. The fixtures are intentionally
// minimal: no excerpts, no ledger refs, single happy-path scope. Tests that need extras build
// on top of these.

import { describe, it, expect } from "vitest";
import {
  CANDIDATE_OMISSION_REASONS,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  CONNECTED_FILE_ROLES,
  DEFAULT_EXPLORATION_BUDGET,
  EVIDENCE_ATOM_PROVENANCE_KINDS,
  EVIDENCE_ATOM_REDACTION_STATES,
  RETRIEVAL_QUERY_KINDS,
  SELECTED_SCOPE_KINDS,
  UNCERTAINTY_MARKER_KINDS,
  isValidLineRange,
  isValidScopePath,
  isWithinBudget,
  validateConnectedContextPack,
  validateEvidenceAtom,
  validateRetrievalQuery,
  validateSelectedScope,
} from "./connected-context.js";
import type {
  CandidateOmissionReason,
  ConnectedContextPack,
  ConnectedFileEntry,
  EvidenceAtom,
  EvidenceAtomProvenanceKind,
  EvidenceAtomRedactionState,
  ExplorationBudget,
  ExplorationUsage,
  RetrievalQuery,
  RetrievalQueryKind,
  SelectedScope,
  SelectedScopeKind,
  UncertaintyMarkerKind,
  ValidationResult,
} from "./connected-context.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────
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

function happyAtom(): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "atom-1",
    scopePath: "src/index.ts",
    lineRange: { startLine: 1, endLine: 5 },
    score: 0.5,
    provenance: {
      kind: "lexical-search",
      tool: "repo.searchText",
      queryFingerprint: "fp-1",
    },
    redactionState: "redacted",
    emittedAtMs: 2_000,
    ledgerRef: undefined,
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

function happyPack(): ConnectedContextPack {
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
  };
}

function expectInvalidWithReason(result: ValidationResult, fragment: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.reasons.some((reason) => reason.includes(fragment))).toBe(true);
}

// ─── Schema discriminant ─────────────────────────────────────────────────────
describe("CONNECTED_CONTEXT_SCHEMA_VERSION", () => {
  it("is the literal '1'", () => {
    expect(CONNECTED_CONTEXT_SCHEMA_VERSION).toBe("1");
  });

  it("can be assigned to typeof CONNECTED_CONTEXT_SCHEMA_VERSION", () => {
    const scope: SelectedScope = happyScope();
    expect(scope.schemaVersion).toBe(CONNECTED_CONTEXT_SCHEMA_VERSION);
  });
});

// ─── Default budget ──────────────────────────────────────────────────────────
describe("DEFAULT_EXPLORATION_BUDGET", () => {
  it("has seven independent dimensions, all integer and non-negative", () => {
    const dims: readonly number[] = [
      DEFAULT_EXPLORATION_BUDGET.searchCallsMax,
      DEFAULT_EXPLORATION_BUDGET.filesReadMax,
      DEFAULT_EXPLORATION_BUDGET.excerptBytesMax,
      DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax,
      DEFAULT_EXPLORATION_BUDGET.modelOutputTokensMax,
      DEFAULT_EXPLORATION_BUDGET.elapsedMsMax,
      DEFAULT_EXPLORATION_BUDGET.rerankCallsMax,
    ];
    expect(dims).toHaveLength(7);
    for (const value of dims) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("rerankCallsMax defaults to 0 (rerank disabled)", () => {
    expect(DEFAULT_EXPLORATION_BUDGET.rerankCallsMax).toBe(0);
  });

  it("excerptBytesMax is 128 KiB", () => {
    expect(DEFAULT_EXPLORATION_BUDGET.excerptBytesMax).toBe(131_072);
  });
});

// ─── isValidScopePath ─────────────────────────────────────────────────────────
describe("isValidScopePath", () => {
  const REL = { mustBeRelative: true } as const;

  it("accepts a simple relative file", () => {
    expect(isValidScopePath("src/index.ts", REL)).toBe(true);
  });

  it("accepts a single segment", () => {
    expect(isValidScopePath("a", REL)).toBe(true);
  });

  it("accepts a deeply nested relative path", () => {
    expect(isValidScopePath("deep/nested/path/file.ts", REL)).toBe(true);
  });

  it("accepts a segment containing the substring '..' but not as a segment", () => {
    expect(isValidScopePath("a..b/c", REL)).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidScopePath("", REL)).toBe(false);
  });

  it("rejects absolute POSIX path", () => {
    expect(isValidScopePath("/abs", REL)).toBe(false);
  });

  it("rejects leading parent escape", () => {
    expect(isValidScopePath("../escape", REL)).toBe(false);
  });

  it("rejects embedded parent segment", () => {
    expect(isValidScopePath("foo/../bar", REL)).toBe(false);
  });

  it("accepts a path with a space-only segment", () => {
    expect(isValidScopePath("foo/ /bar", REL)).toBe(true);
  });

  it("rejects NUL byte", () => {
    expect(isValidScopePath("foo\0bar", REL)).toBe(false);
  });

  it("rejects Windows drive prefix", () => {
    expect(isValidScopePath("C:/win", REL)).toBe(false);
  });

  it("rejects UNC prefix", () => {
    expect(isValidScopePath("\\\\unc/share", REL)).toBe(false);
  });

  it("rejects consecutive slashes", () => {
    expect(isValidScopePath("foo//bar", REL)).toBe(false);
  });

  it("rejects leading current-dir segment", () => {
    expect(isValidScopePath("./relative", REL)).toBe(false);
  });

  it("rejects embedded current-dir segment", () => {
    expect(isValidScopePath("foo/./bar", REL)).toBe(false);
  });

  it("rejects when mustBeRelative is false", () => {
    expect(isValidScopePath("src/index.ts", { mustBeRelative: false })).toBe(false);
  });

  it("rejects a path containing a backslash", () => {
    expect(isValidScopePath("src\\file.ts", REL)).toBe(false);
  });

  it("rejects backslash-separated traversal", () => {
    expect(isValidScopePath("foo\\..\\bar", REL)).toBe(false);
  });
});

// ─── isValidLineRange ─────────────────────────────────────────────────────────
describe("isValidLineRange", () => {
  it("accepts single line", () => {
    expect(isValidLineRange({ startLine: 1, endLine: 1 })).toBe(true);
  });

  it("accepts a normal range", () => {
    expect(isValidLineRange({ startLine: 1, endLine: 5 })).toBe(true);
  });

  it("accepts a large range", () => {
    expect(isValidLineRange({ startLine: 42, endLine: 9_999 })).toBe(true);
  });

  it("rejects startLine 0", () => {
    expect(isValidLineRange({ startLine: 0, endLine: 1 })).toBe(false);
  });

  it("rejects endLine 0 when startLine is 1", () => {
    expect(isValidLineRange({ startLine: 1, endLine: 0 })).toBe(false);
  });

  it("rejects endLine < startLine", () => {
    expect(isValidLineRange({ startLine: 5, endLine: 4 })).toBe(false);
  });

  it("rejects fractional start", () => {
    expect(isValidLineRange({ startLine: 1.5, endLine: 5 })).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isValidLineRange({ startLine: Number.NaN, endLine: 5 })).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isValidLineRange({ startLine: 1, endLine: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

// ─── isWithinBudget ───────────────────────────────────────────────────────────
describe("isWithinBudget", () => {
  it("returns true when every dimension equals its cap", () => {
    const usage: ExplorationUsage = {
      searchCalls: DEFAULT_EXPLORATION_BUDGET.searchCallsMax,
      filesRead: DEFAULT_EXPLORATION_BUDGET.filesReadMax,
      excerptBytes: DEFAULT_EXPLORATION_BUDGET.excerptBytesMax,
      modelInputTokens: DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax,
      modelOutputTokens: DEFAULT_EXPLORATION_BUDGET.modelOutputTokensMax,
      elapsedMs: DEFAULT_EXPLORATION_BUDGET.elapsedMsMax,
      rerankCalls: DEFAULT_EXPLORATION_BUDGET.rerankCallsMax,
    };
    expect(isWithinBudget(usage, DEFAULT_EXPLORATION_BUDGET)).toBe(true);
  });

  it("returns false when one dimension is one over", () => {
    const usage: ExplorationUsage = {
      ...happyUsage(),
      searchCalls: DEFAULT_EXPLORATION_BUDGET.searchCallsMax + 1,
    };
    expect(isWithinBudget(usage, DEFAULT_EXPLORATION_BUDGET)).toBe(false);
  });

  it("returns false on negative usage", () => {
    const usage: ExplorationUsage = { ...happyUsage(), filesRead: -1 };
    expect(isWithinBudget(usage, DEFAULT_EXPLORATION_BUDGET)).toBe(false);
  });

  it("returns false on NaN usage", () => {
    const usage: ExplorationUsage = { ...happyUsage(), elapsedMs: Number.NaN };
    expect(isWithinBudget(usage, DEFAULT_EXPLORATION_BUDGET)).toBe(false);
  });
});

// ─── validateSelectedScope ────────────────────────────────────────────────────
describe("validateSelectedScope", () => {
  it("accepts the happy path", () => {
    expect(validateSelectedScope(happyScope())).toEqual({ ok: true });
  });

  it("rejects wrong schemaVersion", () => {
    const scope = { ...happyScope(), schemaVersion: "2" as unknown as "1" };
    expectInvalidWithReason(validateSelectedScope(scope), "schemaVersion");
  });

  it("rejects empty scopeId", () => {
    const scope = { ...happyScope(), scopeId: "" };
    expectInvalidWithReason(validateSelectedScope(scope), "scopeId");
  });

  it("rejects whitespace-only scopeId", () => {
    const scope = { ...happyScope(), scopeId: "   " };
    expectInvalidWithReason(validateSelectedScope(scope), "scopeId");
  });

  it("rejects empty workspaceRoot", () => {
    const scope = { ...happyScope(), workspaceRoot: "" };
    expectInvalidWithReason(validateSelectedScope(scope), "workspaceRoot");
  });

  it("rejects workspace-root scope carrying relative paths", () => {
    const scope: SelectedScope = {
      ...happyScope(),
      kind: "workspace-root",
      relativePaths: ["src"],
    };
    expectInvalidWithReason(validateSelectedScope(scope), "workspace-root");
  });

  it("rejects directory scope with zero paths", () => {
    const scope: SelectedScope = { ...happyScope(), kind: "directory", relativePaths: [] };
    expectInvalidWithReason(validateSelectedScope(scope), "directory");
  });

  it("rejects directory scope with two paths", () => {
    const scope: SelectedScope = {
      ...happyScope(),
      kind: "directory",
      relativePaths: ["src", "tests"],
    };
    expectInvalidWithReason(validateSelectedScope(scope), "directory");
  });

  it("rejects files scope with zero paths", () => {
    const scope: SelectedScope = { ...happyScope(), kind: "files", relativePaths: [] };
    expectInvalidWithReason(validateSelectedScope(scope), "files");
  });

  it("rejects an invalid relative path", () => {
    const scope: SelectedScope = {
      ...happyScope(),
      kind: "files",
      relativePaths: ["../escape"],
    };
    expectInvalidWithReason(validateSelectedScope(scope), "invalid path");
  });

  it("rejects negative connectedAtMs", () => {
    const scope: SelectedScope = { ...happyScope(), connectedAtMs: -1 };
    expectInvalidWithReason(validateSelectedScope(scope), "connectedAtMs");
  });

  it("rejects fractional connectedAtMs", () => {
    const scope: SelectedScope = { ...happyScope(), connectedAtMs: 1.5 };
    expectInvalidWithReason(validateSelectedScope(scope), "connectedAtMs");
  });

  it("rejects empty conversationId when present", () => {
    const scope: SelectedScope = { ...happyScope(), conversationId: "   " };
    expectInvalidWithReason(validateSelectedScope(scope), "conversationId");
  });

  it("accepts directory scope with exactly one path", () => {
    const scope: SelectedScope = {
      ...happyScope(),
      kind: "directory",
      relativePaths: ["src"],
    };
    expect(validateSelectedScope(scope)).toEqual({ ok: true });
  });

  it("accepts files scope with multiple paths", () => {
    const scope: SelectedScope = {
      ...happyScope(),
      kind: "files",
      relativePaths: ["src/a.ts", "src/b.ts"],
    };
    expect(validateSelectedScope(scope)).toEqual({ ok: true });
  });

  it("accumulates multiple distinct reasons", () => {
    const scope: SelectedScope = {
      ...happyScope(),
      scopeId: "",
      workspaceRoot: "",
      connectedAtMs: -1,
    };
    const result = validateSelectedScope(scope);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.length).toBe(3);
    }
  });
});

// ─── validateEvidenceAtom ─────────────────────────────────────────────────────
describe("validateEvidenceAtom", () => {
  it("accepts the happy path with no ledgerRef", () => {
    expect(validateEvidenceAtom(happyAtom())).toEqual({ ok: true });
  });

  it("accepts the happy path with a valid ledgerRef", () => {
    const atom: EvidenceAtom = {
      ...happyAtom(),
      ledgerRef: { evidenceSchemaVersion: "1", runId: "run-1", atomId: undefined },
    };
    expect(validateEvidenceAtom(atom)).toEqual({ ok: true });
  });

  it("accepts undefined lineRange (file-listing case)", () => {
    const atom: EvidenceAtom = {
      ...happyAtom(),
      provenance: { ...happyAtom().provenance, kind: "file-listing" },
      lineRange: undefined,
    };
    expect(validateEvidenceAtom(atom)).toEqual({ ok: true });
  });

  it("rejects schemaVersion mismatch", () => {
    const atom = { ...happyAtom(), schemaVersion: "2" as unknown as "1" };
    expectInvalidWithReason(validateEvidenceAtom(atom), "schemaVersion");
  });

  it("rejects empty stableId", () => {
    expectInvalidWithReason(validateEvidenceAtom({ ...happyAtom(), stableId: "" }), "stableId");
  });

  it("rejects invalid scopePath", () => {
    expectInvalidWithReason(
      validateEvidenceAtom({ ...happyAtom(), scopePath: "../bad" }),
      "scopePath",
    );
  });

  it("rejects invalid lineRange", () => {
    expectInvalidWithReason(
      validateEvidenceAtom({ ...happyAtom(), lineRange: { startLine: 5, endLine: 1 } }),
      "lineRange",
    );
  });

  it("rejects score above 1", () => {
    expectInvalidWithReason(validateEvidenceAtom({ ...happyAtom(), score: 1.1 }), "score");
  });

  it("rejects score below 0", () => {
    expectInvalidWithReason(validateEvidenceAtom({ ...happyAtom(), score: -0.1 }), "score");
  });

  it("rejects NaN score", () => {
    expectInvalidWithReason(validateEvidenceAtom({ ...happyAtom(), score: Number.NaN }), "score");
  });

  it("rejects Infinity score", () => {
    expectInvalidWithReason(
      validateEvidenceAtom({ ...happyAtom(), score: Number.POSITIVE_INFINITY }),
      "score",
    );
  });

  it("rejects unknown provenance.kind", () => {
    const atom = {
      ...happyAtom(),
      provenance: { ...happyAtom().provenance, kind: "unknown" as EvidenceAtomProvenanceKind },
    };
    expectInvalidWithReason(validateEvidenceAtom(atom), "provenance.kind");
  });

  it("rejects empty provenance.tool", () => {
    const atom: EvidenceAtom = {
      ...happyAtom(),
      provenance: { ...happyAtom().provenance, tool: "" },
    };
    expectInvalidWithReason(validateEvidenceAtom(atom), "tool");
  });

  it("rejects empty provenance.queryFingerprint", () => {
    const atom: EvidenceAtom = {
      ...happyAtom(),
      provenance: { ...happyAtom().provenance, queryFingerprint: "" },
    };
    expectInvalidWithReason(validateEvidenceAtom(atom), "queryFingerprint");
  });

  it("rejects unknown redactionState", () => {
    const atom = {
      ...happyAtom(),
      redactionState: "leaked" as EvidenceAtomRedactionState,
    };
    expectInvalidWithReason(validateEvidenceAtom(atom), "redactionState");
  });

  it("rejects negative emittedAtMs", () => {
    expectInvalidWithReason(
      validateEvidenceAtom({ ...happyAtom(), emittedAtMs: -1 }),
      "emittedAtMs",
    );
  });

  it("rejects ledgerRef with wrong evidenceSchemaVersion", () => {
    const atom: EvidenceAtom = {
      ...happyAtom(),
      ledgerRef: {
        evidenceSchemaVersion: "2" as unknown as "1",
        runId: "run-1",
        atomId: undefined,
      },
    };
    expectInvalidWithReason(validateEvidenceAtom(atom), "evidenceSchemaVersion");
  });

  it("rejects ledgerRef with empty runId", () => {
    const atom: EvidenceAtom = {
      ...happyAtom(),
      ledgerRef: { evidenceSchemaVersion: "1", runId: "", atomId: undefined },
    };
    expectInvalidWithReason(validateEvidenceAtom(atom), "runId");
  });

  it("rejects an atom whose ledgerRef.atomId is the empty string", () => {
    const atom: EvidenceAtom = {
      ...happyAtom(),
      ledgerRef: { evidenceSchemaVersion: "1", runId: "run-1", atomId: "" },
    };
    expectInvalidWithReason(validateEvidenceAtom(atom), "atomId");
  });
});

// ─── validateRetrievalQuery ───────────────────────────────────────────────────
describe("validateRetrievalQuery", () => {
  for (const kind of RETRIEVAL_QUERY_KINDS) {
    it(`accepts happy path for kind ${kind}`, () => {
      const query: RetrievalQuery = { ...happyQuery(), kind };
      expect(validateRetrievalQuery(query)).toEqual({ ok: true });
    });
  }

  it("rejects empty text", () => {
    expectInvalidWithReason(validateRetrievalQuery({ ...happyQuery(), text: "" }), "text");
  });

  it("rejects maxResults 0", () => {
    expectInvalidWithReason(
      validateRetrievalQuery({ ...happyQuery(), maxResults: 0 }),
      "maxResults",
    );
  });

  it("rejects Infinity maxResults", () => {
    expectInvalidWithReason(
      validateRetrievalQuery({ ...happyQuery(), maxResults: Number.POSITIVE_INFINITY }),
      "maxResults",
    );
  });

  it("rejects negative emittedAtMs", () => {
    expectInvalidWithReason(
      validateRetrievalQuery({ ...happyQuery(), emittedAtMs: -1 }),
      "emittedAtMs",
    );
  });

  it("rejects unknown kind", () => {
    const query = { ...happyQuery(), kind: "fuzzy" as RetrievalQueryKind };
    expectInvalidWithReason(validateRetrievalQuery(query), "kind");
  });
});

// ─── validateConnectedContextPack ─────────────────────────────────────────────
describe("validateConnectedContextPack", () => {
  it("accepts the happy path", () => {
    expect(validateConnectedContextPack(happyPack())).toEqual({ ok: true });
  });

  it("rejects schemaVersion mismatch", () => {
    const pack = { ...happyPack(), schemaVersion: "2" as unknown as "1" };
    expectInvalidWithReason(validateConnectedContextPack(pack), "schemaVersion");
  });

  it("rejects empty stableId", () => {
    expectInvalidWithReason(
      validateConnectedContextPack({ ...happyPack(), stableId: "" }),
      "stableId",
    );
  });

  it("surfaces nested scope failure", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      scope: { ...happyScope(), scopeId: "" },
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "scopeId");
  });

  it("rejects pack whose scope kind 'files' has no relativePaths", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      scope: { ...happyScope(), kind: "files", relativePaths: [] },
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "files");
  });

  it("surfaces nested query failure", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      query: { ...happyQuery(), text: "" },
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "text");
  });

  it("rejects usage that exceeds the budget on a single dimension", () => {
    const usage: ExplorationUsage = {
      ...happyUsage(),
      searchCalls: DEFAULT_EXPLORATION_BUDGET.searchCallsMax + 1,
    };
    const pack: ConnectedContextPack = { ...happyPack(), usage };
    expectInvalidWithReason(validateConnectedContextPack(pack), "searchCalls");
  });

  it("rejects usage with NaN on a dimension", () => {
    const usage: ExplorationUsage = { ...happyUsage(), elapsedMs: Number.NaN };
    const pack: ConnectedContextPack = { ...happyPack(), usage };
    expectInvalidWithReason(validateConnectedContextPack(pack), "elapsedMs");
  });

  it("rejects a pack with an invalid omitted reason", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      omitted: [
        {
          scopePath: "src/x.ts",
          reason: "not-a-real-reason" as CandidateOmissionReason,
          omittedAtMs: 1,
        },
      ],
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "omitted");
  });

  it("rejects a pack with an invalid uncertainty kind", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      uncertainty: [
        {
          kind: "tea-leaves" as UncertaintyMarkerKind,
          claim: "something",
          impactedAtomIds: [],
          emittedAtMs: 1,
        },
      ],
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "uncertainty");
  });

  it("rejects mismatched contentBytes on a file excerpt", () => {
    const content = "abc";
    const entry: ConnectedFileEntry = {
      scopePath: "src/index.ts",
      role: "read-only",
      selectionReason: "exact-match",
      excerpts: [{ atom: happyAtom(), content, contentBytes: content.length + 1 }],
    };
    const pack: ConnectedContextPack = { ...happyPack(), files: [entry] };
    expectInvalidWithReason(validateConnectedContextPack(pack), "contentBytes");
  });

  it("accepts correct contentBytes for an ASCII excerpt", () => {
    const content = "abc";
    const entry: ConnectedFileEntry = {
      scopePath: "src/index.ts",
      role: "editable",
      selectionReason: "exact-match",
      excerpts: [{ atom: happyAtom(), content, contentBytes: 3 }],
    };
    const pack: ConnectedContextPack = { ...happyPack(), files: [entry] };
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("accepts correct UTF-8 byte length for a multibyte excerpt", () => {
    const content = "é";
    const entry: ConnectedFileEntry = {
      scopePath: "src/index.ts",
      role: "read-only",
      selectionReason: "exact-match",
      excerpts: [{ atom: happyAtom(), content, contentBytes: 2 }],
    };
    const pack: ConnectedContextPack = { ...happyPack(), files: [entry] };
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("surfaces a nested invalid atom inside an excerpt", () => {
    const entry: ConnectedFileEntry = {
      scopePath: "src/index.ts",
      role: "read-only",
      selectionReason: "exact-match",
      excerpts: [
        {
          atom: { ...happyAtom(), score: 1.5 },
          content: "abc",
          contentBytes: 3,
        },
      ],
    };
    const pack: ConnectedContextPack = { ...happyPack(), files: [entry] };
    expectInvalidWithReason(validateConnectedContextPack(pack), "score");
  });

  it("rejects a connected file entry with an invalid role", () => {
    const entry = {
      scopePath: "src/index.ts",
      role: "writable" as ConnectedFileEntry["role"],
      selectionReason: "exact-match",
      excerpts: [],
    } satisfies ConnectedFileEntry;
    const pack: ConnectedContextPack = { ...happyPack(), files: [entry] };
    expectInvalidWithReason(validateConnectedContextPack(pack), "role");
  });

  it("rejects a connected file entry with an invalid scopePath", () => {
    const entry: ConnectedFileEntry = {
      scopePath: "../escape",
      role: "read-only",
      selectionReason: "exact-match",
      excerpts: [],
    };
    const pack: ConnectedContextPack = { ...happyPack(), files: [entry] };
    expectInvalidWithReason(validateConnectedContextPack(pack), "scopePath");
  });

  it("rejects a ledgerRef on the pack with empty runId", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      ledgerRef: { evidenceSchemaVersion: "1", runId: "", atomId: undefined },
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "runId");
  });

  it("rejects a pack whose ledgerRef.atomId is the empty string", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      ledgerRef: { evidenceSchemaVersion: "1", runId: "run-1", atomId: "" },
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "atomId");
  });

  it("rejects omitted entry with absolute scopePath", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      omitted: [{ scopePath: "/abs/escape", reason: "outside-scope", omittedAtMs: 1 }],
    };
    const r = validateConnectedContextPack(pack);
    expect(r.ok).toBe(false);
    expect(
      !r.ok &&
        r.reasons.some((reason) => reason.includes("omitted") && reason.includes("scopePath")),
    ).toBe(true);
  });

  it("rejects omitted entry with traversal scopePath", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      omitted: [{ scopePath: "../escape", reason: "outside-scope", omittedAtMs: 1 }],
    };
    const r = validateConnectedContextPack(pack);
    expect(r.ok).toBe(false);
    expect(
      !r.ok &&
        r.reasons.some((reason) => reason.includes("omitted") && reason.includes("scopePath")),
    ).toBe(true);
  });

  it("rejects a pack whose budget has a NaN cap", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: Number.NaN },
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "searchCallsMax");
  });

  it("rejects a pack whose budget has a negative cap", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: -1 },
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "filesReadMax");
  });

  it("rejects a pack whose budget has an Infinity cap", () => {
    const pack: ConnectedContextPack = {
      ...happyPack(),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: Number.POSITIVE_INFINITY },
    };
    expectInvalidWithReason(validateConnectedContextPack(pack), "excerptBytesMax");
  });

  it("rejects a pack with empty selectionReason", () => {
    const entry: ConnectedFileEntry = {
      scopePath: "src/index.ts",
      role: "read-only",
      selectionReason: "",
      excerpts: [],
    };
    const pack: ConnectedContextPack = { ...happyPack(), files: [entry] };
    expectInvalidWithReason(validateConnectedContextPack(pack), "selectionReason");
  });

  it("rejects a pack with whitespace-only selectionReason", () => {
    const entry: ConnectedFileEntry = {
      scopePath: "src/index.ts",
      role: "read-only",
      selectionReason: "   ",
      excerpts: [],
    };
    const pack: ConnectedContextPack = { ...happyPack(), files: [entry] };
    expectInvalidWithReason(validateConnectedContextPack(pack), "selectionReason");
  });

  it("rejects negative pack.emittedAtMs", () => {
    expectInvalidWithReason(
      validateConnectedContextPack({ ...happyPack(), emittedAtMs: -1 }),
      "emittedAtMs",
    );
  });
});

// ─── Frozen-constant arrays ───────────────────────────────────────────────────
describe("frozen-constant arrays", () => {
  const arrays: readonly (readonly [string, readonly string[]])[] = [
    ["SELECTED_SCOPE_KINDS", SELECTED_SCOPE_KINDS],
    ["EVIDENCE_ATOM_PROVENANCE_KINDS", EVIDENCE_ATOM_PROVENANCE_KINDS],
    ["EVIDENCE_ATOM_REDACTION_STATES", EVIDENCE_ATOM_REDACTION_STATES],
    ["RETRIEVAL_QUERY_KINDS", RETRIEVAL_QUERY_KINDS],
    ["CANDIDATE_OMISSION_REASONS", CANDIDATE_OMISSION_REASONS],
    ["UNCERTAINTY_MARKER_KINDS", UNCERTAINTY_MARKER_KINDS],
    ["CONNECTED_FILE_ROLES", CONNECTED_FILE_ROLES],
  ];

  for (const entry of arrays) {
    const name = entry[0];
    const value = entry[1];
    it(`${name} is non-empty`, () => {
      expect(value.length).toBeGreaterThan(0);
    });
    it(`${name} contains only unique entries`, () => {
      expect(new Set(value).size).toBe(value.length);
    });
  }

  it("every SelectedScopeKind appears in SELECTED_SCOPE_KINDS", () => {
    const expected: readonly SelectedScopeKind[] = ["workspace-root", "directory", "files"];
    expect([...SELECTED_SCOPE_KINDS]).toEqual([...expected]);
  });

  it("every EvidenceAtomProvenanceKind appears in EVIDENCE_ATOM_PROVENANCE_KINDS", () => {
    const expected: readonly EvidenceAtomProvenanceKind[] = [
      "lexical-search",
      "file-listing",
      "excerpt-read",
      "structural",
      "git-history",
      "model-rerank",
    ];
    expect([...EVIDENCE_ATOM_PROVENANCE_KINDS]).toEqual([...expected]);
  });

  it("CONNECTED_FILE_ROLES contains both roles", () => {
    expect([...CONNECTED_FILE_ROLES]).toEqual(["read-only", "editable"]);
  });
});

// ─── Budget shape ─────────────────────────────────────────────────────────────
describe("ExplorationBudget shape", () => {
  it("matches usage dimension names", () => {
    const budget: ExplorationBudget = DEFAULT_EXPLORATION_BUDGET;
    const usage: ExplorationUsage = happyUsage();
    expect(Object.keys(budget).sort()).toEqual(
      Object.keys(usage)
        .map((key) => `${key}Max`)
        .sort(),
    );
  });
});
