import { describe, expect, it } from "vitest";
import { buildRedactor } from "../../src/ui/deps.js";

describe("buildRedactor", () => {
  it("scrubs non-pattern secret values from sensitive environment variables", () => {
    const secret = "CORPSECRET_123456789";
    const redactor = buildRedactor({ KEIKO_DEFAULT_API_KEY: secret });
    expect(redactor({ message: `token=${secret}` })).toEqual({ message: "token=[REDACTED]" });
  });
});
