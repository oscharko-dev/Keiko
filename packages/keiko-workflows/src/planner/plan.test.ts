// Tests for the exploration plan factory (Issue #181).

import { describe, expect, it } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";

import {
  DEFAULT_LEXICAL_MATCH_LIMIT,
  createExplorationPlan,
  directDefinitionSymbol,
  isDirectEvidenceLookup,
  requiresRelationshipOrHistoryRings,
  type ExplorationPlan,
} from "./plan.js";

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
  it.each([
    { excerptBytesMax: 1024, modelInputTokensMax: 4096 },
    { excerptBytesMax: 4096, modelInputTokensMax: 1024 },
  ])("bounds retained lexical metadata by accepted context dimensions %j", (capacity) => {
    const p = createExplorationPlan(
      {
        scope: happyScope({ explicitConnection: true }),
        query: happyQuery({ maxResults: DEFAULT_LEXICAL_MATCH_LIMIT }),
        budget: { ...DEFAULT_EXPLORATION_BUDGET, ...capacity },
      },
      { nowMs: () => 1_700_000_000_000 },
    );
    const lexical = p.rings.find((ring) => ring.kind === "lexical");
    expect(lexical?.searchLimits.maxMatchesReturned).toBe(1024);
    expect(lexical?.searchLimits.maxFilesScanned).toBeNull();
    expect(lexical?.searchLimits.elapsedMsMax).toBeNull();
  });

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

  it("implicit workspace-root still asks for clarification on generic prompts", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: false,
    });
    const q = happyQuery({ text: "tell me everything" });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("clarification-needed");
    expect(p.clarification?.reason).toBe("too-generic");
  });

  it.each(["Was siehst du?", "Wie funktioniert die Anmeldung?", "Warum ist die Suche kaputt?"])(
    "searches an explicitly connected repository without requiring a code anchor: %s",
    (text) => {
      const p = plan({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text }),
      });
      expect(p.state).toBe("ready");
      expect(p.rings.length).toBeGreaterThan(0);
      expect(p.budget).toEqual(DEFAULT_EXPLORATION_BUDGET);
    },
  );

  it("explicitConnection: workspace-root allows project metadata lookups", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const q = happyQuery({ text: "Welche Type-Script Version wird in der App verwendet?" });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("ready");
    expect(p.retrievalIntent).toBe("project-metadata");
    expect(p.clarification).toBeUndefined();
  });

  it("explicitConnection: workspace-root allows repository overview lookups", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const q = happyQuery({ text: "Erkläre grob die Architektur dieses Repositories." });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("ready");
    expect(p.retrievalIntent).toBe("repository-overview");
    expect(p.clarification).toBeUndefined();
  });

  it("explicitConnection: workspace-root allows unquoted symbol lookups", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const q = happyQuery({ text: "Wo ist WindowFrame implementiert?" });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("ready");
    expect(p.retrievalIntent).toBe("targeted-code-search");
    expect(p.anchors.some((anchor) => anchor.term === "windowframe")).toBe(true);
    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical"]);
    expect(p.clarification).toBeUndefined();
  });

  it.each([
    "Untersuche den aktuell verbundenen Ordner rekursiv. Wo sind LateAuxiliaryProbe und DeepAuxiliaryProbe implementiert, und welche Werte liefern sie? Was steht in ADR-987654 und ADR-987655 zum Wartungsintervall? Nenne belegte Dateien und Zeilen und unterscheide fehlende Evidenz von nicht vorhandenen Dateien.",
    "Was steht in ADR-987654 und RFC-987655 zum Wartungsintervall? Nenne belegte Dateien und Zeilen.",
  ])("keeps unparsed multi-clause source questions contextual: %s", (text) => {
    const p = plan({
      scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
      query: happyQuery({ text }),
    });
    expect(p.state).toBe("ready");
    expect(p.targetDecision?.kind).toBe("contextual");
    expect(p.rings[0]?.kind).toBe("lexical");
  });

  it("preserves one-symbol lexical narrowing separately from multi-target direct evidence", () => {
    const query = happyQuery({ text: "Where are WindowFrame and ChatPanel implemented?" });
    const anchors = [
      { term: "windowframe", kind: "identifier", weight: 0.85 },
      { term: "chatpanel", kind: "identifier", weight: 0.85 },
    ] as const;
    expect(isDirectEvidenceLookup(query, anchors)).toBe(true);
    expect(directDefinitionSymbol(query, anchors)).toBeUndefined();
    expect(directDefinitionSymbol(query, anchors.slice(0, 1))).toBeUndefined();
    expect(
      directDefinitionSymbol(
        happyQuery({ text: "Where is WindowFrame implemented?" }),
        anchors.slice(0, 1),
      ),
    ).toBe("windowframe");
  });

  it.each([
    "Wo ist LateDefinitionProbe in den verbundenen Dateien implementiert? Erstelle eine vollständige Tabelle für alle 96 Dateien mit Dateinummer, tatsächlichem Rückgabewert und belegter Definitionszeile. Verwende nur gelesene Werte, keine Vermutungen. Lange Kommentarblöcke vor der Funktion sind keine Implementierung. Gib jeden Rückgabewert an und zitiere jede Definitionszeile.",
    "Where is LateDefinitionProbe implemented? Create a complete table for all 96 files with their actual return values and cited definition lines. Use only read values, no guesses. Long comments before the function are not implementations.",
  ])("retains targets without interpreting output prose as literal-only syntax: %s", (text) => {
    const query = happyQuery({ text });
    const p = plan({
      scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
      query,
    });
    expect(p.state).toBe("ready");
    expect(requiresRelationshipOrHistoryRings(query)).toBe(false);
    expect(isDirectEvidenceLookup(query, p.anchors)).toBe(false);
    expect(p.targetDecision?.kind).toBe("contextual");
    expect(p.targetDecision?.targets.map((target) => target.term)).toContain("latedefinitionprobe");
    expect(p.rings[0]?.kind).toBe("lexical");
  });

  it.each([
    "Wo ist LateDefinitionProbe implementiert und welche Funktionen verwenden LateDefinitionProbe? Verwende nur gelesene Werte, keine Vermutungen.",
    "Where is LateDefinitionProbe defined and which callers use it? Use only read values, no guesses.",
    "Where is LateDefinitionProbe defined and imported? Use only cited evidence.",
    "Where is LateDefinitionProbe defined and when was it changed? Use only read values.",
  ])("preserves real relationships alongside evidence directives: %s", (text) => {
    const query = happyQuery({ text });
    const p = plan({
      scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
      query,
    });
    expect(requiresRelationshipOrHistoryRings(query)).toBe(true);
    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical", "structural", "git-history"]);
  });

  it.each([
    "Where are WindowFrame and ChatPanel defined and called by their callers?",
    "Where are WindowFrame and ChatPanel implemented and imported?",
    "Where are WindowFrame and ChatPanel defined and exercised by integration tests?",
    "Where are WindowFrameTest and ChatPanelSpec implemented?",
    "Where are WindowFrame and ChatPanel defined and how have they changed?",
    "Where are WindowFrame and ChatPanel defined and why do they fail?",
    "Trace the implementation of WindowFrame and ChatPanel from route to handler.",
  ])("preserves requested relationships and diagnostics for multiple targets: %s", (text) => {
    const p = plan({
      scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
      query: happyQuery({ text }),
    });
    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical", "structural", "git-history"]);
  });

  it("explicitConnection: workspace-root allows lowercase definition lookups", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const q = happyQuery({ text: "Where is reconcile_order defined?" });
    const p = plan({ scope, query: q });

    expect(p.anchors).toContainEqual({
      term: "reconcile_order",
      weight: 0.85,
      kind: "identifier",
    });
    expect(p.state).toBe("ready");
    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical"]);
    expect(p.clarification).toBeUndefined();
  });

  it.each(["Where do we define reconcile_order?", "Wo definieren wir reconcile_order?"])(
    "keeps present-tense definition lookup direct: %s",
    (text) => {
      const scope = happyScope({
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
      });
      const p = plan({ scope, query: happyQuery({ text }) });

      expect(p.anchors).toContainEqual({
        term: "reconcile_order",
        weight: 0.85,
        kind: "identifier",
      });
      expect(p.state).toBe("ready");
      expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical"]);
    },
  );

  it.each([
    {
      description: "retains structural retrieval when a symbol question asks for usages",
      text: "Where is WindowFrame defined and used?",
      expectedRings: ["lexical", "structural", "git-history"],
    },
    {
      description: "retains structural retrieval when a symbol question asks where it is called",
      text: "Where is WindowFrame defined and called?",
      expectedRings: ["lexical", "structural", "git-history"],
    },
    {
      description: "keeps route relationship questions on the structural path",
      text: "Where is POST /api/payments/:id/refund defined and used?",
      expectedRings: ["lexical", "structural", "git-history"],
    },
    {
      description: "keeps referenced route questions on the structural and historical path",
      text: "Where is POST /api/payments/:id/refund referenced by its callers?",
      expectedRings: ["lexical", "structural", "git-history"],
    },
    {
      description: "keeps base-form route usage questions on the structural path",
      text: "Where do we use POST /api/payments/:id/refund?",
      expectedRings: ["lexical", "structural", "git-history"],
    },
    {
      description: "keeps dependency questions on the structural path",
      text: "Show the definition and dependencies of WindowFrame",
      expectedRings: ["lexical", "structural", "git-history"],
    },
    {
      description: "keeps ordinary identifiers ending in lowercase test on the direct path",
      text: "Where is ApplicationContest defined?",
      expectedRings: ["lexical"],
    },
  ])("$description", ({ text, expectedRings }): void => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const q = happyQuery({ text });
    const p = plan({ scope, query: q });

    expect(p.rings.map((ring) => ring.kind)).toEqual(expectedRings);
  });

  it("explicitConnection: workspace-root allows API route lookups", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const q = happyQuery({ text: "Which file implements POST /api/payments/:id/refund?" });
    const p = plan({ scope, query: q });
    expect(p.state).toBe("ready");
    expect(p.retrievalIntent).toBe("targeted-code-search");
    expect(p.anchors).toContainEqual({
      term: "/api/payments/:id/refund",
      weight: 0.95,
      kind: "path",
    });
    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical"]);
    expect(p.clarification).toBeUndefined();
  });

  it("retains structural and git rings when an API route question asks for history", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const q = happyQuery({
      text: "Show the recent git history of POST /api/payments/:id/refund",
    });
    const p = plan({ scope, query: q });

    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical", "structural", "git-history"]);
  });

  it("retains git history when a definition question asks who introduced it", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const p = plan({
      scope,
      query: happyQuery({ text: "Who introduced the WindowFrame definition?" }),
    });

    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical", "structural", "git-history"]);
  });

  it("retains structural tracing from a route declaration to its handler", () => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const q = happyQuery({
      text: "Trace POST /api/payments/:id/refund from route to handler",
    });
    const p = plan({ scope, query: q });

    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical", "structural", "git-history"]);
  });

  it("retains route relationship history inside an explicitly connected directory", () => {
    const scope = happyScope({
      kind: "directory",
      relativePaths: ["services/payments"],
      explicitConnection: true,
    });
    const p = plan({
      scope,
      query: happyQuery({ text: "Where is POST /payments/:id referenced and used?" }),
    });

    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical", "structural", "git-history"]);
  });

  it.each([
    ["Trace DELETE /files/*path from route to handler", "/files/*path"],
    ["Trace GET /health from route to handler", "/health"],
    ["Trace GET /orders/{order_id} from route to handler", "/orders/{order_id}"],
  ])("retains structural tracing for bounded route shape %s", (text, routePath) => {
    const scope = happyScope({
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
    });
    const p = plan({ scope, query: happyQuery({ text }) });

    expect(p.anchors).toContainEqual({ term: routePath, weight: 0.95, kind: "path" });
    expect(p.rings.map((ring) => ring.kind)).toEqual(["lexical", "structural", "git-history"]);
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

  it("budget slicing: output limits stay finite while source scan time is uncapped", () => {
    const p = plan({
      scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
      query: happyQuery({ text: "look at src/a/b.ts and `Foo` and src/c/d.ts" }),
    });
    expect(p.state).toBe("ready");
    for (const ring of p.rings) {
      const limits = ring.searchLimits;
      for (const v of [limits.maxMatchesReturned, limits.maxBytesPerFileScanned]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
      }
      expect(limits.elapsedMsMax).toBeNull();
      if (ring.kind === "lexical") {
        expect(limits.maxFilesScanned).toBeNull();
        expect(limits.maxMatchesReturned).toBe(DEFAULT_LEXICAL_MATCH_LIMIT);
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
    // Recursive breadth has no file-count or time cap; excerpt reads retain their own limits.
    expect(lexicalLimits?.maxFilesScanned).toBeNull();
    expect(lexicalLimits?.elapsedMsMax).toBeNull();
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
