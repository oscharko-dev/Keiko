import { describe, expect, it } from "vitest";
import {
  ActivityLogEventValidationError,
  defineActivityLogOperation,
  isActivityLogDiagnosticWhen,
  activityLogOperationSchema,
  attachActivityLogEventRegistration,
  validateRegisteredActivityLogEvent,
  type ActivityLogOperationRegistration,
} from "./observability.js";

function fixtureRegistration(): ActivityLogOperationRegistration {
  return {
    contractKind: "activity-log-operation",
    schemaVersion: 1,
    op: "registry.fixture.diagnostic-conditions",
    category: "gateway",
    owner: "keiko-contracts",
    emitter: "observability.test.diagnostic-conditions",
    fields: {
      outcome: {
        type: "string",
        dataClass: "closed-enum",
        required: true,
        values: ["ready", "failed"],
      },
      aborted: { type: "boolean", dataClass: "closed-enum", required: false },
      errorCount: { type: "integer", dataClass: "count", required: true },
      durationMs: { type: "number", dataClass: "duration", required: false },
      modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    },
    causal: "correlation",
    lifecycle: "end",
    analyzerProjection: "timeline",
    failureClasses: ["registry-fixture"],
    proofIds: ["registry-fixture-diagnostic-conditions"],
    releaseImpact: "none",
  };
}

// Deliberately cross the JavaScript caller boundary, without casting invalid input into the type.
function withConditions(conditions: unknown): ActivityLogOperationRegistration {
  const registration = fixtureRegistration();
  Reflect.set(registration, "diagnosticWhen", conditions);
  return registration;
}

describe("registered diagnostic conditions", () => {
  it.each([
    { inherited: { field: "outcome" }, own: { values: ["failed"], unexpected: true } },
    { inherited: { positive: true }, own: { field: "errorCount", unexpected: true } },
    { inherited: { values: ["failed"] }, own: { field: "outcome", unexpected: true } },
  ])("rejects inherited predicate members %j", ({ inherited, own }) => {
    const condition = {};
    Object.setPrototypeOf(condition, inherited);
    Object.assign(condition, own);
    expect(() => defineActivityLogOperation(withConditions([condition]))).toThrow(
      new ActivityLogEventValidationError("registration-mismatch"),
    );
  });

  it.each(["string", "string-array", "boolean"] as const)(
    "rejects a positive predicate over a nonnumeric %s count contract",
    (type) => {
      const fields = fixtureRegistration().fields;
      const count = fields.errorCount;
      if (count === undefined) throw new TypeError("Fixture lacks its count field");
      Reflect.set(count, "type", type);
      expect(isActivityLogDiagnosticWhen(fields, [{ field: "errorCount", positive: true }])).toBe(
        false,
      );
    },
  );

  it.each(
    [
      null,
      {},
      [],
      [{ field: "missing", values: ["failed"] }],
      [{ field: "outcome", values: ["invented"] }],
      [{ field: "outcome", values: [true] }],
      [{ field: "outcome", values: [] }],
      [{ field: "outcome", values: ["failed", "failed"] }],
      [{ field: "modelId", values: ["failed"] }],
      [{ field: "errorCount", values: [1] }],
      [{ field: "errorCount", positive: false }],
      [{ field: "outcome", positive: true }],
      [{ field: "durationMs", positive: true }],
      [{ field: "aborted", values: ["true"] }],
      [{ field: "aborted", values: [true, "failed"] }],
      [{ field: "errorCount", positive: true, values: ["failed"] }],
      [{ field: "errorCount", positive: true, expression: "true" }],
      [
        { field: "errorCount", positive: true },
        { field: "errorCount", positive: true },
      ],
    ].map((conditions) => ({ conditions })),
  )("rejects invalid declared conditions %j", ({ conditions }) => {
    expect(() => defineActivityLogOperation(withConditions(conditions))).toThrow(
      new ActivityLogEventValidationError("registration-mismatch"),
    );
  });

  it("preserves exact enum, boolean and positive count declarations", () => {
    const conditions = [
      { field: "outcome", values: ["failed"] },
      { field: "aborted", values: [true] },
      { field: "errorCount", positive: true },
    ];
    const registration = defineActivityLogOperation(withConditions(conditions));
    expect(Reflect.get(registration, "diagnosticWhen")).toEqual(conditions);
  });

  it.each([
    { conditions: [{ field: "overallStatus", values: ["ready"] }] },
    { conditions: [{ field: "overallStatus", values: ["failed", "partial"] }] },
    { conditions: [{ field: "probeCount", positive: true }] },
    { conditions: [] },
    { conditions: undefined },
  ])(
    "rejects attached diagnostic conditions that differ from the canonical declaration: %j",
    ({ conditions }) => {
      const canonical = activityLogOperationSchema("gateway.readiness.completed");
      if (canonical === undefined) throw new Error("Missing registered readiness operation");
      const before = Object.getOwnPropertyDescriptor(canonical, "diagnosticWhen");
      // This models the next generated canonical schema without changing shared generated artifacts.
      Object.defineProperty(canonical, "diagnosticWhen", {
        value: [{ field: "overallStatus", values: ["failed"] }],
        configurable: true,
      });
      try {
        const attached = { ...canonical };
        if (conditions === undefined) Reflect.deleteProperty(attached, "diagnosticWhen");
        else Reflect.set(attached, "diagnosticWhen", conditions);
        const event = attachActivityLogEventRegistration(
          {
            category: "gateway",
            op: canonical.op,
            level: "info",
            correlationId: "readiness-condition-test",
            extra: {
              completeness: "complete",
              loss: "none",
              trigger: "settings",
              overallStatus: "failed",
              probeCount: 1,
            },
          },
          attached,
        );
        expect(() => validateRegisteredActivityLogEvent(event)).toThrow(
          new ActivityLogEventValidationError("registration-mismatch"),
        );
      } finally {
        if (before === undefined) Reflect.deleteProperty(canonical, "diagnosticWhen");
        else Object.defineProperty(canonical, "diagnosticWhen", before);
      }
    },
  );

  it("accepts an independently copied canonical diagnostic declaration", () => {
    const canonical = activityLogOperationSchema("gateway.readiness.completed");
    if (canonical === undefined) throw new Error("Missing registered readiness operation");
    const before = Object.getOwnPropertyDescriptor(canonical, "diagnosticWhen");
    Object.defineProperty(canonical, "diagnosticWhen", {
      value: [{ field: "overallStatus", values: ["failed"] }],
      configurable: true,
    });
    try {
      const attached = {
        ...canonical,
        diagnosticWhen: [{ field: "overallStatus", values: ["failed"] }],
      };
      const event = attachActivityLogEventRegistration(
        {
          category: "gateway",
          op: canonical.op,
          level: "info",
          correlationId: "readiness-condition-test",
          extra: {
            completeness: "complete",
            loss: "none",
            trigger: "settings",
            overallStatus: "failed",
            probeCount: 1,
          },
        },
        attached,
      );
      expect(validateRegisteredActivityLogEvent(event)).toBe(canonical);
    } finally {
      if (before === undefined) Reflect.deleteProperty(canonical, "diagnosticWhen");
      else Object.defineProperty(canonical, "diagnosticWhen", before);
    }
  });

  it("keeps legacy registrations without conditional diagnostics unchanged", () => {
    expect(defineActivityLogOperation(fixtureRegistration())).not.toHaveProperty("diagnosticWhen");
  });
});
