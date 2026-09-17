import { describe, expect, it } from "vitest";

import {
  ActivityLogEventValidationError,
  ERROR_KIND_PATTERN,
  activityLogEvent,
  classifyErrorKind,
  defineActivityLogOperation,
  isErrorKind,
} from "./observability.js";

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

    if (false) {
      // @ts-expect-error each array member stays inside the registered vocabulary
      activityLogEvent(operation, {}, { reasons: ["third"] });
    }
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

    if (false) {
      const rawFields = { itemCount: 2, rawBody: "forbidden" };
      // @ts-expect-error required registered field is missing
      activityLogEvent(operation, {}, {});
      // @ts-expect-error unregistered fields cannot enter the event
      activityLogEvent(operation, {}, { itemCount: 2, rawBody: "forbidden" });
      // @ts-expect-error a widened variable cannot smuggle an unregistered field
      activityLogEvent(operation, {}, rawFields);
      // @ts-expect-error registered count fields are numeric
      activityLogEvent(operation, {}, { itemCount: "two" });
    }

    expect(() =>
      activityLogEvent(operation, { correlationId: "registry-fixture-correlation" }, {
        itemCount: 2,
        rawBody: "secret",
      } as never),
    ).toThrow(new ActivityLogEventValidationError("unknown-field"));
    expect(() =>
      activityLogEvent(operation, { correlationId: "registry-fixture-correlation" }, {
        itemCount: "two",
      } as never),
    ).toThrow(new ActivityLogEventValidationError("invalid-field-type"));
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
