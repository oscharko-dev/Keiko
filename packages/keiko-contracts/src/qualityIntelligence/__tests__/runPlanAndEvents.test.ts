import { describe, expect, it } from "vitest";
import {
  asQualityIntelligenceEvidenceAtomId,
  asQualityIntelligenceRunId,
  asQualityIntelligenceTestCaseId,
  asQualityIntelligenceValidationFindingId,
} from "../ids.js";
import {
  QUALITY_INTELLIGENCE_EVENT_SCHEMA_VERSION,
  QUALITY_INTELLIGENCE_RUN_EVENT_KINDS,
  assertRunEventSequenceMonotonic,
} from "../runPlanAndEvents.js";
import type {
  QualityIntelligenceRunEvent,
  QualityIntelligenceRunEventKind,
  QualityIntelligenceRunPlan,
} from "../runPlanAndEvents.js";

const runId = asQualityIntelligenceRunId("run-001");

// Payload factories keyed by event kind. Splitting the previous switch into a lookup
// keeps `baseEvent` below the project complexity bound of 10 while leaving every
// branch covered by `constructs at least one event for every event kind` below.
type PayloadFor<K extends QualityIntelligenceRunEventKind> = Extract<
  QualityIntelligenceRunEvent["payload"],
  { kind: K }
>;

type PayloadFactoryTable = {
  readonly [K in QualityIntelligenceRunEventKind]: () => PayloadFor<K>;
};

const PAYLOAD_FACTORIES: PayloadFactoryTable = {
  "run:queued": () => ({ kind: "run:queued" }),
  "run:started": () => ({ kind: "run:started" }),
  "stage:started": () => ({ kind: "stage:started", stageName: "ingest" }),
  "stage:completed": () => ({ kind: "stage:completed", stageName: "ingest" }),
  "stage:failed": () => ({ kind: "stage:failed", stageName: "ingest", reasonSummary: "redacted" }),
  "candidate:proposed": () => ({
    kind: "candidate:proposed",
    candidateId: asQualityIntelligenceTestCaseId("tc-1"),
    derivedFromAtomIds: [asQualityIntelligenceEvidenceAtomId("atom-1")],
  }),
  "finding:recorded": () => ({
    kind: "finding:recorded",
    findingId: asQualityIntelligenceValidationFindingId("finding-1"),
  }),
  "review:requested": () => ({
    kind: "review:requested",
    candidateId: asQualityIntelligenceTestCaseId("tc-1"),
  }),
  "review:completed": () => ({
    kind: "review:completed",
    candidateId: asQualityIntelligenceTestCaseId("tc-1"),
  }),
  "run:succeeded": () => ({ kind: "run:succeeded" }),
  "run:failed": () => ({ kind: "run:failed", reasonSummary: "redacted" }),
  "run:cancelled": () => ({ kind: "run:cancelled" }),
};

const baseEvent = (
  sequence: number,
  kind: QualityIntelligenceRunEventKind,
): QualityIntelligenceRunEvent => {
  const ts = new Date(1_750_000_000_000 + sequence * 1000).toISOString();
  // The factory table is indexed by every variant of QualityIntelligenceRunEventKind,
  // so the cast is sound: `PAYLOAD_FACTORIES[kind]` produces the payload corresponding
  // to this `kind`. We materialise via `unknown` because TypeScript cannot follow the
  // mapped-type indexed access through the generic `kind` parameter.
  const payload = (
    PAYLOAD_FACTORIES[kind] as () => unknown
  )() as QualityIntelligenceRunEvent["payload"];
  return { eventSchemaVersion: 1, runId, sequence, timestamp: ts, payload };
};

describe("QualityIntelligenceRunEvent", () => {
  it("enumerates all twelve kinds", () => {
    expect(QUALITY_INTELLIGENCE_RUN_EVENT_KINDS).toHaveLength(12);
  });

  it("pins the event schema version literal", () => {
    expect(QUALITY_INTELLIGENCE_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it("round-trips a 5-event sequence through JSON", () => {
    const events = [
      baseEvent(0, "run:queued"),
      baseEvent(1, "run:started"),
      baseEvent(2, "stage:started"),
      baseEvent(3, "stage:completed"),
      baseEvent(4, "run:succeeded"),
    ];
    const round = JSON.parse(JSON.stringify(events)) as readonly QualityIntelligenceRunEvent[];
    expect(round).toEqual(events);
  });

  it("constructs at least one event for every event kind", () => {
    for (const kind of QUALITY_INTELLIGENCE_RUN_EVENT_KINDS) {
      expect(baseEvent(0, kind).payload.kind).toBe(kind);
    }
  });

  it("round-trips a run plan through JSON", () => {
    const plan: QualityIntelligenceRunPlan = {
      id: runId,
      requestedAt: "2026-06-05T00:00:00Z",
      plannerKind: "scripted",
      stages: [
        { name: "ingest", descriptor: "stage:ingest:v1" },
        { name: "design", descriptor: "stage:design:v1" },
      ],
    };
    const round = JSON.parse(JSON.stringify(plan)) as QualityIntelligenceRunPlan;
    expect(round).toEqual(plan);
  });
});

describe("assertRunEventSequenceMonotonic", () => {
  it("accepts a strictly increasing sequence", () => {
    expect(() => {
      assertRunEventSequenceMonotonic([
        baseEvent(0, "run:queued"),
        baseEvent(1, "run:started"),
        baseEvent(2, "run:succeeded"),
      ]);
    }).not.toThrow();
  });

  it("rejects a duplicate sequence", () => {
    expect(() => {
      assertRunEventSequenceMonotonic([baseEvent(0, "run:queued"), baseEvent(0, "run:started")]);
    }).toThrow(RangeError);
  });

  it("rejects a descending sequence", () => {
    expect(() => {
      assertRunEventSequenceMonotonic([baseEvent(2, "run:queued"), baseEvent(1, "run:started")]);
    }).toThrow(RangeError);
  });

  it("rejects a negative sequence", () => {
    expect(() => {
      assertRunEventSequenceMonotonic([baseEvent(-1, "run:queued")]);
    }).toThrow(RangeError);
  });

  it("rejects a NaN sequence", () => {
    const broken: QualityIntelligenceRunEvent = {
      ...baseEvent(0, "run:queued"),
      sequence: Number.NaN,
    };
    expect(() => {
      assertRunEventSequenceMonotonic([broken]);
    }).toThrow(RangeError);
  });
});
