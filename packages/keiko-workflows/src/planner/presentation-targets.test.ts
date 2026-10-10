import { describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { extractAnchors } from "./anchors.js";
import { createExplorationPlan, requiresRelationshipOrHistoryRings } from "./plan.js";

const SOURCE = "packages/keiko-server/src/grounded-answer-assessment.ts";
const ORIGINAL =
  `Explain how ${SOURCE} separates learned knowledge from source evidence. ` +
  "Cite implementation lines, under 100 words.";

function query(text: string): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 1,
  };
}

function plan(text: string): ReturnType<typeof createExplorationPlan> {
  const scope: SelectedScope = {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "presentation-scope",
    workspaceRoot: "/fixture",
    kind: "workspace-root",
    relativePaths: [],
    conversationId: undefined,
    connectedAtMs: 1,
    explicitConnection: true,
  };
  return createExplorationPlan({ scope, query: query(text) }, { nowMs: () => 1 });
}

describe("presentation clauses do not create source targets or definition requests", () => {
  it.each(["src/deep/window.ts", "src/deep/window.ts:301"])(
    "preserves the presentation sentence boundary after raw path %s",
    (path) => {
      const result = plan(`Explain ${path}. Cite implementation lines.`);
      expect(result.targetDecision?.definitionRequested).toBe(false);
      expect(result.targetDecision?.targets).toEqual([]);
      expect(
        extractAnchors({ text: result.query.text }).anchors.map((anchor) => anchor.term),
      ).not.toContain("lines");
    },
  );
  it("keeps the original model question and exact source reference without invented line symbols", () => {
    const result = plan(ORIGINAL);
    expect(result.query.text).toBe(ORIGINAL);
    expect(result.references).toEqual([{ path: SOURCE, origin: "query" }]);
    expect(result.targetDecision?.definitionRequested).toBe(false);
    for (const term of ["lines", "cite", "under", "100", "words"])
      expect(result.anchors.map((anchor) => anchor.term)).not.toContain(term);
    expect(result.anchors.map((anchor) => anchor.term)).toContain("learned");
  });

  it.each([
    "Cite implementation lines, under 100 words.",
    "Please cite definition lines, below 80 words.",
    "Zitiere Implementierungszeilen, unter 100 Wörtern.",
    "Bitte zitiere Quellzeilen, unter 80 Wörtern.",
  ])("removes only the output clause: %s", (directive) => {
    const result = plan(`Explain thermal cooldown. ${directive}`);
    expect(result.anchors.map((anchor) => anchor.term)).toEqual(["cooldown", "explain", "thermal"]);
    expect(result.targetDecision?.definitionRequested).toBe(false);
  });

  it.each([
    "Where is FooProbe defined? Cite implementation lines, under 100 words.",
    "Wo ist FooProbe implementiert? Zitiere Implementierungszeilen, unter 100 Wörtern.",
  ])("preserves the real definition request: %s", (text) => {
    const result = plan(text);
    expect(result.targetDecision?.definitionRequested).toBe(true);
    expect(result.targetDecision?.definitionSymbol).toBe("fooprobe");
    expect(result.targetDecision?.kind).toBe("direct-fact");
    expect(result.targetDecision?.targets.map((target) => target.term)).toEqual(["fooprobe"]);
  });

  it.each([
    "Cite implementation of FooProbe.",
    "Cite implementation of `FooProbe` and describe its input validation.",
    "What does implementation mean?",
  ])("does not mask implementation as a substantive subject: %s", (text) => {
    expect(plan(text).targetDecision?.definitionRequested).toBe(true);
  });

  it("retains a quoted line token as an actual target", () => {
    const result = plan('Find "lines". Cite implementation lines, under 100 words.');
    expect(result.targetDecision?.kind).toBe("literal-search");
    expect(result.targetDecision?.targets).toEqual([{ term: "lines", kind: "quoted", weight: 1 }]);
    expect(result.targetDecision?.definitionRequested).toBe(false);
  });

  it("retains actual path line hints without inventing a line symbol", () => {
    const result = plan("Explain src/deep/window.ts:301. Cite implementation lines.");
    expect(result.references).toEqual([{ path: "src/deep/window.ts", line: 301, origin: "query" }]);
    expect(result.anchors.some((anchor) => anchor.term === "lines")).toBe(false);
    expect(result.targetDecision?.definitionRequested).toBe(false);
  });

  it.each([
    "Explain src/main.ts and explain thermal cooldown. Cite implementation lines.",
    "Explain src/main.ts. Cite implementation lines and explain thermal cooldown.",
  ])("preserves independent content clauses: %s", (text) => {
    const result = plan(text);
    expect(result.targetDecision?.kind).toBe("contextual");
    expect(result.anchors.map((anchor) => anchor.term)).toEqual(
      expect.arrayContaining(["thermal", "cooldown"]),
    );
    expect(result.targetDecision?.definitionRequested).toBe(false);
  });

  it.each([
    "Cite callers of `FooProbe`.",
    "Explain which code imports FooProbe. Cite implementation lines.",
    "Explain the history of src/main.ts. Cite implementation lines.",
  ])("retains genuine relationship/history content: %s", (text) => {
    expect(requiresRelationshipOrHistoryRings(query(text))).toBe(true);
  });

  it("retains typed and quoted targets embedded in an output request", () => {
    const anchors = extractAnchors({
      text: "Cite `lines` and src/Manual.ts:9 briefly.",
      maxAnchors: 8,
    }).anchors;
    expect(anchors).toEqual(
      expect.arrayContaining([
        { term: "lines", kind: "identifier", weight: 0.9 },
        { term: "src/manual.ts:9", sourceTerm: "src/Manual.ts:9", kind: "path", weight: 0.95 },
      ]),
    );
  });
});
