import { describe, expect, it, vi } from "vitest";
import {
  CallerAttemptAdmissionError,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { withNestedCallerAdmission } from "./chat-tool-nested-admission.js";

const REQUEST: GatewayCallRequest = { modelId: "nested-proof", messages: [] };
const INPUT = { promptTokens: 100, maxOutputTokens: 100 };

describe("nested caller admission", () => {
  it("preserves optional and identical admission owners without charging them twice", () => {
    const parent = vi.fn(() => ({ settle: vi.fn() }));
    expect(withNestedCallerAdmission(REQUEST, undefined)).toBe(REQUEST);
    const same = { ...REQUEST, attemptAdmission: parent };
    expect(withNestedCallerAdmission(same, parent)).toBe(same);
    const admitted = withNestedCallerAdmission(REQUEST, parent).attemptAdmission?.(INPUT);
    expect(parent).toHaveBeenCalledExactlyOnceWith(INPUT);
    expect(admitted).toBeDefined();
  });

  it("refuses before the nested owner when the enclosing caller has no allowance", () => {
    const nested = vi.fn(() => ({ settle: vi.fn() }));
    const request = withNestedCallerAdmission(
      { ...REQUEST, attemptAdmission: nested },
      () => undefined,
    );
    expect(request.attemptAdmission?.(INPUT)).toBeUndefined();
    expect(nested).not.toHaveBeenCalled();
  });

  it("narrows both output maxima and settles each reservation exactly once", () => {
    const parentSettle = vi.fn();
    const nestedSettle = vi.fn();
    const nested = vi.fn(() => ({ maxOutputTokens: 10, settle: nestedSettle }));
    const request = withNestedCallerAdmission({ ...REQUEST, attemptAdmission: nested }, () => ({
      maxOutputTokens: 25,
      settle: parentSettle,
    }));
    const reservation = request.attemptAdmission?.(INPUT);
    expect(nested).toHaveBeenCalledExactlyOnceWith({ ...INPUT, maxOutputTokens: 25 });
    expect(reservation?.maxOutputTokens).toBe(10);
    const usage = { promptTokens: 100, completionTokens: 5 };
    reservation?.settle(usage, true, "observed");
    reservation?.settle(usage, true, "observed");
    expect(parentSettle).toHaveBeenCalledExactlyOnceWith(usage, true, "observed");
    expect(nestedSettle).toHaveBeenCalledExactlyOnceWith(usage, true, "observed");
  });

  it.each(["refused", "thrown"])("releases the parent after a nested admission is %s", (kind) => {
    const settle = vi.fn();
    const failure = new Error("Synthetic nested refusal");
    const request = withNestedCallerAdmission(
      {
        ...REQUEST,
        attemptAdmission: () => {
          if (kind === "thrown") throw failure;
          return undefined;
        },
      },
      () => ({ settle }),
    );
    if (kind === "thrown") expect(() => request.attemptAdmission?.(INPUT)).toThrow(failure);
    else expect(request.attemptAdmission?.(INPUT)).toBeUndefined();
    expect(settle).toHaveBeenCalledExactlyOnceWith(undefined, false, "none");
  });

  it.each([0, -1, 101, Number.NaN])("refuses an invalid parent output grant %s", (limit) => {
    const settle = vi.fn();
    const nested = vi.fn(() => ({ settle: vi.fn() }));
    const request = withNestedCallerAdmission({ ...REQUEST, attemptAdmission: nested }, () => ({
      maxOutputTokens: limit,
      settle,
    }));
    expect(() => request.attemptAdmission?.(INPUT)).toThrow(CallerAttemptAdmissionError);
    expect(nested).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledExactlyOnceWith(undefined, false, "none");
  });

  it("refuses a nested grant that widens the parent and releases both reservations", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const request = withNestedCallerAdmission(
      { ...REQUEST, attemptAdmission: () => ({ maxOutputTokens: 26, settle: inner }) },
      () => ({ maxOutputTokens: 25, settle: outer }),
    );
    expect(() => request.attemptAdmission?.(INPUT)).toThrow(CallerAttemptAdmissionError);
    expect(inner).toHaveBeenCalledExactlyOnceWith(undefined, false, "none");
    expect(outer).toHaveBeenCalledExactlyOnceWith(undefined, false, "none");
  });

  it("settles the parent even when the nested owner throws during settlement", () => {
    const outer = vi.fn();
    const failure = new Error("Synthetic settlement failure");
    const inner = vi.fn(() => {
      throw failure;
    });
    const request = withNestedCallerAdmission(
      { ...REQUEST, attemptAdmission: () => ({ settle: inner }) },
      () => ({ settle: outer }),
    );
    const reservation = request.attemptAdmission?.(INPUT);
    expect(() => reservation?.settle(undefined, false, "none")).toThrow(failure);
    reservation?.settle(undefined, false, "none");
    expect(outer).toHaveBeenCalledExactlyOnceWith(undefined, false, "none");
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
