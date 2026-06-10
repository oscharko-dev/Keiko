import { describe, expect, it } from "vitest";

import { RetrievalError, type RetrievalErrorCode } from "./errors.js";

describe("RetrievalError", () => {
  it("preserves discriminated code and message", () => {
    const err = new RetrievalError("empty-scopes", "scopes must not be empty");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RetrievalError);
    expect(err.code).toBe<RetrievalErrorCode>("empty-scopes");
    expect(err.message).toBe("scopes must not be empty");
    expect(err.name).toBe("RetrievalError");
  });

  it("propagates cause when provided", () => {
    const root = new Error("port down");
    const err = new RetrievalError("port-failure", "listByScope threw", { cause: root });
    expect(err.cause).toBe(root);
  });

  it("supports every documented error code", () => {
    const codes: readonly RetrievalErrorCode[] = [
      "empty-scopes",
      "invalid-budget",
      "invalid-threshold",
      "invalid-weight",
      "port-failure",
    ];
    for (const code of codes) {
      const err = new RetrievalError(code, `code ${code}`);
      expect(err.code).toBe(code);
    }
  });
});
