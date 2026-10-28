import { describe, expect, expectTypeOf, it } from "vitest";
import {
  activityLogAutomaticCatalogFields,
  activityLogCompletenessField,
  activityLogLossField,
  activityLogBooleanField,
  activityLogCountField,
  activityLogDurationField,
  activityLogStringEnumField,
} from "./activity-log-field-contracts.js";
import {
  ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS,
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
    expect(new Set(vocabularies).size).toBe(6);
    for (const vocabulary of vocabularies) {
      expect(Object.getPrototypeOf(vocabulary)).toBe(Array.prototype);
      expect(Object.isFrozen(vocabulary)).toBe(false);
    }
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
