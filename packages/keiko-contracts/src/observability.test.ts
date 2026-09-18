import { describe, expect, it } from "vitest";

import {
  ACTIVITY_LOG_EVENT_REGISTRATION,
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  ActivityLogEventValidationError,
  ERROR_KIND_PATTERN,
  activityLogEvent,
  activityLogOperationSchema,
  classifyErrorKind,
  defineActivityLogOperation,
  isErrorKind,
  validateRegisteredActivityLogEvent,
  type ActivityLogFieldContract,
  type ActivityLogOperationRegistration,
} from "./observability.js";

function emitFixtureValue(contract: ActivityLogFieldContract, value: unknown): void {
  const operation = defineActivityLogOperation({
    contractKind: "activity-log-operation",
    schemaVersion: 1,
    op: "registry.fixture.data-class",
    category: "diagnostic",
    owner: "keiko-contracts",
    emitter: "observability.test.data-class",
    fields: { value: contract },
    causal: "none",
    lifecycle: "state",
    analyzerProjection: "timeline",
    failureClasses: ["registry-fixture"],
    proofIds: ["registry-fixture-data-class"],
    releaseImpact: "none",
  });
  const event = activityLogEvent(operation, {}, { value } as never);
  const emittedOp: unknown = Reflect.get(event, "op");
  if (emittedOp !== operation.op) validateRegisteredActivityLogEvent(event);
}

function canonicalFixtureRegistration(): ActivityLogOperationRegistration {
  const registration = activityLogOperationSchema("gateway.instance.reused");
  if (registration === undefined) throw new Error("canonical fixture registration is missing");
  return registration;
}

function attachRegistration(
  event: Record<PropertyKey, unknown>,
  registration: ActivityLogOperationRegistration,
): Readonly<Record<PropertyKey, unknown>> {
  Object.defineProperty(event, ACTIVITY_LOG_EVENT_REGISTRATION, { value: registration });
  return event;
}

describe("ERROR_KIND_PATTERN (ADR-0173 D11)", () => {
  it("accepts an identifier, a taxonomy code, and a constructor name", () => {
    expect(ERROR_KIND_PATTERN.test("PROXY_BLOCKED_BY_POLICY")).toBe(true);
    expect(ERROR_KIND_PATTERN.test("ECONNREFUSED")).toBe(true);
    expect(ERROR_KIND_PATTERN.test("TypeError")).toBe(true);
    expect(ERROR_KIND_PATTERN.test("http-error")).toBe(true);
  });

  it("rejects a sentence, which is where a provider's rejected input hides", () => {
    expect(ERROR_KIND_PATTERN.test("Setting {'encoding_format': 'float'} is not supported")).toBe(
      false,
    );
    expect(ERROR_KIND_PATTERN.test("token sk-proj-abc is invalid")).toBe(false);
  });

  it("rejects an empty string and a value not starting with a letter", () => {
    expect(ERROR_KIND_PATTERN.test("")).toBe(false);
    expect(ERROR_KIND_PATTERN.test("9NOTANIDENTIFIER")).toBe(false);
    expect(ERROR_KIND_PATTERN.test("_leading-underscore")).toBe(false);
  });

  it("accepts exactly 64 characters and rejects a longer run that could hide a payload", () => {
    expect(ERROR_KIND_PATTERN.test(`E${"x".repeat(63)}`)).toBe(true);
    expect(ERROR_KIND_PATTERN.test(`E${"x".repeat(64)}`)).toBe(false);
  });
});

describe("isErrorKind", () => {
  it("narrows a conforming string and rejects a non-conforming one", () => {
    expect(isErrorKind("RangeError")).toBe(true);
    expect(isErrorKind("not an identifier!")).toBe(false);
  });

  it("rejects every non-string value", () => {
    expect(isErrorKind(42)).toBe(false);
    expect(isErrorKind(undefined)).toBe(false);
    expect(isErrorKind(null)).toBe(false);
    expect(isErrorKind({ code: "AbortError" })).toBe(false);
  });
});

