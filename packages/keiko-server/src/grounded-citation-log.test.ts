import { afterEach, describe, expect, it } from "vitest";

import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  logAnswerAssessment,
  logCitationReconciliation,
  reconcileAndLogInlineCitations,
  logCitationSupport,
  summarizeCitationReconciliation,
  type CitationReconciliationEvidence,
} from "./grounded-citation-log.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

function evidence(
  overrides: Partial<CitationReconciliationEvidence> &
    Pick<CitationReconciliationEvidence, "answer">,
): CitationReconciliationEvidence {
  return {
    referenceCount: 4,
    attachedIndices: [],
    weakOverlapCount: 0,
    refusal: false,
    ...overrides,
  };
}

describe("summarizeCitationReconciliation", () => {
  it("classifies an answer whose markers all attached", () => {
    expect(
      summarizeCitationReconciliation(
        evidence({ answer: "Java 17 [1, 3]. Maven 3.9 [2].", attachedIndices: [1, 3, 2] }),
      ),
    ).toEqual({
      outcome: "cited",
      attachedCount: 3,
      groupedMarkerCount: 1,
      danglingMarkerCount: 0,
    });
  });

  it("counts each dangling index of a grouped marker once", () => {
    expect(
      summarizeCitationReconciliation(
        evidence({ answer: "Java 17 [1, 7, 8] and again [7].", attachedIndices: [1] }),
      ),
    ).toEqual({
      outcome: "cited-with-dangling",
      attachedCount: 1,
      groupedMarkerCount: 1,
      danglingMarkerCount: 2,
    });
  });

  it.each([
    ["Only a dangling marker [9].", "dangling-only"],
    ["A confident claim without any marker.", "uncited"],
  ] as const)("classifies %j as %s", (answer, outcome) => {
    expect(summarizeCitationReconciliation(evidence({ answer })).outcome).toBe(outcome);
  });

  it("classifies an enforced refusal as a refusal whatever the markers say", () => {
    expect(
      summarizeCitationReconciliation(evidence({ answer: "Nichts gefunden.", refusal: true }))
        .outcome,
    ).toBe("refusal");
  });
});

