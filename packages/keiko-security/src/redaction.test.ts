import { describe, expect, it } from "vitest";
import { createAuditRedactor, deepRedactStrings, redact } from "./redaction.js";

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

  // Epic #532 security audit H1 — key-name-based value redaction for secrets with no token SHAPE,
  // now reachable via full-machine file previews and grounded answers.
  it("redacts a gcloud refresh_token value in JSON shape", () => {
    const secret = "1//refreshTOKENvalue1234567890abcdef";
    const result = redact(`{"client_id":"x.apps","refresh_token":"${secret}"}`);
    expect(result).not.toContain(secret);
    expect(result).toContain("refresh_token");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a service-account client_secret value", () => {
    const secret = "GOCSPX-supersecretclientvalue99";
    const result = redact(`"client_secret": "${secret}"`);
    expect(result).not.toContain(secret);
    expect(result).toContain("client_secret");
  });

  it("redacts a generic password assignment in env/ini shape", () => {
    const result = redact("DB_PASSWORD=hunter2superSecretValue");
    expect(result).not.toContain("hunter2superSecretValue");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts an aws_secret_access_key value by key name", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const result = redact(`aws_secret_access_key = ${secret}`);
    expect(result).not.toContain(secret);
  });

  it("strips userinfo credentials from a DB/URL connection string", () => {
    const result = redact("postgres://admin:s3cr3tPassw0rd@db.internal:5432/app");
    expect(result).not.toContain("s3cr3tPassw0rd");
    expect(result).toContain("postgres://");
    expect(result).toContain("@db.internal:5432/app");
  });

  it("does not redact a benign 'password reset' sentence with no assignment", () => {
    const prose = "Follow the password reset link to continue.";
    expect(redact(prose)).toBe(prose);
  });
});

// Secret-shaped fixtures are built by concatenation/repeat so no contiguous real-shaped token
// literal appears in source (GitHub push-protection would otherwise block the push).
const GITHUB = `ghp_${"A".repeat(36)}`;
const OPENAI = "sk-" + "x".repeat(24);
const AWS = "AKIA" + "B".repeat(16);
const SLACK = "xoxb-" + "1".repeat(20);
const GOOGLE = "AIza" + "C".repeat(30);
const PEM = "-----BEGIN RSA PRIVATE KEY-----";
const BEARER = "Bearer " + "z".repeat(32);
const BASIC = "Basic " + Buffer.from("user:pass").toString("base64");
const AUTH_HEADER = "authorization: Bearer " + "q".repeat(40);
const API_KEY_VALUE = "generic-key-value-" + "k".repeat(16);

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
    ["basic auth credential", BASIC],
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

  it("keeps the Basic scheme but drops the credential in an auth header", () => {
    const out = redactor(`Authorization: ${BASIC}`);
    expect(out).toContain("Basic [REDACTED]");
    expect(out).not.toContain(BASIC);
  });

  it("scrubs generic API key headers and assignments", () => {
    const input = [
      `X-API-Key: ${API_KEY_VALUE}`,
      `api_key=${API_KEY_VALUE}`,
      `api-key: ${API_KEY_VALUE}`,
    ].join("\n");
    const out = redactor(input);
    expect(out).toContain("X-API-Key: [REDACTED]");
    expect(out).toContain("api_key=[REDACTED]");
    expect(out).toContain("api-key: [REDACTED]");
    expect(out).not.toContain(API_KEY_VALUE);
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

describe("deepRedactStrings", () => {
  it("redacts every string leaf of a nested structure", () => {
    const redactor = createAuditRedactor({}, {});
    const input = {
      a: "Authorization: Bearer " + "x".repeat(32),
      b: [{ c: "sk-" + "y".repeat(24) }, "plain"],
      n: 42,
      flag: true,
      missing: null,
    };
    const result = deepRedactStrings(input, redactor) as typeof input;
    expect(result.a).toContain("Bearer [REDACTED]");
    expect((result.b as readonly { c: string }[])[0]?.c).toContain("[REDACTED]");
    expect((result.b as readonly unknown[])[1]).toBe("plain");
    expect(result.n).toBe(42);
    expect(result.flag).toBe(true);
    expect(result.missing).toBeNull();
  });

  it("never mutates the source structure", () => {
    const redactor = createAuditRedactor({}, {});
    const original = { a: "Bearer " + "z".repeat(20) };
    deepRedactStrings(original, redactor);
    expect(original.a).toContain("z".repeat(20));
  });
});
