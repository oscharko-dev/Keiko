import { describe, expect, it } from "vitest";

import {
  createAuditRedactor,
  deepRedactStrings,
  isCredentialKeyName,
  objectContainsCredentialKey,
} from "./redaction.js";

// Secret-shaped fixtures are assembled so push-protection never sees a real-looking literal.
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
const INTERNAL_TOKEN_VALUE = ["super-secret-value-", "1234567890"].join("");

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

describe("credential key-name scanner", () => {
  it.each([
    "password",
    "client_secret",
    "clientSecret",
    "refresh_token",
    "connection_string",
    "aws_secret_access_key",
  ])("recognizes credential key %s", (key) => {
    expect(isCredentialKeyName(key)).toBe(true);
  });

  it("finds credential keys in nested payload objects", () => {
    expect(objectContainsCredentialKey({ nested: [{ client_secret: "opaque" }] })).toBe(true);
  });

  it("does not flag adjacent non-secret metadata keys", () => {
    expect(objectContainsCredentialKey({ tokenCount: 42, secretariat: "team" })).toBe(false);
  });
});

describe("createAuditRedactor — env-value redaction", () => {
  it("scrubs the VALUE of a named env var that appears in text, never the name", () => {
    const env = { INTERNAL_TOKEN: INTERNAL_TOKEN_VALUE };
    const redactor = createAuditRedactor({ redactEnvValues: ["INTERNAL_TOKEN"] }, env);
    const out = redactor(`the rationale mentions ${INTERNAL_TOKEN_VALUE} inline`);
    expect(out).not.toContain(INTERNAL_TOKEN_VALUE);
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
    expect(redactor(once)).toBe(once);
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

  it("scrubs a token URL nested in a git remote-summary payload", () => {
    const redactor = createAuditRedactor({}, {});
    const body = {
      branch: "main",
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://opaque-pat-value@github.com/o/r.git",
          pushUrl: undefined,
        },
        { name: "ssh", fetchUrl: "ssh://git@github.com/o/r.git", pushUrl: undefined },
      ],
    };
    const result = deepRedactStrings(body, redactor) as typeof body;
    expect(result.remotes[0]?.fetchUrl).toBe("https://[REDACTED]@github.com/o/r.git");
    expect(result.remotes[0]?.fetchUrl).not.toContain("opaque-pat-value");
    expect(result.remotes[1]?.fetchUrl).toBe("ssh://git@github.com/o/r.git");
  });
});
