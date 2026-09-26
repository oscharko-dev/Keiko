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
  QUALITY_INTELLIGENCE_STAGE_NAMES,
  assertRunEventSequenceMonotonic,
} from "../runPlanAndEvents.js";
import type {
  QualityIntelligenceRunEvent,
  QualityIntelligenceRunEventKind,
  QualityIntelligenceRunPlan,
  QualityIntelligenceRunStage,
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
  "stage:started": () => ({ kind: "stage:started", stageName: "plan" }),
  "stage:completed": () => ({ kind: "stage:completed", stageName: "plan" }),
  "stage:failed": () => ({ kind: "stage:failed", stageName: "plan", reasonSummary: "redacted" }),
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
        { name: "plan", descriptor: "stage:plan:v1" },
        { name: "candidates", descriptor: "stage:candidates:v1" },
      ],
    };
    const round = JSON.parse(JSON.stringify(plan)) as QualityIntelligenceRunPlan;
    expect(round).toEqual(plan);
  });
});

// KEIKO-0274: `QualityIntelligenceRunStage.name` and the three `stageName` payload fields were a
// bare `string`, even though every QI workflow draws stage names from a small, fixed vocabulary
// (the union of all four workflow descriptors' declared stages in keiko-workflows). These are
// type-level regression tests: a bogus stage name must fail to type-check once the fields are
// narrowed to `QualityIntelligenceStageName`. Each `@ts-expect-error` fails today (the field is
// `string`, so the assignment compiles and the directive itself is reported "unused") and starts
// passing once the fields are retyped.
describe("QualityIntelligenceStageName (KEIKO-0274)", () => {
  it("rejects a stage name outside the declared vocabulary on QualityIntelligenceRunStage.name", () => {
    const bogusStage: QualityIntelligenceRunStage = {
      // @ts-expect-error — "not-a-real-stage" is not a QualityIntelligenceStageName member
      name: "not-a-real-stage",
      descriptor: "stage:bogus:v1",
    };
    expect(bogusStage.name).toBe("not-a-real-stage");
  });

  it("rejects a stage name outside the declared vocabulary on a stage:started payload", () => {
    const bogusPayload: Extract<QualityIntelligenceRunEvent["payload"], { kind: "stage:started" }> =
      {
        kind: "stage:started",
        // @ts-expect-error — "not-a-real-stage" is not a QualityIntelligenceStageName member
        stageName: "not-a-real-stage",
      };
    expect(bogusPayload.stageName).toBe("not-a-real-stage");
  });

  it("accepts every member of the canonical QUALITY_INTELLIGENCE_STAGE_NAMES export", () => {
    // Derived from the exported runtime constant, not a copy of its literals: this package cannot
    // import keiko-workflows/descriptors.ts (the leaf-package rule runs the other way), so the
    // cross-package proof that every descriptor stage is one of these names lives in
    // keiko-workflows/qualityIntelligence/__tests__/descriptors.test.ts instead, where both the
    // descriptors and this same QUALITY_INTELLIGENCE_STAGE_NAMES constant are importable together.
    // This test only proves the type accepts every name the constant itself declares.
    for (const name of QUALITY_INTELLIGENCE_STAGE_NAMES) {
      const stage: QualityIntelligenceRunPlan["stages"][number] = {
        name,
        descriptor: `stage:${name}:v1`,
      };
      expect(stage.name).toBe(name);
    }
  });
});

describe("assertRunEventSequenceMonotonic", () => {
  it("accepts an empty array (vacuously monotonic)", () => {
    // Mutation killed: a guard that requires at least one element would throw here.
    expect(() => {
      assertRunEventSequenceMonotonic([]);
    }).not.toThrow();
  });

  it("accepts a single-element sequence", () => {
    // Mutation killed: a guard that requires a previous element to compare against would throw.
    expect(() => {
      assertRunEventSequenceMonotonic([baseEvent(0, "run:queued")]);
    }).not.toThrow();
  });

  it("accepts a non-contiguous strictly-increasing gap sequence (0, 5, 100)", () => {
    // Proves the invariant requires STRICTLY INCREASING, not CONTIGUOUS.
    // Mutation killed: changing the implementation to require sequence[i] === sequence[i-1] + 1
    // would turn this from passing to throwing.
    expect(() => {
      assertRunEventSequenceMonotonic([
        baseEvent(0, "run:queued"),
        baseEvent(5, "run:started"),
        baseEvent(100, "run:succeeded"),
      ]);
    }).not.toThrow();
  });

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
