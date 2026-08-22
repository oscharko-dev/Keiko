import { describe, expect, it } from "vitest";
import {
  HARNESS_CODES,
  HarnessError,
  HarnessInternalError,
  HarnessModelError,
  HarnessToolError,
  LimitExceededError,
  toFailure,
} from "./harness.js";

describe("harness errors", () => {
  it("redacts the message at construction", () => {
    const secret = "sk-" + "u".repeat(24);
    const error = new HarnessModelError(`failed with ${secret}`);
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("[REDACTED]");
  });

  it("carries stable codes", () => {
    expect(new HarnessModelError("m").code).toBe(HARNESS_CODES.MODEL_ERROR);
    expect(new HarnessToolError("m").code).toBe(HARNESS_CODES.TOOL_ERROR);
    expect(new HarnessInternalError("m").code).toBe(HARNESS_CODES.INTERNAL);
  });

  it("subclasses are HarnessError and real Error", () => {
    expect(new HarnessToolError("m")).toBeInstanceOf(HarnessError);
    expect(new HarnessInternalError("m")).toBeInstanceOf(Error);
  });

  describe("LimitExceededError", () => {
    it("carries the caller-supplied code discriminant", () => {
      const error = new LimitExceededError(HARNESS_CODES.MODEL_ERROR, "budget exceeded");
      expect(error.code).toBe(HARNESS_CODES.MODEL_ERROR);
      expect(error).toBeInstanceOf(HarnessError);
    });

    it("defaults secrets to an empty list when omitted", () => {
      // No third argument at all — exercises the `secrets: readonly string[] = []` default-arg
      // branch, distinct from explicitly passing an empty array.
      const error = new LimitExceededError(HARNESS_CODES.TOOL_ERROR, "no extra secrets here");
      expect(error.message).toBe("no extra secrets here");
    });

    it("redacts a caller-supplied secret when one is passed", () => {
      const error = new LimitExceededError(HARNESS_CODES.INTERNAL, "contains hunter2 value", [
        "hunter2",
      ]);
      expect(error.message).not.toContain("hunter2");
    });
  });

  describe("toFailure", () => {
    it("omits detail entirely when it is undefined", () => {
      const failure = toFailure(HARNESS_CODES.MODEL_ERROR, "model call failed");
      expect(failure).toEqual({
        category: HARNESS_CODES.MODEL_ERROR,
        message: "model call failed",
      });
      expect(Object.keys(failure)).not.toContain("detail");
    });

    it("carries detail when one is supplied", () => {
      const failure = toFailure(HARNESS_CODES.TOOL_ERROR, "tool call failed", "raw diagnostic");
      expect(failure).toEqual({
        category: HARNESS_CODES.TOOL_ERROR,
        message: "tool call failed",
        detail: "raw diagnostic",
      });
    });
  });
});
