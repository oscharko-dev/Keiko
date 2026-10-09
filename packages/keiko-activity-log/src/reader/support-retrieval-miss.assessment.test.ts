import { describe, expect, it } from "vitest";
import { projectRetrievalMisses } from "./support-retrieval-miss.js";

const SCOPE = "a".repeat(64);
const QUERY = "b".repeat(64);
const INSTANCE = "c".repeat(8);
const CORRELATION = "reused-public-correlation";
const SELECTION = "search.connected-context.selection-details";
const SOURCE = "search.connected-context.source-details";
const ASSESSED = "search.answer.assessed";
const STARTED = "search.connected-context.started";

function line(
  op: string,
  extra: Readonly<Record<string, unknown>> = {},
): {
  readonly op: string;
  readonly correlationId: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly extra: Readonly<Record<string, unknown>>;
} {
  return {
    op,
    correlationId: CORRELATION,
    pid: 10,
    instanceId: INSTANCE,
    extra: { scopeIdentitySha256: SCOPE, queryIdentitySha256: QUERY, ...extra },
  };
}

function assessment(extra: Readonly<Record<string, unknown>> = {}): ReturnType<typeof line> {
  return line(ASSESSED, {
    phase: "accepted-final",
    policy: "allowed",
    outcome: "assessment-only",
    sourceBackedChars: 0,
    assessmentChars: 80,
    ...extra,
  });
}

function reasons(lines: readonly ReturnType<typeof line>[]): readonly string[] {
  const actual = lines.some((entry) => entry.op === STARTED) ? lines : [line(STARTED), ...lines];
  return projectRetrievalMisses(CORRELATION, actual).map((finding) => finding.reason);
}

describe("intentional source-free assessment does not fabricate retrieval incidents", () => {
  it("suppresses only incidental selection in the same actual process, scope and query", () => {
    expect(reasons([line(SELECTION, { keepOneFallbackApplied: true }), assessment()])).toEqual([]);
  });

  it("suppresses incidental empty semantic lookup for the final source-free answer", () => {
    expect(
      reasons([
        line(SOURCE, { semanticProviderDisposition: "unavailable" }),
        line("search.connected-context.completed", {
          selectedFileCount: 0,
          retrievalIntent: "targeted-code-search",
        }),
        assessment(),
      ]),
    ).toEqual([]);
  });

  it.each([
    { phase: undefined },
    { phase: "candidate" },
    { policy: "disabled", outcome: "neutralized" },
    { outcome: "assessment", sourceBackedChars: 100 },
    { outcome: "none" },
    { outcome: "assessment-only", sourceBackedChars: 1 },
    { assessmentChars: 0 },
    { queryIdentitySha256: undefined },
    { scopeIdentitySha256: undefined },
    { queryIdentitySha256: "d".repeat(64) },
    { scopeIdentitySha256: "d".repeat(64) },
  ])("preserves real selection findings for an unrelated or unsupported assessment %j", (extra) => {
    expect(reasons([line(SELECTION, { keepOneFallbackApplied: true }), assessment(extra)])).toEqual(
      ["low-confidence-selection"],
    );
  });

  it.each([
    { explicitPathRejectedCount: 1, explicitPathRejectionReasons: ["missing"] },
    { explicitPathRejectedCount: 1, explicitPathRejectionReasons: ["unsupported-format"] },
    { addressedBasenameDedupDemotedCount: 1 },
    { declaredUnreadInScopeCount: 1 },
    { followUpPassCount: 1, followUpOutcome: "still-insufficient" },
  ])("retains the actual explicit or declared miss %j", (fields) => {
    expect(reasons([line(SELECTION, fields), assessment()])).not.toEqual([]);
  });

  it.each(["explicitPathAnchorCount", "referenceChannelCount", "continuityReferentCount"])(
    "retains source-required selection when %s was observed",
    (field) => {
      expect(
        reasons([
          line(SOURCE, { [field]: 1 }),
          line(SELECTION, { keepOneFallbackApplied: true }),
          assessment(),
        ]),
      ).toEqual(["low-confidence-selection"]);
    },
  );

  it.each([{ pid: 11 }, { instanceId: "d".repeat(8) }, { correlationId: "another-turn" }])(
    "does not join another actual process or correlation %j",
    (identity) => {
      expect(
        reasons([
          line(SELECTION, { keepOneFallbackApplied: true }),
          { ...assessment(), ...identity },
        ]),
      ).toEqual(["low-confidence-selection"]);
    },
  );

  it("does not let an earlier same-query assessment suppress the next request lifecycle", () => {
    expect(
      reasons([
        line(STARTED),
        line(SELECTION, { keepOneFallbackApplied: true }),
        assessment(),
        line(STARTED),
        line(SELECTION, { keepOneFallbackApplied: true }),
      ]),
    ).toEqual(["low-confidence-selection"]);
  });

  it("does not let a later same-query assessment suppress a completed earlier source-required turn", () => {
    expect(
      reasons([
        line(STARTED),
        line(SELECTION, { keepOneFallbackApplied: true }),
        line("search.connected-context.answer-details", { followUpOutcome: "not-needed" }),
        line(STARTED),
        assessment(),
      ]),
    ).toEqual(["low-confidence-selection"]);
  });
  it("cannot promote a rejected assessment-only repair over the delivered source-backed answer", () => {
    expect(
      reasons([
        line(SELECTION, { keepOneFallbackApplied: true }),
        assessment({ phase: "candidate", outcome: "none", sourceBackedChars: 100 }),
        assessment({ phase: "candidate" }),
        assessment({ outcome: "none", sourceBackedChars: 100 }),
      ]),
    ).toEqual(["low-confidence-selection"]);
  });

  it("does not let a later candidate revoke the accepted-final assessment", () => {
    expect(
      reasons([
        line(SELECTION, { keepOneFallbackApplied: true }),
        assessment(),
        assessment({ phase: "candidate", outcome: "none", sourceBackedChars: 100 }),
      ]),
    ).toEqual([]);
  });

  it("keeps a partial timeline without a witnessed request start unknown", () => {
    expect(
      projectRetrievalMisses(CORRELATION, [
        line(SELECTION, { keepOneFallbackApplied: true }),
        assessment(),
      ]).map((finding) => finding.reason),
    ).toEqual(["low-confidence-selection"]);
  });
  it("retains selection and semantic evidence when an explicit miss establishes source demand", () => {
    expect(
      reasons([
        line(SOURCE, { explicitPathRejectedCount: 1, semanticProviderDisposition: "unavailable" }),
        line(SELECTION, { keepOneFallbackApplied: true }),
        assessment(),
      ]),
    ).toEqual([
      "explicit-path-rejected",
      "low-confidence-selection",
      "semantic-unavailable-with-miss",
    ]);
  });
  it("keeps overlapping reused request lifecycles ambiguous rather than guessing assessment authority", () => {
    expect(
      reasons([
        line(STARTED),
        line(SELECTION, { keepOneFallbackApplied: true }),
        line(STARTED),
        assessment(),
      ]),
    ).toEqual(["low-confidence-selection"]);
  });
});
