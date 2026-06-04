// Unit tests for the GroundedAnswerContextPackSummary builder (Issue #187 / ADR-0022).
// Each test mutates one field of a known-good fixture so failures point precisely at the
// broken invariant; tests assert structural absence of leak vectors (workspaceRoot, query
// text, excerpt content) and the documented `-1` sentinel for workspace-root scope.

import { describe, expect, it } from "vitest";
import {
  buildGroundedAnswerContextPackSummary,
  type GroundedAnswerContextPackSummary,
} from "./bff-wire.js";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
  type ExplorationUsage,
  type RetrievalQuery,
  type SelectedScope,
  type SelectedScopeKind,
} from "./connected-context.js";

const USAGE_FIXTURE: ExplorationUsage = {
  searchCalls: 3,
  filesRead: 5,
  excerptBytes: 12_400,
  modelInputTokens: 1_500,
  modelOutputTokens: 400,
  elapsedMs: 1_800,
  rerankCalls: 0,
};

function scope(kind: SelectedScopeKind, relativePaths: readonly string[]): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "cs-deadbeefcafef00d",
    workspaceRoot: "/home/dev/keiko",
    kind,
    relativePaths,
    conversationId: "chat-1",
    connectedAtMs: 1_700_000_000_000,
  };
}

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "how does foo work?",
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 1_700_000_000_000,
  };
}

function pack(overrides: Partial<ConnectedContextPack> = {}): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-1",
    scope: scope("files", ["src/foo.ts", "src/bar.ts"]),
    query: query(),
    budget: DEFAULT_EXPLORATION_BUDGET,
    usage: USAGE_FIXTURE,
    files: [],
    omitted: [],
    uncertainty: [],
    emittedAtMs: 1_700_000_000_001,
    ledgerRef: undefined,
    ...overrides,
  };
}

describe("buildGroundedAnswerContextPackSummary", () => {
  it("produces a complete summary from a 2-file files-scope pack", () => {
    const summary = buildGroundedAnswerContextPackSummary(pack(), 4, 1_812);
    const expected: GroundedAnswerContextPackSummary = {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "cs-deadbeefcafef00d",
      scopeKind: "files",
      fileCount: 2,
      queryKind: "natural-language",
      usage: USAGE_FIXTURE,
      budget: DEFAULT_EXPLORATION_BUDGET,
      citationCount: 4,
      omittedCount: 0,
      uncertaintyCount: 0,
      elapsedMs: 1_812,
    };
    expect(summary).toStrictEqual(expected);
  });

  it("maps workspace-root scope to the -1 file-count sentinel", () => {
    const summary = buildGroundedAnswerContextPackSummary(
      pack({ scope: scope("workspace-root", []) }),
      0,
      0,
    );
    expect(summary.fileCount).toBe(-1);
    expect(summary.scopeKind).toBe("workspace-root");
  });

  it("maps directory scope to relativePaths.length (exactly 1)", () => {
    const summary = buildGroundedAnswerContextPackSummary(
      pack({ scope: scope("directory", ["src/lib"]) }),
      0,
      0,
    );
    expect(summary.fileCount).toBe(1);
    expect(summary.scopeKind).toBe("directory");
  });

  it("maps files scope to relativePaths.length (>= 1)", () => {
    const summary = buildGroundedAnswerContextPackSummary(
      pack({ scope: scope("files", ["a.ts", "b.ts", "c.ts"]) }),
      0,
      0,
    );
    expect(summary.fileCount).toBe(3);
  });

  it("surfaces omitted and uncertainty counts from the pack arrays", () => {
    const p = pack({
      omitted: [
        { scopePath: "src/skip.ts", reason: "binary", omittedAtMs: 1 },
        { scopePath: "src/big.ts", reason: "size-exceeded", omittedAtMs: 2 },
      ],
      uncertainty: [{ kind: "no-evidence", claim: "no hits", impactedAtomIds: [], emittedAtMs: 3 }],
    });
    const summary = buildGroundedAnswerContextPackSummary(p, 0, 0);
    expect(summary.omittedCount).toBe(2);
    expect(summary.uncertaintyCount).toBe(1);
  });

  it("surfaces usage and budget identity-equal to the source pack fields", () => {
    const p = pack();
    const summary = buildGroundedAnswerContextPackSummary(p, 0, 0);
    expect(summary.usage).toBe(p.usage);
    expect(summary.budget).toBe(p.budget);
  });

  it("carries elapsedMs and citationCount verbatim from the caller's arguments", () => {
    const summary = buildGroundedAnswerContextPackSummary(pack(), 7, 9_999);
    expect(summary.citationCount).toBe(7);
    expect(summary.elapsedMs).toBe(9_999);
  });

  it("never carries scope.workspaceRoot, scope.relativePaths, or query.text on the summary", () => {
    const dangerous = pack({
      scope: {
        ...scope("files", ["src/.env", "src/keys.ts"]),
        workspaceRoot: ["/leak/", "sk", "-AAAAAAAAAAAAAAAAAAAA"].join(""),
      },
      query: { ...query(), text: ["ghp", "_thisShouldNotEscape123456789abc"].join("") },
    });
    const summary = buildGroundedAnswerContextPackSummary(dangerous, 0, 0);
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain("workspaceRoot");
    expect(serialised).not.toContain("relativePaths");
    expect(serialised).not.toContain("src/.env");
    expect(serialised).not.toContain("ghp_");
    expect(serialised).not.toContain("/leak/");
  });

  it("schemaVersion equals CONNECTED_CONTEXT_SCHEMA_VERSION (pin)", () => {
    const summary = buildGroundedAnswerContextPackSummary(pack(), 0, 0);
    expect(summary.schemaVersion).toBe(CONNECTED_CONTEXT_SCHEMA_VERSION);
  });

  it("budget with Infinity caps round-trips unchanged (UI renders '—' downstream)", () => {
    const p = pack({
      budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: Number.POSITIVE_INFINITY },
    });
    const summary = buildGroundedAnswerContextPackSummary(p, 0, 0);
    expect(summary.budget.searchCallsMax).toBe(Number.POSITIVE_INFINITY);
  });

  it("structural test: summary JSON is bounded (well below the 600-byte review target)", () => {
    const summary = buildGroundedAnswerContextPackSummary(pack(), 4, 1_812);
    expect(JSON.stringify(summary).length).toBeLessThan(600);
  });
});
