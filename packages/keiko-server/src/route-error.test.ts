import { describe, expect, it } from "vitest";
import { errorBody } from "./route-error.js";

describe("the error body's closed refusal reason (F31)", () => {
  it("carries a reason from the closed vocabulary with its line", () => {
    expect(
      errorBody("INVALID_REQUEST", "x", "c-1", { reason: "template-unknown-key", line: 7 }),
    ).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "x",
        correlationId: "c-1",
        reason: "template-unknown-key",
        line: 7,
      },
    });
  });

  it.each(["INVALID_REQUEST", "", "template-", "some free text with a path /tmp/x"])(
    "drops a reason that is not in the vocabulary: %j",
    (reason) => {
      const body = errorBody("INVALID_REQUEST", "x", undefined, { reason, line: 3 });
      expect(body).toEqual({ error: { code: "INVALID_REQUEST", message: "x" } });
    },
  );

  it("adds nothing without a refusal", () => {
    expect(errorBody("NOT_FOUND", "x", "c-2")).toEqual({
      error: { code: "NOT_FOUND", message: "x", correlationId: "c-2" },
    });
  });
});
