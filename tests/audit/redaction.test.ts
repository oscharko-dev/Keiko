import { describe, expect, it } from "vitest";
import { createAuditRedactor } from "../../src/audit/redaction.js";

// Secret-shaped fixtures are built by concatenation/repeat so no contiguous real-shaped token
// literal appears in source (GitHub push-protection would otherwise block the push).
const GITHUB = `ghp_${"A".repeat(36)}`;
const OPENAI = "sk-" + "x".repeat(24);
const AWS = "AKIA" + "B".repeat(16);
const SLACK = "xoxb-" + "1".repeat(20);
const GOOGLE = "AIza" + "C".repeat(30);
const PEM = "-----BEGIN RSA PRIVATE KEY-----";
const BEARER = "Bearer " + "z".repeat(32);
const AUTH_HEADER = "authorization: Bearer " + "q".repeat(40);

describe("createAuditRedactor — builtin secret shapes", () => {
  const redactor = createAuditRedactor({}, {});

  it.each([
    ["github token", GITHUB],
    ["openai key", OPENAI],
    ["aws access key", AWS],
    ["slack token", SLACK],
    ["google api key", GOOGLE],
    ["pem header", PEM],
    ["bearer token", BEARER],
  ])("scrubs a %s to [REDACTED]", (_label, secret) => {
    const out = redactor(`prefix ${secret} suffix`);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secret);
  });

  it("keeps the Bearer scheme but drops the credential in an auth header", () => {
    const out = redactor(AUTH_HEADER);
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("q".repeat(40));
  });
});

describe("createAuditRedactor — env-value redaction", () => {
  it("scrubs the VALUE of a named env var that appears in text, never the name", () => {
    const env = { INTERNAL_TOKEN: "super-secret-value-1234567890" };
    const redactor = createAuditRedactor({ redactEnvValues: ["INTERNAL_TOKEN"] }, env);
    const out = redactor("the rationale mentions super-secret-value-1234567890 inline");
    expect(out).not.toContain("super-secret-value-1234567890");
    expect(out).toContain("[REDACTED]");
  });

  it("skips an unset or empty env value (no pathological all-match)", () => {
    const redactor = createAuditRedactor({ redactEnvValues: ["MISSING", "EMPTY"] }, { EMPTY: "" });
    const out = redactor("nothing to redact here");
    expect(out).toBe("nothing to redact here");
  });

  it("skips a too-short env value to avoid over-redaction", () => {
    const redactor = createAuditRedactor({ redactEnvValues: ["SHORT"] }, { SHORT: "ab" });
    const out = redactor("ab appears but is too short to be a secret");
    expect(out).toBe("ab appears but is too short to be a secret");
  });
});

describe("createAuditRedactor — configured literals", () => {
  it("scrubs a configured sensitive literal (e.g. an internal hostname)", () => {
    const redactor = createAuditRedactor({ sensitiveLiterals: ["internal.corp.example"] }, {});
    const out = redactor("connecting to internal.corp.example now");
    expect(out).not.toContain("internal.corp.example");
    expect(out).toContain("[REDACTED]");
  });

  it("scrubs caller-supplied additionalSecrets literally", () => {
    const redactor = createAuditRedactor({ additionalSecrets: ["my-api-base"] }, {});
    expect(redactor("base=my-api-base")).not.toContain("my-api-base");
  });
});

describe("createAuditRedactor — idempotence", () => {
  it("redacting twice equals redacting once", () => {
    const redactor = createAuditRedactor({ sensitiveLiterals: ["internal.corp.example"] }, {});
    const input = `${GITHUB} and ${OPENAI} and internal.corp.example and ${BEARER}`;
    const once = redactor(input);
    const twice = redactor(once);
    expect(twice).toBe(once);
  });

  it("does not mutate text with no secrets", () => {
    const redactor = createAuditRedactor({}, {});
    expect(redactor("plain harmless text")).toBe("plain harmless text");
  });
});
