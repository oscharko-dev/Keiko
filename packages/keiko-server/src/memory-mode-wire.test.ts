import { describe, expect, it } from "vitest";
import { parseMemoryRequest } from "./chat-handlers.js";

describe("conversation memory mode wire", () => {
  it("keeps the byte-identical legacy shape when mode is absent", () => {
    expect(
      parseMemoryRequest({ enabled: true, budgetTokens: 800, context: { userId: "local" } }),
    ).toEqual({ enabled: true, budgetTokens: 800, context: { userId: "local" } });
  });

  it("accepts canonical modes additively and rejects unknown values", () => {
    expect(
      parseMemoryRequest({
        enabled: true,
        mode: "autonomous-delivery",
        context: { userId: "local" },
      }),
    ).toEqual({
      enabled: true,
      mode: "autonomous-delivery",
      context: { userId: "local" },
    });
    expect(
      parseMemoryRequest({ enabled: true, mode: "unbounded", context: { userId: "local" } }),
    ).toMatchObject({ status: 400 });
  });
});
