import { describe, expect, it } from "vitest";
import { formatServerLogLine } from "../server-log.js";
import {
  analyzeLogText,
  buildReproductionSeed,
  renderHumanAllTimelines,
} from "./support-analyze.js";

const CORRELATION = "retrieval-miss-projection";
const SCOPE = "a".repeat(64);
const QUERY = "b".repeat(64);
const SOURCE = "search.connected-context.source-details";
const SELECTION = "search.connected-context.selection-details";
const COMPLETED = "search.connected-context.completed";
const ANSWER = "search.citations.reconciled";

// The pure legacy projection pins tolerate fields absent in older versions. Canonical, registered
// production records and the real scripted customer turn are proved by the scenario suite.
function line(op: string, extra: Readonly<Record<string, unknown>>): string {
  return formatServerLogLine(
    {
      category: "search",
      op,
      correlationId: CORRELATION,
      extra: { scopeIdentitySha256: SCOPE, queryIdentitySha256: QUERY, ...extra },
    },
    new Date("2026-10-09T10:00:00.000Z"),
  );
}

function findings(text: string): unknown {
  const result: unknown = Reflect.get(analyzeLogText(text), "findings");
  return result ?? [];
}

describe("retrieval-miss projection (#3893)", () => {
  it.each([
    ["declared-unread-in-scope", ANSWER, { declaredUnreadInScopeCount: 1 }],
    [
      "explicit-path-rejected",
      SOURCE,
      {
        explicitPathRejectedCount: 1,
        explicitPathRejectionReasons: ["missing"],
      },
    ],
    ["low-confidence-selection", SELECTION, { keepOneFallbackApplied: true }],
    ["basename-dedup-demoted-explicit", SELECTION, { addressedBasenameDedupDemotedCount: 1 }],
    [
      "follow-up-still-insufficient",
      SELECTION,
      {
        followUpPassCount: 1,
        followUpOutcome: "still-insufficient",
      },
    ],
  ] as const)("names %s and the actual triggering fields", (reason, op, fields) => {
    expect(findings(line(op, fields))).toEqual([
      expect.objectContaining({
        kind: "retrieval-miss",
        schemaVersion: 1,
        correlationId: CORRELATION,
        reason,
        fields,
      }),
    ]);
  });

  it("joins semantic unavailability with an actual miss across sibling operations", () => {
    const text =
      line(SOURCE, { semanticProviderDisposition: "unavailable" }) +
      line(ANSWER, { declaredUnreadInScopeCount: 1 });
    expect(findings(text)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "semantic-unavailable-with-miss",
          fields: { semanticProviderDisposition: "unavailable", declaredUnreadInScopeCount: 1 },
        }),
      ]),
    );
  });

  it("joins an overview follow-up only with its own continuity source", () => {
    expect(
      findings(
        line(COMPLETED, { retrievalIntent: "repository-overview" }) +
          line(SELECTION, { continuityReferentSource: "assistant-paths" }),
      ),
    ).toEqual([
      expect.objectContaining({
        reason: "intent-overview-on-follow-up",
        fields: {
          retrievalIntent: "repository-overview",
          continuityReferentSource: "assistant-paths",
        },
      }),
    ]);
  });

  it("disposes an initial declaration after an answered follow-up with a changed query fingerprint", () => {
    const text =
      line(ANSWER, { declaredUnreadInScopeCount: 1 }) +
      line(SELECTION, {
        queryIdentitySha256: "c".repeat(64),
        followUpPassCount: 1,
        followUpOutcome: "answered",
      }) +
      line(ANSWER, { queryIdentitySha256: "c".repeat(64), declaredUnreadInScopeCount: 0 });
    expect(findings(text)).toEqual([]);
  });

  it("does not dispose a declared miss from a different source scope", () => {
    const text =
      line(ANSWER, { declaredUnreadInScopeCount: 1 }) +
      line(SELECTION, {
        scopeIdentitySha256: "d".repeat(64),
        followUpPassCount: 1,
        followUpOutcome: "answered",
      });
    expect(findings(text)).toEqual([
      expect.objectContaining({ reason: "declared-unread-in-scope" }),
    ]);
  });

  it("does not join an overview with continuity from another query", () => {
    const text =
      line(COMPLETED, { retrievalIntent: "repository-overview" }) +
      line(SELECTION, {
        queryIdentitySha256: "c".repeat(64),
        continuityReferentSource: "assistant-paths",
      });
    expect(findings(text)).toEqual([]);
  });

  it("does not flag healthy explicit evidence when unrelated basename diversity was demoted", () => {
    const text =
      line(SOURCE, { explicitPathAdmittedCount: 1 }) +
      line(SELECTION, {
        basenameDedupDemotedCount: 1,
        addressedBasenameDedupDemotedCount: 0,
      }) +
      line(COMPLETED, { selectedFileCount: 2, coverageStatus: "complete" });
    expect(findings(text)).toEqual([]);
  });

  it("does not flag a healthy lexical answer when semantic embedding is unconfigured", () => {
    const text =
      line(SOURCE, { semanticProviderDisposition: "unavailable" }) +
      line(COMPLETED, { selectedFileCount: 1, coverageStatus: "complete" });
    expect(findings(text)).toEqual([]);
  });

  it("keeps missing legacy fields unknown", () => {
    expect(
      findings(
        line(SOURCE, { explicitPathAnchorCount: 1 }) +
          line(COMPLETED, { retrievalIntent: "repository-overview" }),
      ),
    ).toEqual([]);
  });

  it("does not interpret malformed legacy values as misses", () => {
    expect(
      findings(
        line(SOURCE, { explicitPathRejectedCount: -1 }) +
          line(SELECTION, {
            keepOneFallbackApplied: "true",
            addressedBasenameDedupDemotedCount: 0.5,
            followUpPassCount: 1,
            followUpOutcome: "private-free-text",
          }),
      ),
    ).toEqual([]);
  });

  it("carries findings into human analysis and warns about body-free seed limits", () => {
    const text = line(SOURCE, { explicitPathRejectedCount: 1 });
    expect(renderHumanAllTimelines(analyzeLogText(text))).toContain(
      "retrieval-miss explicit-path-rejected",
    );
    const seed = buildReproductionSeed(text, CORRELATION, new Date("2026-10-09T10:00:00.000Z"));
    expect(seed?.warnings.some((warning) => warning.includes("retrieval inputs"))).toBe(true);
    const projected: unknown = seed === undefined ? undefined : Reflect.get(seed, "findings");
    expect(projected).toEqual(findings(text));
  });
});
