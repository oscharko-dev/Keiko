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
  logCitationReconciliation,
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

  it("falls back to the sanctioned unknown correlation id", () => {
    const sink = capture();

    logCitationReconciliation(evidence({ answer: "No marker." }), undefined);

    expect(sink.events[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });
});