describe("logCitationReconciliation", () => {
  afterEach(() => {
    resetServerLogger();
  });

  function capture(): BufferedServerLogSink {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    return sink;
  }

  it("persists unknown, ambiguous and prose-filtered file locations without paths or answer text", () => {
    const sink = capture();
    const result = reconcileAndLogInlineCitations(
      "Known [source:1|src/main.ts:2]. Ambiguous `src/main.ts:3`. Unknown src/private/ghost.ts:5. package.json: 2 scripts.",
      {
        scopePaths: new Set(["src/main.ts"]),
        sourceIdsByPath: new Map([["src/main.ts", new Set(["1", "2"])]]),
        lineWindowsBySourceId: new Map(
          ["1", "2"].map((source) => [
            source,
            new Map([["src/main.ts", [{ startLine: 1, endLine: 10 }]]]),
          ]),
        ),
      },
      "file-citations-proof-0001",
    );
    expect(result.unsupported).toHaveLength(2);
    const event = sink.events.find((entry) => entry.op === "search.citations.reconciled");
    const persisted = expectActivityLogProof(
      "search.citations.reconciled.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(persisted).toMatchObject({
      correlationId: "file-citations-proof-0001",
      citationKind: "file",
      outcome: "cited-with-dangling",
      referenceCount: 2,
      attachedCount: 1,
      danglingMarkerCount: 2,
      ambiguousMarkerCount: 1,
      droppedImplicitCount: 1,
      completeness: "complete",
      loss: "none",
    });
    expect(persisted).not.toHaveProperty("weakOverlapCount");
    expect(persisted).not.toHaveProperty("groupedMarkerCount");
    expect(sink.lines().join("\n")).not.toMatch(/private|ghost|src\/|scripts|Known/u);
  });

  it("resolves the search.citations.reconciled Activity Log proof body-free", () => {
    const sink = capture();
    const answer = "Die Anwendungen laufen auf Java 17 [1, 7, 8].";

    logCitationReconciliation(
      evidence({ answer, attachedIndices: [1], weakOverlapCount: 1, referenceCount: 5 }),
      "citation-reconcile-proof-0001",
    );

    const [event] = sink.events;
    expect(event?.op).toBe("search.citations.reconciled");
    expect(event?.category).toBe("search");
    expect(event?.correlationId).toBe("citation-reconcile-proof-0001");
    expect(
      activityLogEventRegistration(event as unknown as Readonly<Record<PropertyKey, unknown>>),
    ).toBeDefined();
    const persisted = expectActivityLogProof(
      "search.citations.reconciled.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(persisted).toMatchObject({
      correlationId: "citation-reconcile-proof-0001",
      outcome: "cited-with-dangling",
      referenceCount: 5,
      attachedCount: 1,
      weakOverlapCount: 1,
      groupedMarkerCount: 1,
      danglingMarkerCount: 2,
      completeness: "complete",
      loss: "none",
    });
    // Counts and one closed outcome only: never the answer, a marker literal or an excerpt.
    const serialized = sink.lines().join("\n");
    expect(serialized).not.toContain("Java 17");
    expect(serialized).not.toContain("[1, 7, 8]");
  });

  // PR #3678 review: the caveat is decided after the citation line, so its reason has its own line.
  it("resolves the search.citations.support-settled Activity Log proof body-free", () => {
    const sink = capture();

    logCitationSupport(
      { supportCaveat: "judge-undecided", weakCitationCount: 1, hiddenProseClaimCount: 1 },
      "citation-support-proof-0001",
    );

    const [event] = sink.events;
    expect(event?.op).toBe("search.citations.support-settled");
    expect(
      activityLogEventRegistration(event as unknown as Readonly<Record<PropertyKey, unknown>>),
    ).toBeDefined();
    const persisted = expectActivityLogProof(
      "search.citations.support-settled.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(persisted).toMatchObject({
      correlationId: "citation-support-proof-0001",
      supportCaveat: "judge-undecided",
      weakCitationCount: 1,
      hiddenProseClaimCount: 1,
      completeness: "complete",
      loss: "none",
    });
  });

  // ADR-0144: whether the answer carried Keiko's own assessment, under which policy — sizes only.
  it("resolves the search.answer.assessed Activity Log proof body-free", () => {
    const sink = capture();

    logAnswerAssessment(
      {
        policy: "allowed",
        sourceBacked: "The documents set no Java version.",
        assessment: "My own assessment: Java 21.",
        neutralized: false,
      },
      "answer-assessed-proof-0001",
    );
    logAnswerAssessment(
      { policy: "allowed", sourceBacked: "  ", assessment: "Hello!", neutralized: false },
      "answer-assessed-proof-0002",
    );
    logAnswerAssessment(
      {
        policy: "disabled",
        sourceBacked: "Fact [1]. Mine.",
        assessment: undefined,
        neutralized: true,
      },
      "answer-assessed-proof-0003",
    );
    logAnswerAssessment(
      { policy: "allowed", sourceBacked: "Fact [1].", assessment: undefined, neutralized: false },
      "answer-assessed-proof-0004",
    );

    const lines = sink.events.filter((event) => event.op === "search.answer.assessed");
    const record = expectActivityLogProof(
      "search.answer.assessed.line",
      formatActivityLogProofLine(lines[0] ?? {}),
    );
    expect(record).toMatchObject({
      correlationId: "answer-assessed-proof-0001",
      policy: "allowed",
      outcome: "assessment",
      sourceBackedChars: 34,
      assessmentChars: 27,
      completeness: "complete",
      loss: "none",
    });
    expect(lines.map((line) => line.extra?.outcome)).toEqual([
      "assessment",
      "assessment-only",
      "neutralized",
      "none",
    ]);
    const serialized = sink.lines().join("\n");
    expect(serialized).not.toContain("Java 21");
    expect(serialized).not.toContain("Hello!");
  });

  it("falls back to the sanctioned unknown correlation id", () => {
    const sink = capture();

    logCitationReconciliation(evidence({ answer: "No marker." }), undefined);

    expect(sink.events[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });
});
