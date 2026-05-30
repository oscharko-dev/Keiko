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

  it("redacts a GitHub personal-access token", () => {
    const token = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // split so the literal is not contiguous
    const result = redact(`token=${token}`);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts the other GitHub token prefixes (gho/ghu/ghs/ghr)", () => {
    for (const prefix of ["gho_", "ghu_", "ghs_", "ghr_"]) {
      const token = `${prefix}ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`;
      expect(redact(token)).not.toContain(token);
    }
  });

  it("redacts an AWS access key id", () => {
    const key = "AKIA" + "IOSFODNN7EXAMPLE"; // split so the literal is not contiguous
    const result = redact(`aws_access_key_id = ${key}`);
    expect(result).not.toContain(key);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a Slack token", () => {
    const token = "xoxb-" + "123456789012-abcdefghijklmnop"; // split so the literal is not contiguous
    const result = redact(`slack=${token}`);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a Google API key", () => {
    const key = "AIza" + "SyA1234567890_abcdefghijklmnopqrstu"; // split so the literal is not contiguous
    const result = redact(`key=${key}`);
    expect(result).not.toContain(key);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a PEM private-key header line", () => {
    const pemHeader = "-----BEGIN RSA " + "PRIVATE KEY-----"; // split so the literal is not contiguous
    const result = redact(pemHeader);
    expect(result).not.toContain("BEGIN RSA " + "PRIVATE KEY");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts an entire multiline PEM private-key block", () => {
    const pem = [
      "-----BEGIN RSA " + "PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      "sensitive-body-line",
      "-----END RSA " + "PRIVATE KEY-----",
    ].join("\n");
    const result = redact(`key:\n${pem}\nend`);
    expect(result).not.toContain("MIIEvQIBADAN");
    expect(result).not.toContain("sensitive-body-line");
    expect(result).not.toContain("END RSA " + "PRIVATE KEY");
    expect(result).toContain("[REDACTED]");
  });

  it("does not over-redact a git SHA", () => {
    const sha = "9fceb02d0ae598e95dc970b74767f19372d61af8";
    expect(redact(`commit ${sha}`)).toContain(sha);
  });

  it("does not over-redact a UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(redact(`id ${uuid}`)).toContain(uuid);
  });
});
