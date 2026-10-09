import { describe, expect, it } from "vitest";
import {
  classifyGroundedAnswerKind,
  declaredInsufficiencyPaths,
  validateGroundedAnswerEvidence,
  missingCitationMarkerFor,
  parseInlineCitations,
  parseInsufficiencyDeclarations,
  reconcileNumericCitations,
  sanitizeInsufficiencyDeclarations,
  segmentCitedClaims,
  segmentNumericCitedClaims,
  uncitedMemoryContextMarker,
} from "./grounded-faithfulness.js";
import { sanitizeGroundedAnswerContent } from "./grounded-answer.js";
import { WORKSPACE_PORTABLE_PATH_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";

const scopeIndex = new Map<string, "read-in-this-turn" | "unread-in-scope">([
  ["src/read.ts", "read-in-this-turn"],
  ["src/missing.ts", "unread-in-scope"],
  ["README.md", "unread-in-scope"],
  ["src/other.ts", "unread-in-scope"],
  ["src/überblick.ts", "unread-in-scope"],
]);

function declaration(path: string): string {
  return `Missing evidence: [${path}]`;
}

describe("verified missing-evidence declarations", () => {
  it("exposes only bounded syntactic paths for legacy continuity, without claiming membership", () => {
    expect(
      declaredInsufficiencyPaths(
        [
          declaration("src/not-discovered.ts"),
          declaration("../outside.ts"),
          declaration("src/missing.ts"),
          declaration("README.md"),
        ].join("\n"),
      ),
    ).toEqual(["src/not-discovered.ts", "src/missing.ts"]);
    expect(declaredInsufficiencyPaths("```\nMissing evidence: [src/missing.ts]\n```")).toEqual([]);
  });

  it("retains original rejection counts while projecting an honest nonempty fallback", () => {
    const result = validateGroundedAnswerEvidence(
      declaration("private/outside.ts"),
      scopeIndex,
      "Welche Belege gibt es?",
    );
    expect(result.content).toContain("nicht bestätigt");
    expect(result.answerKind).toBe("insufficiency");
    expect(result.insufficiencyDeclarations).toBeUndefined();
    expect(result.insufficiencyObservation).toMatchObject({
      declaredCount: 1,
      inScopeCount: 0,
      notInScopeCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("private/outside.ts");
  });
  it("projects only verified paths with their actual read state and body-free counts", () => {
    const result = parseInsufficiencyDeclarations(
      [
        declaration("src/read.ts"),
        declaration("src/missing.ts"),
        declaration("private/outside.ts"),
      ].join("\n"),
      scopeIndex,
    );
    expect(result).toEqual({
      declarations: [
        { scopePath: "src/read.ts", state: "read-in-this-turn" },
        { scopePath: "src/missing.ts", state: "unread-in-scope" },
      ],
      declaredCount: 3,
      inScopeCount: 2,
      unreadInScopeCount: 1,
      notInScopeCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("private/outside.ts");
  });

  it("deduplicates deterministically and caps distinct declarations at three", () => {
    expect(
      parseInsufficiencyDeclarations(
        [
          declaration("src/missing.ts"),
          declaration("src/missing.ts"),
          declaration("README.md"),
          declaration("src/read.ts"),
          declaration("src/other.ts"),
        ].join("\n"),
        scopeIndex,
      ),
    ).toMatchObject({
      declaredCount: 3,
      declarations: [
        { scopePath: "src/missing.ts", state: "unread-in-scope" },
        { scopePath: "README.md", state: "unread-in-scope" },
        { scopePath: "src/read.ts", state: "read-in-this-turn" },
      ],
    });
  });

  it.each([
    "/repo/src/read.ts",
    "../src/read.ts",
    "src/../read.ts",
    "./src/read.ts",
    "src//read.ts",
    "src\\read.ts",
    "C:/src/read.ts",
    "~/src/read.ts",
    "https://host/src/read.ts",
    "src/read.ts:1-2",
    "src/read.ts\u0000",
    "src/re\u202ead.ts",
    "src/read.ts ",
    "x".repeat(WORKSPACE_PORTABLE_PATH_MAX_BYTES + 1),
  ])("rejects an unsafe/noncanonical path even if a supplied map contains it: %j", (path) => {
    const result = parseInsufficiencyDeclarations(
      declaration(path),
      new Map([[path, "unread-in-scope"]]),
    );
    expect(result.declarations).toEqual([]);
    expect(result.notInScopeCount).toBe(1);
  });

  it("preserves canonical Unicode filenames without inventing normalization or case matches", () => {
    expect(
      parseInsufficiencyDeclarations(declaration("src/überblick.ts"), scopeIndex).declarations,
    ).toEqual([{ scopePath: "src/überblick.ts", state: "unread-in-scope" }]);
    expect(
      parseInsufficiencyDeclarations(declaration("src/MISSING.ts"), scopeIndex).declarations,
    ).toEqual([]);
  });

  it.each([
    "```text\nMissing evidence: [src/missing.ts]\n```",
    "~~~\nMissing evidence: [src/missing.ts]\n~~~",
    "`Missing evidence: [src/missing.ts]`",
    "    Missing evidence: [src/missing.ts]",
    "> Missing evidence: [src/missing.ts]",
    "Example: Missing evidence: [src/missing.ts]",
    "Missing evidence: [src/missing.ts] trailing claim",
    "Missing evidence: [src/missing.ts](url)",
    "Missing evidence: [src/missing.ts, src/read.ts]",
  ])("ignores quoted, code, partial, and malformed examples: %j", (text) => {
    expect(parseInsufficiencyDeclarations(text, scopeIndex).declaredCount).toBe(0);
  });

  it("survives pseudo-tool stripping without converting declarations into citations or claims", () => {
    const content = sanitizeGroundedAnswerContent(
      `Searching for files\n{"query":"auth"}\nThe route validates sessions [src/read.ts:1].\n${declaration("src/missing.ts")}`,
    );
    expect(content).toContain(declaration("src/missing.ts"));
    expect(parseInlineCitations(content).map((citation) => citation.scopePath)).toEqual([
      "src/read.ts",
    ]);
    expect(segmentCitedClaims(content).map((claim) => claim.claimText)).toEqual([
      "The route validates sessions .",
    ]);
    expect(
      segmentNumericCitedClaims(
        `The route validates sessions [1].\n${declaration("src/missing.ts")}`,
      ),
    ).toEqual([{ claimText: "The route validates sessions .", markers: [1] }]);
    expect(reconcileNumericCitations(declaration("1"), new Set([1])).citedMarkers.size).toBe(0);
  });

  it("removes unknown, unsafe, duplicate and excess declaration lines before wire/history projection", () => {
    const text = [
      "I need the missing file to answer this question.",
      declaration("private/outside.ts"),
      declaration("src/missing.ts"),
      declaration("src/missing.ts"),
      declaration("README.md"),
      declaration("src/other.ts"),
    ].join("\n");
    const clean = sanitizeInsufficiencyDeclarations(text, scopeIndex);
    expect(clean).toContain("I need the missing file to answer this question.");
    expect(clean).toContain(declaration("src/missing.ts"));
    expect(clean).toContain(declaration("README.md"));
    expect(clean).not.toContain("private/outside.ts");
    expect(clean).not.toContain("src/other.ts");
    expect(clean.match(/Missing evidence: \[src\/missing\.ts\]/gu)).toHaveLength(1);
  });

  it("never presents an unknown declaration as a fabricated citation or an entailment claim", () => {
    const text = declaration("outside/private.ts");
    expect(parseInlineCitations(text)).toEqual([]);
    expect(segmentCitedClaims(text)).toEqual([]);
    expect(segmentNumericCitedClaims(text)).toEqual([]);
  });
});

describe("conservative grounded answer kinds", () => {
  it.each([
    ["Which API version do you mean?", "clarification"],
    ["Could you clarify which service you mean?", "clarification"],
    ["Welche API-Version meinst du?", "clarification"],
    ["Meinst du den Client oder den Server?", "clarification"],
    [
      "I need the missing file to answer this question.\nMissing evidence: [src/missing.ts]",
      "insufficiency",
    ],
    ["Für die Antwort fehlen die Belege.\nMissing evidence: [src/missing.ts]", "insufficiency"],
    [declaration("src/missing.ts"), "insufficiency"],
    ["No evidence found in the connected scope.", "refusal"],
    [
      "In den bereitgestellten Dokumenten wurden keine Informationen oder Vorgaben zur Java-Version gefunden.",
      "refusal",
    ],
    ["I need more context to answer this question.", "clarification"],
    ["please paste validation.ts", "clarification"],
    ["Which service authenticates users and rotates tokens?", "answer"],
    [
      `I need evidence because the service uses OAuth2.\n${declaration("src/missing.ts")}`,
      "answer",
    ],
    ["The service validates sessions.", "answer"],
    ["The service validates sessions. Which version do you mean?", "answer"],
    ["Which version do you mean? The service uses OAuth2.", "answer"],
    ["Welche Version meinst du? Der Dienst nutzt OAuth2.", "answer"],
    [`The service uses OAuth2.\n${declaration("src/missing.ts")}`, "answer"],
    ["No evidence found. The service uses OAuth2.", "answer"],
    ["Which service authenticates users? [src/read.ts:1]", "answer"],
    ["Which " + "service ".repeat(200) + "do you mean?", "answer"],
  ])("classifies %j as %s", (text, expected) => {
    expect(classifyGroundedAnswerKind(text)).toBe(expected);
    expect(missingCitationMarkerFor(text, 1)?.kind).toBe(
      expected === "answer" ? "uncited-answer" : undefined,
    );
  });

  it("keeps memory attribution separate from an uncited repository answer", () => {
    expect(uncitedMemoryContextMarker(1).kind).toBe("uncited-memory-context");
  });
});