describe("classifyErrorKind", () => {
  it("returns the value unchanged when it conforms", () => {
    expect(classifyErrorKind("AbortError")).toBe("AbortError");
  });

  it("returns undefined for a non-conforming or non-string value", () => {
    expect(classifyErrorKind("a whole sentence of prose")).toBeUndefined();
    expect(classifyErrorKind(123)).toBeUndefined();
    expect(classifyErrorKind(undefined)).toBeUndefined();
  });
});

describe("typed Activity Log operation registration", () => {
  it("types every member of a governed string-array vocabulary", () => {
    const operation = defineActivityLogOperation({
      contractKind: "activity-log-operation",
      schemaVersion: 1,
      op: "registry.fixture.array",
      category: "diagnostic",
      owner: "keiko-contracts",
      emitter: "observability.test.array",
      fields: {
        reasons: {
          type: "string-array",
          dataClass: "closed-enum",
          required: true,
          values: ["first", "second"],
        },
      },
      causal: "none",
      lifecycle: "state",
      analyzerProjection: "timeline",
      failureClasses: ["registry-fixture"],
      proofIds: ["registry-fixture-array-emitted-line"],
      releaseImpact: "none",
    });

    expect(activityLogEvent(operation, {}, { reasons: ["first", "second"] }).extra).toEqual({
      completeness: "complete",
      loss: "none",
      reasons: ["first", "second"],
    });

    const assertInvalidArrayMember = (): void => {
      // @ts-expect-error each array member stays inside the registered vocabulary
      activityLogEvent(operation, {}, { reasons: ["third"] });
    };
    expect(assertInvalidArrayMember).toBeTypeOf("function");
  });

  it("binds an emitted field set to one immutable operation identity", () => {
    const operation = defineActivityLogOperation({
      contractKind: "activity-log-operation",
      schemaVersion: 1,
      op: "registry.fixture.completed",
      category: "diagnostic",
      owner: "keiko-contracts",
      emitter: "observability.test",
      fields: {
        itemCount: { type: "integer", dataClass: "count", required: true },
      },
      causal: "correlation",
      lifecycle: "end",
      analyzerProjection: "timeline",
      failureClasses: ["registry-fixture"],
      proofIds: ["registry-fixture-emitted-line"],
      releaseImpact: "patch",
    });

    expect(
      activityLogEvent(
        operation,
        { correlationId: "registry-fixture-correlation" },
        { itemCount: 2 },
      ),
    ).toEqual({
      category: "diagnostic",
      op: "registry.fixture.completed",
      correlationId: "registry-fixture-correlation",
      extra: { completeness: "complete", loss: "none", itemCount: 2 },
    });

    const assertInvalidFieldTypes = (): void => {
      const rawFields = { itemCount: 2, rawBody: "forbidden" };
      // @ts-expect-error required registered field is missing
      activityLogEvent(operation, {}, {});
      // @ts-expect-error unregistered fields cannot enter the event
      activityLogEvent(operation, {}, { itemCount: 2, rawBody: "forbidden" });
      // @ts-expect-error a widened variable cannot smuggle an unregistered field
      activityLogEvent(operation, {}, rawFields);
      // @ts-expect-error registered count fields are numeric
      activityLogEvent(operation, {}, { itemCount: "two" });
    };
    expect(assertInvalidFieldTypes).toBeTypeOf("function");

    expect(() =>
      validateRegisteredActivityLogEvent(
        activityLogEvent(operation, { correlationId: "registry-fixture-correlation" }, {
          itemCount: 2,
          rawBody: "secret",
        } as never),
      ),
    ).toThrow(new ActivityLogEventValidationError("unknown-field"));
    expect(() =>
      validateRegisteredActivityLogEvent(
        activityLogEvent(operation, { correlationId: "registry-fixture-correlation" }, {
          itemCount: "two",
        } as never),
      ),
    ).toThrow(new ActivityLogEventValidationError("invalid-field-type"));
  });

  it("normalizes legacy correlation ids while preserving causal requirements", () => {
    const correlated = defineActivityLogOperation({
      contractKind: "activity-log-operation",
      schemaVersion: 1,
      op: "registry.fixture.correlated",
      category: "diagnostic",
      owner: "keiko-contracts",
      emitter: "observability.test.correlated",
      fields: {},
      causal: "correlation",
      lifecycle: "state",
      analyzerProjection: "timeline",
      failureClasses: ["registry-fixture"],
      proofIds: ["registry-fixture-correlated-emitted-line"],
      releaseImpact: "none",
    });
    const parentCorrelated = defineActivityLogOperation({
      ...correlated,
      op: "registry.fixture.parent-correlated",
      emitter: "observability.test.parent-correlated",
      causal: "parent-correlation",
      proofIds: ["registry-fixture-parent-correlated-emitted-line"],
    });

    expect(activityLogEvent(correlated, { correlationId: "run-1" }, {})).toMatchObject({
      correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
    });
    expect(activityLogEvent(correlated, {}, {})).toMatchObject({
      correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
    });
    expect(
      activityLogEvent(
        parentCorrelated,
        { correlationId: "corr-1", parentCorrelationId: "run-1" },
        {},
      ),
    ).toMatchObject({
      correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
      parentCorrelationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
    });
  });

  it("preserves explicit partial and loss evidence while rejecting global contract drift", () => {
    const registration = {
      contractKind: "activity-log-operation",
      schemaVersion: 1,
      op: "registry.fixture.loss",
      category: "diagnostic",
      owner: "keiko-contracts",
      emitter: "observability.test.loss",
      fields: {},
      causal: "none",
      lifecycle: "loss",
      analyzerProjection: "timeline",
      failureClasses: ["registry-fixture"],
      proofIds: ["registry-fixture-loss-emitted-line"],
      releaseImpact: "none",
    } as const;
    const event = activityLogEvent(
      defineActivityLogOperation(registration),
      {},
      {
        completeness: "partial",
        loss: "event-dropped",
      },
    );

    expect(event.extra).toEqual({ completeness: "partial", loss: "event-dropped" });
    expect(() =>
      defineActivityLogOperation({
        ...registration,
        fields: {
          completeness: { type: "string", dataClass: "closed-enum", required: true },
        },
      }),
    ).toThrow(new ActivityLogEventValidationError("registration-mismatch"));
  });
});

