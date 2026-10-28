import { describe, expect, expectTypeOf, it } from "vitest";
import {
  activityLogBoundedStringField,
  activityLogBoundedStringArrayField,
  activityLogAutomaticCatalogFields,
  activityLogEmbeddingBatchRetryFields,
  activityLogCommitDraftModelFields,
  activityLogCompletenessField,
  activityLogLossField,
  activityLogBooleanField,
  activityLogCountField,
  activityLogDurationField,
  activityLogStringEnumField,
} from "./activity-log-field-contracts.js";
import {
  ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS,
  activityLogFieldTypeClassPair,
  type ActivityLogFieldContract,
  type ActivityLogCommitDraftModelFields,
  defineActivityLogOperation,
} from "./observability.js";
import { ACTIVITY_LOG_OPERATION_REGISTRY } from "./activity-log-operations.generated.js";

function expectOrdinaryDescriptor(value: object, keys: readonly string[]): void {
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Reflect.ownKeys(value)).toEqual(keys);
  expect(Object.isFrozen(value)).toBe(false);
  for (const key of keys) {
    expect(Object.getOwnPropertyDescriptor(value, key)).toMatchObject({
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

describe("canonical Activity Log field construction", () => {
  it("preserves concrete primitive classes, requiredness, order and omission", () => {
    const count = activityLogCountField(true);
    const duration = activityLogDurationField(false);
    const flag = activityLogBooleanField(true);
    expect(count).toEqual({ type: "integer", dataClass: "count", required: true });
    expect(duration).toEqual({ type: "integer", dataClass: "duration", required: false });
    expect(flag).toEqual({ type: "boolean", dataClass: "closed-enum", required: true });
    for (const descriptor of [count, duration, flag]) {
      expectOrdinaryDescriptor(descriptor, ["type", "dataClass", "required"]);
    }
    expectTypeOf(count.required).toEqualTypeOf<true>();
    expectTypeOf(duration.required).toEqualTypeOf<false>();
    expectTypeOf(count.type).toEqualTypeOf<"integer">();
    expectTypeOf(duration.dataClass).toEqualTypeOf<"duration">();
    expectTypeOf(flag.type).toEqualTypeOf<"boolean">();
  });

  it("allocates fresh descriptors and retains exactly the supplied enum reference", () => {
    const values = ["ready", "failed"] as const;
    const first = activityLogStringEnumField(true, values);
    const second = activityLogStringEnumField(false, values);
    expect(first).not.toBe(second);
    expect(first.values).toBe(values);
    expect(second.values).toBe(values);
    expect(first.values).not.toBe(activityLogStringEnumField(true, ["ready", "failed"]).values);
    expect(activityLogCountField(true)).not.toBe(activityLogCountField(true));
    expect(activityLogDurationField(true)).not.toBe(activityLogDurationField(true));
    expect(activityLogBooleanField(true)).not.toBe(activityLogBooleanField(true));
    expectOrdinaryDescriptor(first, ["type", "dataClass", "required", "values"]);
    expectTypeOf(first.values).toEqualTypeOf<readonly ["ready", "failed"]>();
    expectTypeOf(first.required).toEqualTypeOf<true>();
  });

  it("retains the generated literal operation and field types", () => {
    type Pilot = Extract<
      (typeof ACTIVITY_LOG_OPERATION_REGISTRY)[number],
      {
        readonly op: "gateway.catalog.automatic.completed";
      }
    >;
    expectTypeOf<Pilot["fields"]["configuredModelCount"]["required"]>().toEqualTypeOf<true>();
    expectTypeOf<Pilot["fields"]["retryDeadlineMs"]["dataClass"]>().toEqualTypeOf<"count">();
    expectTypeOf<Pilot["fields"]["elapsedMs"]["dataClass"]>().toEqualTypeOf<"duration">();
    expectTypeOf<Pilot["fields"]["outcome"]["values"]>().toEqualTypeOf<
      readonly ["applied", "unchanged", "stale", "cancelled", "failed", "retry-decision"]
    >();
  });
});

function expectIndependentVocabularies(
  vocabularies: readonly (readonly string[])[],
  expectedCount: number,
): void {
  expect(new Set(vocabularies).size).toBe(expectedCount);
  for (const vocabulary of vocabularies) {
    expect(Object.getPrototypeOf(vocabulary)).toBe(Array.prototype);
    expect(Object.isFrozen(vocabulary)).toBe(false);
  }
}

describe("automatic catalog field policy", () => {
  it("preserves the producer's exact ordered fourteen non-global descriptors", () => {
    const fields = activityLogAutomaticCatalogFields();
    const operation = ACTIVITY_LOG_OPERATION_REGISTRY.find(
      (entry) => entry.op === "gateway.catalog.automatic.completed",
    );
    expect(operation).toBeDefined();
    const expected = Object.fromEntries(Object.entries(operation?.fields ?? {}).slice(2));
    expect(fields).toEqual(expected);
    expectOrdinaryDescriptor(fields, [
      "outcome",
      "phase",
      "backgroundAttempt",
      "configurationGeneration",
      "retryDisposition",
      "retryDelayMs",
      "retryDeadlineMs",
      "configuredModelCount",
      "updatedModelCount",
      "addedModelCount",
      "removedModelCount",
      "deploymentChangedModelCount",
      "elapsedMs",
      "retryable",
    ]);
    for (const descriptor of Object.values(fields)) {
      expectOrdinaryDescriptor(descriptor, Reflect.ownKeys(descriptor).map(String));
    }
    expectTypeOf(fields.outcome.values).toEqualTypeOf<
      readonly ["applied", "unchanged", "stale", "cancelled", "failed", "retry-decision"]
    >();
    expectTypeOf(fields.phase.required).toEqualTypeOf<false>();
    expectTypeOf(fields.configuredModelCount.required).toEqualTypeOf<true>();
    expectTypeOf(fields.retryDeadlineMs.dataClass).toEqualTypeOf<"count">();
    expectTypeOf(fields.elapsedMs.dataClass).toEqualTypeOf<"duration">();
    expectTypeOf(fields.retryable.type).toEqualTypeOf<"boolean">();
  });

  it("allocates independent ordinary descriptors and vocabularies for every call", () => {
    const first = activityLogAutomaticCatalogFields();
    const second = activityLogAutomaticCatalogFields();
    expect(first).not.toBe(second);
    const descriptors = [...Object.values(first), ...Object.values(second)];
    expect(new Set(descriptors).size).toBe(28);
    const vocabularies = [
      first.outcome.values,
      first.phase.values,
      first.retryDisposition.values,
      second.outcome.values,
      second.phase.values,
      second.retryDisposition.values,
    ];
    expectIndependentVocabularies(vocabularies, 6);
    const before = JSON.stringify(second);
    expect(Reflect.set(first.outcome.values, "0", "fixture-mutated")).toBe(true);
    expect(Reflect.set(first.outcome, "required", false)).toBe(true);
    expect(Reflect.deleteProperty(first, "elapsedMs")).toBe(true);
    expect(JSON.stringify(second)).toBe(before);
    expect(activityLogAutomaticCatalogFields()).toEqual(second);
  });
});

it("preserves every automatic catalog field's concrete literal type", () => {
  type Pilot = Extract<
    (typeof ACTIVITY_LOG_OPERATION_REGISTRY)[number],
    {
      readonly op: "gateway.catalog.automatic.completed";
    }
  >;
  expectTypeOf<ReturnType<typeof activityLogAutomaticCatalogFields>>().toEqualTypeOf<
    Omit<Pilot["fields"], "completeness" | "loss">
  >();
});

describe("named scalar field declaration compatibility", () => {
  it("retains separate closed readonly primitive descriptors and literal requiredness", () => {
    const count = activityLogCountField(true);
    const duration = activityLogDurationField(false);
    const flag = activityLogBooleanField(true);
    expectTypeOf(count).toEqualTypeOf<{
      readonly type: "integer";
      readonly dataClass: "count";
      readonly required: true;
    }>();
    expectTypeOf(duration).toEqualTypeOf<{
      readonly type: "integer";
      readonly dataClass: "duration";
      readonly required: false;
    }>();
    expectTypeOf(flag).toEqualTypeOf<{
      readonly type: "boolean";
      readonly dataClass: "closed-enum";
      readonly required: true;
    }>();
    expectTypeOf<keyof typeof count>().toEqualTypeOf<"type" | "dataClass" | "required">();
    expectTypeOf<keyof typeof duration>().toEqualTypeOf<"type" | "dataClass" | "required">();
    expectTypeOf<keyof typeof flag>().toEqualTypeOf<"type" | "dataClass" | "required">();
    expectTypeOf(activityLogCountField(false).required).toEqualTypeOf<false>();
    expectTypeOf(activityLogDurationField(true).required).toEqualTypeOf<true>();
    expectTypeOf(activityLogBooleanField(false).required).toEqualTypeOf<false>();
    expectTypeOf(count).toExtend<Record<string, unknown>>();
    expectTypeOf(duration).toExtend<Record<string, unknown>>();
    expectTypeOf(flag).toExtend<Record<string, unknown>>();
  });

  it("retains readonly enum descriptor keys and exact inline vocabularies", () => {
    const required = activityLogStringEnumField(true, ["ready", "failed"]);
    const optional = activityLogStringEnumField(false, ["ready", "failed"]);
    expectTypeOf(required).toEqualTypeOf<{
      readonly type: "string";
      readonly dataClass: "closed-enum";
      readonly required: true;
      readonly values: readonly ["ready", "failed"];
    }>();
    expectTypeOf(optional).toEqualTypeOf<{
      readonly type: "string";
      readonly dataClass: "closed-enum";
      readonly required: false;
      readonly values: readonly ["ready", "failed"];
    }>();
    expectTypeOf<keyof typeof required>().toEqualTypeOf<
      "type" | "dataClass" | "required" | "values"
    >();
    expectTypeOf<keyof typeof optional>().toEqualTypeOf<
      "type" | "dataClass" | "required" | "values"
    >();
    expectTypeOf(required).toExtend<Record<string, unknown>>();
    expectTypeOf(optional).toExtend<Record<string, unknown>>();
  });

  it("keeps a supplied mutable vocabulary mutable and reference-identical", () => {
    const values: string[] = ["ready", "failed"];
    const descriptor = activityLogStringEnumField(false, values);
    expectTypeOf(descriptor).toEqualTypeOf<{
      readonly type: "string";
      readonly dataClass: "closed-enum";
      readonly required: false;
      readonly values: string[];
    }>();
    expectTypeOf(descriptor.values).toEqualTypeOf<string[]>();
    expectTypeOf(descriptor).toExtend<Record<string, unknown>>();
    expect(descriptor.values).toBe(values);
    descriptor.values.push("later");
    expect(values).toEqual(["ready", "failed", "later"]);
    expectOrdinaryDescriptor(descriptor, ["type", "dataClass", "required", "values"]);
  });
});

describe("universal Activity Log field construction", () => {
  it("keeps completeness and loss as separate exact readonly zero-argument contracts", () => {
    const completeness = activityLogCompletenessField();
    const loss = activityLogLossField();
    expectTypeOf<typeof activityLogCompletenessField>().parameters.toEqualTypeOf<[]>();
    expectTypeOf<typeof activityLogLossField>().parameters.toEqualTypeOf<[]>();
    expectTypeOf(completeness).toEqualTypeOf<{
      readonly type: "string";
      readonly dataClass: "completeness-state";
      readonly required: true;
    }>();
    expectTypeOf(loss).toEqualTypeOf<{
      readonly type: "string";
      readonly dataClass: "loss-state";
      readonly required: true;
    }>();
    expectTypeOf<keyof typeof completeness>().toEqualTypeOf<"type" | "dataClass" | "required">();
    expectTypeOf<keyof typeof loss>().toEqualTypeOf<"type" | "dataClass" | "required">();
    expectTypeOf(completeness).toExtend<Record<string, unknown>>();
    expectTypeOf(loss).toExtend<Record<string, unknown>>();
    expect(completeness).toEqual({
      type: "string",
      dataClass: "completeness-state",
      required: true,
    });
    expect(loss).toEqual({ type: "string", dataClass: "loss-state", required: true });
    expectOrdinaryDescriptor(completeness, ["type", "dataClass", "required"]);
    expectOrdinaryDescriptor(loss, ["type", "dataClass", "required"]);
  });

  it("allocates fresh plain descriptors without changing the shared registration defaults", () => {
    const first = activityLogCompletenessField();
    const second = activityLogCompletenessField();
    const loss = activityLogLossField();
    expect(first).not.toBe(second);
    expect(loss).not.toBe(activityLogLossField());
    expect(first).not.toBe(loss);
    expect(Reflect.set(first, "required", false)).toBe(true);
    expect(second.required).toBe(true);
    expect(activityLogCompletenessField()).toEqual(second);
    expect(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS.completeness).not.toBe(first);
    expect(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS.completeness.required).toBe(true);
    expect(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS.loss).not.toBe(loss);
    const operation = ACTIVITY_LOG_OPERATION_REGISTRY[0];
    const { completeness, loss: priorLoss, ...fields } = operation.fields;
    expect(completeness).toEqual(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS.completeness);
    expect(priorLoss).toEqual(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS.loss);
    const defaults = defineActivityLogOperation({ ...operation, fields });
    expect(defaults.fields.completeness).toBe(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS.completeness);
    expect(defaults.fields.loss).toBe(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS.loss);
    const explicit = activityLogCompletenessField();
    const overridden = defineActivityLogOperation({
      ...operation,
      fields: { ...fields, completeness: explicit },
    });
    expect(overridden.fields.completeness).toBe(explicit);
    expect(overridden.fields.loss).toBe(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS.loss);
  });
});

describe("embedding batch retry field policy", () => {
  it("preserves all eleven ordered descriptors and exact numeric duration and bounds", () => {
    const fields = activityLogEmbeddingBatchRetryFields();
    const operation = ACTIVITY_LOG_OPERATION_REGISTRY.find(
      (entry) => entry.op === "embedding.batch.retry",
    );
    expect(operation).toBeDefined();
    expect(fields).toEqual(Object.fromEntries(Object.entries(operation?.fields ?? {}).slice(2)));
    expectOrdinaryDescriptor(fields, [
      "capsuleIdDigest",
      "documentIdDigest",
      "attempt",
      "zeroProgressRetries",
      "maxRetries",
      "delayMs",
      "remainingCount",
      "completedCount",
      "transport",
      "endpointDigest",
      "failureKind",
    ]);
    expectTypeOf(fields.delayMs.type).toEqualTypeOf<"number">();
    expectTypeOf(fields.delayMs.dataClass).toEqualTypeOf<"duration">();
    expectTypeOf(fields.capsuleIdDigest.required).toEqualTypeOf<false>();
    expectTypeOf(fields.capsuleIdDigest.maxLength).toEqualTypeOf<64>();
    expectTypeOf(fields.endpointDigest.maxLength).toEqualTypeOf<16>();
    expectTypeOf(fields.failureKind.maxLength).toEqualTypeOf<64>();
    expectTypeOf(fields.transport.values).toEqualTypeOf<readonly ["array-batch"]>();
    type Retry = Extract<
      (typeof ACTIVITY_LOG_OPERATION_REGISTRY)[number],
      { readonly op: "embedding.batch.retry" }
    >;
    expectTypeOf<typeof fields>().toEqualTypeOf<Omit<Retry["fields"], "completeness" | "loss">>();
  });

  it("owns a fresh plain descriptor and vocabulary graph per factory call", () => {
    const first = activityLogEmbeddingBatchRetryFields();
    const second = activityLogEmbeddingBatchRetryFields();
    expect(first).not.toBe(second);
    expect(new Set([...Object.values(first), ...Object.values(second)]).size).toBe(22);
    expect(first.transport.values).not.toBe(second.transport.values);
    for (const descriptor of Object.values(first)) {
      expectOrdinaryDescriptor(descriptor, Reflect.ownKeys(descriptor).map(String));
    }
    expect(Object.getPrototypeOf(first.transport.values)).toBe(Array.prototype);
    expect(Reflect.set(first.transport.values, "0", "fixture-mutated")).toBe(true);
    expect(Reflect.set(first.delayMs, "type", "integer")).toBe(true);
    expect(second.transport.values).toEqual(["array-batch"]);
    expect(second.delayMs.type).toBe("number");
    expect(activityLogEmbeddingBatchRetryFields()).toEqual(second);
  });
});

describe("Git commit draft model field policy", () => {
  it("preserves all twenty ordered literal descriptors and their public contract", () => {
    const fields = activityLogCommitDraftModelFields();
    const expected = {
      outcome: {
        type: "string",
        dataClass: "closed-enum",
        required: true,
        values: ["succeeded", "failed"],
      },
      failureCode: {
        type: "string",
        dataClass: "closed-enum",
        required: false,
        values: [
          "GIT_DELIVERY_COMMIT_BAD_REQUEST",
          "GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE",
          "GIT_DELIVERY_COMMIT_FORBIDDEN_PAYLOAD",
          "GIT_DELIVERY_COMMIT_DRAFT_CONTEXT_TOO_LARGE",
          "GIT_DELIVERY_COMMIT_DRAFT_FAILED",
          "GIT_DELIVERY_COMMIT_DRAFT_INVALID_OUTPUT",
          "GIT_DELIVERY_COMMIT_DRAFT_OUTPUT_EXHAUSTED",
          "GIT_DELIVERY_COMMIT_DRAFT_TIMED_OUT",
          "GIT_DELIVERY_COMMIT_DRAFT_CANCELLED",
          "GIT_DELIVERY_COMMIT_DRAFT_MODEL_UNAVAILABLE",
          "GIT_DELIVERY_COMMIT_DRAFT_NO_CHANGES",
          "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT",
          "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE",
        ],
      },
      maxOutputTokens: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      deadlineMs: {
        type: "integer",
        dataClass: "duration",
        required: false,
      },
      promptTokens: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      maxPromptTokens: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      diffCompacted: {
        type: "boolean",
        dataClass: "closed-enum",
        required: false,
      },
      generationAttempts: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      reused: {
        type: "boolean",
        dataClass: "closed-enum",
        required: false,
      },
      draftKeyDigest: {
        type: "string",
        dataClass: "digest",
        required: false,
        maxLength: 64,
      },
      normalizationVersion: {
        type: "string",
        dataClass: "closed-enum",
        required: false,
        values: ["1"],
      },
      normalizationRule: {
        type: "string",
        dataClass: "closed-enum",
        required: false,
        values: ["body-only", "terminal-trailers", "explicit-trailers"],
      },
      normalizationChanged: {
        type: "boolean",
        dataClass: "closed-enum",
        required: false,
      },
      bodyBulletCount: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      trailerLikeLineCount: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      trailerCount: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      trailerContinuationCount: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      trailerParagraphBreakCount: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      referenceTrailerCount: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
      breakingTrailerCount: {
        type: "integer",
        dataClass: "count",
        required: false,
      },
    } as const;
    expect(fields).toEqual(expected);
    expectOrdinaryDescriptor(fields, Object.keys(expected));
    for (const descriptor of Object.values(fields)) {
      const keys = ["type", "dataClass", "required"];
      if ("values" in descriptor) keys.push("values");
      if ("maxLength" in descriptor) keys.push("maxLength");
      expectOrdinaryDescriptor(descriptor, keys);
    }
    expectTypeOf(fields).toEqualTypeOf<typeof expected>();
    expectTypeOf<ReturnType<typeof activityLogCommitDraftModelFields>>().toEqualTypeOf<
      Readonly<ActivityLogCommitDraftModelFields>
    >();
    expectTypeOf<typeof activityLogCommitDraftModelFields>().parameters.toEqualTypeOf<[]>();
  });

  it("allocates fresh ordinary descriptors and four fresh vocabularies per call", () => {
    const first = activityLogCommitDraftModelFields();
    const second = activityLogCommitDraftModelFields();
    expect(first).not.toBe(second);
    expect(new Set([...Object.values(first), ...Object.values(second)]).size).toBe(40);
    const vocabularies = [
      first.outcome.values,
      first.failureCode.values,
      first.normalizationVersion.values,
      first.normalizationRule.values,
      second.outcome.values,
      second.failureCode.values,
      second.normalizationVersion.values,
      second.normalizationRule.values,
    ];
    expectIndependentVocabularies(vocabularies, 8);
    const before = JSON.stringify(second);
    expect(Reflect.set(first.failureCode.values, "0", "fixture-mutated")).toBe(true);
    expect(Reflect.set(first.diffCompacted, "required", true)).toBe(true);
    expect(Reflect.set(first.draftKeyDigest, "maxLength", 63)).toBe(true);
    expect(JSON.stringify(second)).toBe(before);
    expect(activityLogCommitDraftModelFields()).toEqual(second);
  });
});

describe("bounded Activity Log descriptor construction", () => {
  it("retains exact ordinary string and array descriptors with independent allocation", () => {
    const string = activityLogBoundedStringField(true, "opaque-id", 128);
    const array = activityLogBoundedStringArrayField(false, "safe-platform-class", 512, 8);
    expect(string).toEqual({
      type: "string",
      dataClass: "opaque-id",
      required: true,
      maxLength: 128,
    });
    expect(array).toEqual({
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    });
    expectOrdinaryDescriptor(string, ["type", "dataClass", "required", "maxLength"]);
    expectOrdinaryDescriptor(array, ["type", "dataClass", "required", "maxLength", "maxItems"]);
    expect(activityLogBoundedStringField(true, "opaque-id", 128)).not.toBe(string);
    expect(activityLogBoundedStringArrayField(false, "safe-platform-class", 512, 8)).not.toBe(
      array,
    );
    Object.defineProperty(string, "maxLength", { value: 1 });
    Object.defineProperty(array, "maxItems", { value: 1 });
    expect(activityLogBoundedStringField(true, "opaque-id", 128).maxLength).toBe(128);
    expect(activityLogBoundedStringArrayField(false, "safe-platform-class", 512, 8).maxItems).toBe(
      8,
    );
  });

  it("preserves literal readonly keys, classes, bounds and the coupled public field type", () => {
    const string = activityLogBoundedStringField(false, "digest", 64);
    const array = activityLogBoundedStringArrayField(true, "error-kind", 128, 5);
    expectTypeOf(string).toEqualTypeOf<
      Readonly<{ type: "string"; dataClass: "digest"; required: false; maxLength: 64 }>
    >();
    expectTypeOf(array).toEqualTypeOf<
      Readonly<{
        type: "string-array";
        dataClass: "error-kind";
        required: true;
        maxLength: 128;
        maxItems: 5;
      }>
    >();
    expectTypeOf(string).toExtend<ActivityLogFieldContract>();
    expectTypeOf(array).toExtend<ActivityLogFieldContract>();
    const stringRecord: Record<string, unknown> = string;
    const arrayRecord: Record<string, unknown> = array;
    expect(stringRecord).toBe(string);
    expect(arrayRecord).toBe(array);
    expectTypeOf<
      Extract<
        Parameters<typeof activityLogBoundedStringField>[1],
        "count" | "closed-enum" | "completeness-state" | "loss-state"
      >
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<
        Parameters<typeof activityLogBoundedStringArrayField>[1],
        "safe-version" | "closed-enum" | "duration"
      >
    >().toEqualTypeOf<never>();
  });
});

it("uses the one existing runtime primitive/class policy through its typed adapter", () => {
  expect(activityLogFieldTypeClassPair("string", "opaque-id")).toBe(true);
  expect(activityLogFieldTypeClassPair("string-array", "error-kind")).toBe(true);
  expect(activityLogFieldTypeClassPair("integer", "duration")).toBe(true);
  expect(activityLogFieldTypeClassPair("number", "count")).toBe(true);
  expect(activityLogFieldTypeClassPair("boolean", "closed-enum")).toBe(true);
  expect(activityLogFieldTypeClassPair("string", "count")).toBe(false);
  expect(activityLogFieldTypeClassPair("string-array", "safe-version")).toBe(false);
  expect(activityLogFieldTypeClassPair("number", "safe-version")).toBe(false);
  expect(activityLogFieldTypeClassPair("boolean", "opaque-id")).toBe(false);
});
