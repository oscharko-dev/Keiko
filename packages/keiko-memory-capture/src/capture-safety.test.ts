import { describe, expect, it } from "vitest";

import { memoryTextEgressRejectionReason } from "./capture-safety.js";

describe("memoryTextEgressRejectionReason", () => {
  it("returns null for public memory-safe text", () => {
    expect(memoryTextEgressRejectionReason("The user prefers vitest for tests.")).toBeNull();
  });

  it("blocks credential-shaped text before secondary model egress", () => {
    const apiKey = ["sk-", "abcdefghijklmnopqrstuvwxyz12345"].join("");
    expect(memoryTextEgressRejectionReason(`remember api_key=${apiKey}`)).toBe("credential-shape");
  });

  it("blocks configured customer identifiers before secondary model egress", () => {
    expect(
      memoryTextEgressRejectionReason("CustomerOmega requires SSO.", {
        customerIdentifierMatchers: [/CustomerOmega/],
      }),
    ).toBe("customer-identifier");
  });

  it("blocks non-public sensitivity before secondary model egress", () => {
    expect(memoryTextEgressRejectionReason("my private support email is dev@example.com")).toBe(
      "sensitive-memory-requires-approval",
    );
  });
});
