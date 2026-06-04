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

  it("ring's worst-case excerpt size stays within its weighted budget slice", () => {
    // Copilot review on PR #250: maxBytesPerFileScanned has an 8 KiB floor; maxFilesScanned
    // must be capped so files * bytes-per-file <= weighted slice of excerptBytesMax. This
    // keeps the budget governor's per-dimension semantics deterministic across small rings.
    const p = plan({
      scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
      query: happyQuery({ text: "look at src/a/b.ts and `Foo` and src/c/d.ts" }),
    });
    expect(p.state).toBe("ready");
    const weights: Record<string, number> = {
      lexical: 0.55,
      structural: 0.3,
      "git-history": 0.15,
    };
    for (const ring of p.rings) {
      const weight = weights[ring.kind] ?? 0;
      const slice = p.budget.excerptBytesMax * weight;
      const worstCase =
        ring.searchLimits.maxFilesScanned * ring.searchLimits.maxBytesPerFileScanned;
      // Worst case is allowed up to the floor adjustment (maxFilesScanned floor of 1) +
      // maxBytesPerFileScanned. Both honoured per dimension; product is bounded.
      expect(worstCase).toBeLessThanOrEqual(
        Math.max(slice, ring.searchLimits.maxBytesPerFileScanned),
      );
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