describe("Activity Log data-class validation", () => {
  it.each([
    [
      "digest",
      { type: "string", dataClass: "digest", required: true, maxLength: 64 },
      "a".repeat(64),
    ],
    [
      "error kind",
      { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
      "TypeError",
    ],
    [
      "opaque id",
      { type: "string", dataClass: "opaque-id", required: true, maxLength: 64 },
      "request-123:attempt-2",
    ],
    [
      "platform class",
      { type: "string", dataClass: "safe-platform-class", required: true, maxLength: 64 },
      "linux-x64",
    ],
    [
      "version",
      { type: "string", dataClass: "safe-version", required: true, maxLength: 64 },
      "1.2.3-beta.1+build.4",
    ],
  ] as const)("accepts a body-free %s", (_label, contract, value) => {
    expect(() => {
      emitFixtureValue(contract, value);
    }).not.toThrow();
  });

  it.each([
    [
      "digest",
      { type: "string", dataClass: "digest", required: true, maxLength: 64 },
      "patient cancer",
    ],
    [
      "error kind",
      { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
      "provider response failed",
    ],
    [
      "opaque id",
      { type: "string", dataClass: "opaque-id", required: true, maxLength: 64 },
      "customer diagnosis",
    ],
    [
      "platform class",
      { type: "string", dataClass: "safe-platform-class", required: true, maxLength: 64 },
      "customer workstation",
    ],
    [
      "version",
      { type: "string", dataClass: "safe-version", required: true, maxLength: 64 },
      "release candidate one",
    ],
  ] as const)("rejects prose carried as a %s", (_label, contract, value) => {
    expect(() => {
      emitFixtureValue(contract, value);
    }).toThrow(new ActivityLogEventValidationError("invalid-field-vocabulary"));
  });

  it("applies semantic validation to each array member", () => {
    const contract = {
      type: "string-array",
      dataClass: "digest",
      required: true,
      maxLength: 64,
      maxItems: 2,
    } as const;

    expect(() => {
      emitFixtureValue(contract, ["a".repeat(64), "b".repeat(16)]);
    }).not.toThrow();
    expect(() => {
      emitFixtureValue(contract, ["a".repeat(64), "raw customer body"]);
    }).toThrow(new ActivityLogEventValidationError("invalid-field-vocabulary"));
  });

  it("rejects unsafe integer counts and versions", () => {
    const count = { type: "integer", dataClass: "count", required: true } as const;
    const version = { type: "integer", dataClass: "safe-version", required: true } as const;

    expect(() => {
      emitFixtureValue(count, Number.MAX_SAFE_INTEGER + 1);
    }).toThrow(new ActivityLogEventValidationError("invalid-field-type"));
    expect(() => {
      emitFixtureValue(version, -1);
    }).toThrow(new ActivityLogEventValidationError("invalid-field-bound"));
  });
});

describe("canonical Activity Log event validation", () => {
  it("accepts an exact structural copy and returns the generated canonical registration", () => {
    const canonical = canonicalFixtureRegistration();
    const attached = {
      ...canonical,
      fields: structuredClone(canonical.fields),
      failureClasses: [...canonical.failureClasses],
      proofIds: [...canonical.proofIds],
    };
    const event = attachRegistration(
      {
        category: canonical.category,
        op: canonical.op,
        extra: { completeness: "complete", loss: "none", generation: 1 },
      },
      attached,
    );

    expect(validateRegisteredActivityLogEvent(event)).toBe(canonical);
  });

  it("rejects attached registration metadata that differs from the generated contract", () => {
    const canonical = canonicalFixtureRegistration();
    const event = attachRegistration(
      {
        category: canonical.category,
        op: canonical.op,
        extra: { completeness: "complete", loss: "none", generation: 1 },
      },
      { ...canonical, owner: "forged-owner" },
    );

    expect(() => validateRegisteredActivityLogEvent(event)).toThrow(
      new ActivityLogEventValidationError("registration-mismatch"),
    );
  });

  it("rejects an attached operation that does not exist in the generated registry", () => {
    const canonical = canonicalFixtureRegistration();
    const attached = { ...canonical, op: "registry.fixture.forged" };
    const event = attachRegistration(
      {
        category: attached.category,
        op: attached.op,
        extra: { completeness: "complete", loss: "none", generation: 1 },
      },
      attached,
    );

    expect(() => validateRegisteredActivityLogEvent(event)).toThrow(
      new ActivityLogEventValidationError("unregistered-operation"),
    );
  });

  it("validates event fields against the canonical contract", () => {
    const canonical = canonicalFixtureRegistration();
    const event = attachRegistration(
      {
        category: canonical.category,
        op: canonical.op,
        extra: { completeness: "complete", loss: "none" },
      },
      canonical,
    );

    expect(() => validateRegisteredActivityLogEvent(event)).toThrow(
      new ActivityLogEventValidationError("missing-field"),
    );
  });

  it("keeps strict validation fail-closed for a raw short correlation id", () => {
    const canonical = canonicalFixtureRegistration();
    const event = attachRegistration(
      {
        category: canonical.category,
        op: canonical.op,
        correlationId: "run-1",
        extra: { completeness: "complete", loss: "none", generation: 1 },
      },
      canonical,
    );

    expect(() => validateRegisteredActivityLogEvent(event)).toThrow(
      new ActivityLogEventValidationError("invalid-field-bound"),
    );
  });
});
