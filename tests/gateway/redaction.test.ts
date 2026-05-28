import { describe, expect, it } from "vitest";
import { redact } from "../../src/gateway/redaction.js";

describe("redact", () => {
  it("redacts a bearer token while keeping the scheme", () => {
    const result = redact("Authorization: Bearer sk-abc123DEF456ghi789jkl012mno345");
    expect(result).not.toContain("sk-abc123DEF456ghi789jkl012mno345");
    expect(result).toContain("Bearer [REDACTED]");
  });

  it("redacts a standalone sk- prefixed key", () => {
    const result = redact("key=sk-abcDEF123456789012345678901234");
    expect(result).not.toContain("sk-abcDEF123456789012345678901234");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts every secret when multiple appear in one string", () => {
    const raw = "first sk-AAAAAAAAAAAAAAAAAAAAAAAA then Bearer sk-BBBBBBBBBBBBBBBBBBBBBBBB";
    const result = redact(raw);
    expect(result).not.toContain("sk-AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(result).not.toContain("sk-BBBBBBBBBBBBBBBBBBBBBBBB");
  });

  it("leaves a benign string unchanged", () => {
    expect(redact("the quick brown fox")).toBe("the quick brown fox");
  });

  it("leaves an empty string unchanged", () => {
    expect(redact("")).toBe("");
  });

  it("redacts a known secret value passed as an explicit additional secret", () => {
    const secret = "my-custom-token-value-987";
    const result = redact(`token is ${secret} ok`, [secret]);
    expect(result).not.toContain(secret);
    expect(result).toContain("[REDACTED]");
  });

  it("does not redact an empty additional secret entry", () => {
    expect(redact("hello world", [""])).toBe("hello world");
  });
});
