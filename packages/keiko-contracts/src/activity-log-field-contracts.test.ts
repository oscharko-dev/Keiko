import { describe, expect, expectTypeOf, it } from "vitest";
import {
  activityLogBooleanField,
  activityLogCountField,
  activityLogDurationField,
  activityLogStringEnumField,
} from "./activity-log-field-contracts.js";
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
