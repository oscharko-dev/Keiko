// Tests for the exploration plan factory (Issue #181).

import { describe, expect, it } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";

import { createExplorationPlan, type ExplorationPlan } from "./plan.js";

function happyScope(overrides: Partial<SelectedScope> = {}): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-1",
    workspaceRoot: "/work",
    kind: "directory",
    relativePaths: ["src"],
    conversationId: undefined,
    connectedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function happyQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Investigate src/foo/bar.ts behaviour of `MyClass`",
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function plan(
  overrides: { scope?: SelectedScope; query?: RetrievalQuery; maxAnchors?: number } = {},
): ExplorationPlan {
  return createExplorationPlan(
    {
      scope: overrides.scope ?? happyScope(),
      query: overrides.query ?? happyQuery(),
      ...(overrides.maxAnchors !== undefined ? { maxAnchors: overrides.maxAnchors } : {}),
    },
    { nowMs: () => 1_700_000_000_000 },
  );
}

describe("createExplorationPlan", () => {
  it("happy path: well-formed scope + path/identifier query → ready, lexical + structural", () => {
    const p = plan();
    expect(p.state).toBe("ready");
    expect(p.clarification).toBeUndefined();
    const ringKinds = p.rings.map((r) => r.kind);
    expect(ringKinds).toContain("lexical");
    expect(ringKinds).toContain("structural");
    expect(ringKinds).not.toContain("git-history");
  });

  it("invalid scope falls into scope-invalid with empty rings", () => {
    const bad = happyScope({ scopeId: "" });
    const p = plan({ scope: bad });
    expect(p.state).toBe("scope-invalid");
    expect(p.rings).toEqual([]);
    expect(p.clarification).toBeDefined();
  });

  it("scope-invalid plan carries clarification.reason = scope-invalid", () => {
    // Copilot review on PR #250: a scope-validation failure should not surface as a
    // misleading "no-anchors" reason in UI/telemetry. The reason MUST match the plan state.
    const bad = happyScope({ scopeId: "" });
    const p = plan({ scope: bad });
    expect(p.clarification?.reason).toBe("scope-invalid");
  });

  it("zero anchors → clarification-needed reason no-anchors", () => {
    const q = happyQuery({ text: "the and for of" });
    const p = plan({ query: q });
    expect(p.state).toBe("clarification-needed");
    expect(p.clarification?.reason).toBe("no-anchors");
    expect(p.clarification?.suggestedQuestions.length).toBeGreaterThanOrEqual(1);
    expect(p.clarification?.suggestedQuestions.length).toBeLessThanOrEqual(3);
    expect(p.rings).toEqual([]);
  });

  it("only literal anchors → clarification-needed reason too-generic", () => {
    const q = happyQuery({ text: "alpha bravo charlie delta" });
    const p = plan({ query: q });
    expect(p.state).toBe("clarification-needed");
    expect(p.clarification?.reason).toBe("too-generic");
  });

  it("empty relativePaths + only one anchor → clarification-needed reason scope-empty", () => {
    const scope = happyScope({ kind: "workspace-root", relativePaths: [] });
    const q = happyQuery({ text: "`Solo`" });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("clarification-needed");
    expect(p.clarification?.reason).toBe("scope-empty");
  });

  it("explicitConnection: only-literal anchors → ready (no too-generic refusal)", () => {
    // A user who explicitly connected a folder may ask plain natural-language questions; the
    // too-generic gate must not refuse them. Same query that yields too-generic above.
    const scope = happyScope({
      kind: "directory",
      relativePaths: ["src"],
      explicitConnection: true,
    });
    const q = happyQuery({ text: "explain the architecture" });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("ready");
    expect(p.clarification).toBeUndefined();
    expect(p.rings.map((r) => r.kind)).toContain("lexical");
  });

  it("explicitConnection: empty relativePaths + one anchor → ready (no scope-empty refusal)", () => {
    const scope = happyScope({
      kind: "directory",
      relativePaths: ["src"],
      explicitConnection: true,
    });
    const q = happyQuery({ text: "`Solo`" });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("ready");
    expect(p.clarification).toBeUndefined();
  });

  it("explicitConnection: workspace-root still asks for clarification on generic prompts", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const q = happyQuery({ text: "explain the architecture" });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("clarification-needed");
    expect(p.clarification?.reason).toBe("too-generic");
  });

  it("explicitConnection still requires at least one anchor (no-anchors holds)", () => {
    // The relaxation only waives the generic/scope gates; a pure stop-word query has nothing to
    // search, so it must still ask for an anchor.
    const scope = happyScope({ explicitConnection: true });
    const q = happyQuery({ text: "the and for of" });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("clarification-needed");
    expect(p.clarification?.reason).toBe("no-anchors");
  });

  it("workspace-root scope + 2+ anchors → lexical + git-history (no structural unless ident/path)", () => {
    const scope = happyScope({ kind: "workspace-root", relativePaths: [] });
    const q = happyQuery({ text: '"alpha bravo" "charlie delta"' });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("ready");
    const ringKinds = p.rings.map((r) => r.kind);
    expect(ringKinds).toContain("lexical");
    expect(ringKinds).toContain("git-history");
    expect(ringKinds).not.toContain("structural");
  });

  it("same input → same planId (determinism)", () => {
    const p1 = plan();
    const p2 = plan();
    expect(p2.planId).toBe(p1.planId);
  });

  it("different query text → different planId", () => {
    const p1 = plan();
    const p2 = plan({ query: happyQuery({ text: "different src/x/y.ts question" }) });
    expect(p2.planId).not.toBe(p1.planId);
  });

  it("planId is exactly pl- followed by 16 lowercase hex chars", () => {
    const p = plan();
    expect(p.planId).toMatch(/^pl-[0-9a-f]{16}$/);
  });

  it("budget slicing: every ring's searchLimits are integers ≥ 1", () => {
    const p = plan({
      scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
      query: happyQuery({ text: "look at src/a/b.ts and `Foo` and src/c/d.ts" }),
    });
    expect(p.state).toBe("ready");
    for (const ring of p.rings) {
      const limits = ring.searchLimits;
      for (const v of [
        limits.maxFilesScanned,
        limits.maxMatchesReturned,
        limits.maxBytesPerFileScanned,
        limits.elapsedMsMax,
      ]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
      }
      expect(limits.maxBytesPerFileScanned).toBeGreaterThanOrEqual(8192);
    }
  });

  it("decouples lexical scan breadth from the excerpt-byte budget so multi-file scopes are reachable", () => {
    // Epic #177 retrieval fix. Lexical/structural scanning is transient — each candidate file is
    // read to match lines, then discarded — and is bounded by elapsedMsMax, NOT by the excerpt-byte
    // budget the model context is built from. The previous coupling
    // (maxFilesScanned * maxBytesPerFileScanned <= excerptBytesMax * weight) capped the lexical
    // ring at ~4 files, so the search never reached a file ranked later than the alphabetically
    // first few. The excerpt READ phase still enforces excerptBytesMax / filesReadMax when it
    // incorporates content into the pack.
    const p = plan({
      scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
      query: happyQuery({ text: "look at src/a/b.ts and `Foo` and src/c/d.ts" }),
    });
    expect(p.state).toBe("ready");
    const lexical = p.rings.find((r) => r.kind === "lexical");
    expect(lexical).toBeDefined();
    const lexicalLimits = lexical?.searchLimits;
    // The number of files an excerpt-byte-derived cap would have allowed (the old, buggy bound).
    const excerptDerivedFiles = Math.floor(
      (p.budget.excerptBytesMax * 0.55) / (lexicalLimits?.maxBytesPerFileScanned ?? 1),
    );
    // Scan breadth must now exceed both that excerpt-derived cap and filesReadMax, so an
    // alphabetically-late but relevant file is still examined.
    expect(lexicalLimits?.maxFilesScanned ?? 0).toBeGreaterThan(excerptDerivedFiles);
    expect(lexicalLimits?.maxFilesScanned ?? 0).toBeGreaterThan(p.budget.filesReadMax);
    // The per-file scan read cap keeps its 8 KiB floor across every ring.
    for (const ring of p.rings) {
      expect(ring.searchLimits.maxBytesPerFileScanned).toBeGreaterThanOrEqual(8192);
    }
  });

  it("uses DEFAULT_EXPLORATION_BUDGET when no budget is supplied", () => {
    const p = plan();
    expect(p.budget).toEqual(DEFAULT_EXPLORATION_BUDGET);
  });

  it("uses provided nowMs for createdAtMs", () => {
    const p = createExplorationPlan(
      { scope: happyScope(), query: happyQuery() },
      { nowMs: () => 42 },
    );
    expect(p.createdAtMs).toBe(42);
  });

  it("preserves schemaVersion as the contracts constant", () => {
    const p = plan();
    expect(p.schemaVersion).toBe(CONNECTED_CONTEXT_SCHEMA_VERSION);
  });
});
