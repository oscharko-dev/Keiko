import { describe, expect, it } from "vitest";

import { redact, redactWithRuleCounts } from "./redaction.js";
import { scanSensitiveText } from "./sensitive-text.js";

function expectSingleRule(
  input: string,
  expected: string,
  code: "authorization-secret" | "credential-assignment" | "url-userinfo",
): void {
  const first = redactWithRuleCounts(input);
  expect(first.value).toBe(expected);
  expect(first.rules).toEqual([{ code, count: 1 }]);
  expect(scanSensitiveText(input)).toBe("credential-shape");
  expect(scanSensitiveText(first.value)).toBeNull();
  expect(redactWithRuleCounts(first.value)).toEqual({ value: first.value, rules: [] });
}

function fastestRedactionMs(input: string): number {
  redactWithRuleCounts(input);
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    redactWithRuleCounts(input);
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

describe("shared credential redaction grammar", () => {
  it("fully consumes every governed Bearer and Basic token character", () => {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-";
    for (const scheme of ["Bearer", "Basic"] as const) {
      for (const character of characters) {
        expectSingleRule(
          `${scheme} abc${character}defghijklmnop`,
          `${scheme} [REDACTED]`,
          "authorization-secret",
        );
      }
    }
  });

  it.each([
    ['Bearer "opaque secret~value"', 'Bearer "[REDACTED]"'],
    ["Basic 'opaque secret value'", "Basic '[REDACTED]'"],
    ['Bearer "opaque \\"quoted\\" value"', 'Bearer "[REDACTED]"'],
  ])("fully consumes quoted authorization value %s", (input, expected) => {
    expectSingleRule(input, expected, "authorization-secret");
  });

  it("does not expose an inner authorization suffix from an overlapping quoted span", () => {
    expectSingleRule(
      'Bearer "Basic inner secret trailing"',
      'Bearer "[REDACTED]"',
      "authorization-secret",
    );
  });

  it("does not expose an authorization suffix outside the token character class", () => {
    expectSingleRule("Basic user:supersecret", "Basic [REDACTED]", "authorization-secret");
  });

  it.each([
    ["https://alice:pa:ss@example.com/repo", "https://[REDACTED]@example.com/repo"],
    ["postgres://user:p:a@db.internal/app", "postgres://[REDACTED]@db.internal/app"],
    ["https://user:p@ss@host/repo", "https://[REDACTED]@host/repo"],
    ["ssh://user:p:a@host/repo", "ssh://[REDACTED]@host/repo"],
    ["https://opaque-token@host/r", "https://[REDACTED]@host/r"],
  ])("redacts complete final-at URL userinfo in %s", (input, expected) => {
    expectSingleRule(input, expected, "url-userinfo");
  });

  it.each(["ssh://user@host/repo", "git+ssh://git@host/repo", "ssh+git://user@host/repo"])(
    "preserves a colonless SSH login in %s",
    (input) => {
      expect(redact(input)).toBe(input);
      expect(scanSensitiveText(input)).toBeNull();
    },
  );

  it.each([
    "OPENAI_API_KEY",
    "MY_API_KEY",
    "X_API_KEY",
    "openaiApiKey",
    "clientSecret",
    "dbPassword",
    "refreshToken",
    "accessToken",
    "jwtSecret",
  ])("redacts a governed prefixed or camel-case %s assignment", (key) => {
    const secret = "opaque secret value";
    const input = `${key} = "${secret}"`;
    const result = redactWithRuleCounts(input);

    expect(result.value).toBe(`${key} = "[REDACTED]"`);
    expect(result.value).not.toContain(secret);
    expect(result.rules).toEqual([{ code: "credential-assignment", count: 1 }]);
    expect(scanSensitiveText(input)).toBe("credential-shape");
    expect(scanSensitiveText(result.value)).toBeNull();
  });

  it("recognizes a governed suffix without allocating an unbounded key token", () => {
    const key = `${"PREFIX_".repeat(1_000)}PASSWORD`;
    expectSingleRule(`${key}=opaque value`, `${key}=[REDACTED]`, "credential-assignment");
  });

  it("keeps generated assignment classification and redaction differential", () => {
    const keys = ["password", "OPENAI_API_KEY", "clientSecret", "refreshToken"];
    const separators = ["=", " = ", ":", ": "];
    const values = ["opaque-value", '"opaque secret; value"', "'opaque & secret, value'"];
    for (const key of keys) {
      for (const separator of separators) {
        for (const value of values) {
          const input = `${key}${separator}${value}`;
          const first = redactWithRuleCounts(input);
          expect(first.value).not.toContain("opaque");
          expect(first.rules).toEqual([{ code: "credential-assignment", count: 1 }]);
          expect(scanSensitiveText(input)).toBe("credential-shape");
          expect(scanSensitiveText(first.value)).toBeNull();
          expect(redactWithRuleCounts(first.value)).toEqual({ value: first.value, rules: [] });
        }
      }
    }
  });

  it("keeps accepted configured literals idempotent", () => {
    for (const literal of ["tenant-alpha", "opaque-value", "[CUSTOMER]"]) {
      const first = redactWithRuleCounts(`Affected ${literal}`, [literal]);
      expect(first.value).not.toContain(literal);
      expect(first.rules).toEqual([{ code: "configured-literal", count: 1 }]);
      expect(redactWithRuleCounts(first.value, [literal])).toEqual({
        value: first.value,
        rules: [],
      });
    }
  });

  it.each([
    ['X-API-Key: "opaque secret value"', 'X-API-Key: "[REDACTED]"'],
    ["api-key: 'opaque; secret, value'", "api-key: '[REDACTED]'"],
    ['password="correct \\"horse\\" battery staple"', 'password="[REDACTED]"'],
    ["password = opaque-value; next=true", "password = [REDACTED]"],
    ["password=correct horse battery", "password=[REDACTED]"],
    ["secret=opaque, trailing public", "secret=[REDACTED]"],
    ["token=opaque & trailing", "token=[REDACTED]"],
    ['PASSWORD="correct horse"battery', 'PASSWORD="[REDACTED]"'],
    ['"password ": "opaque secret"', '"password ": "[REDACTED]"'],
    ["password[]=opaque-secret", "password[]=[REDACTED]"],
  ])("redacts a complete quoted or delimited assignment in %s", (input, expected) => {
    expectSingleRule(input, expected, "credential-assignment");
  });

  it("redacts a pretty-printed JSON credential value on the next line", () => {
    expectSingleRule(
      '"password":\n  "opaque secret"',
      '"password":\n  "[REDACTED]"',
      "credential-assignment",
    );
  });

  it("redacts a governed identifier segment inside a populated structural key path", () => {
    expectSingleRule(
      'credentials.password.value="opaque secret"',
      'credentials.password.value="[REDACTED]"',
      "credential-assignment",
    );
  });

  it("keeps populated structural key forms classifier/redactor differential", () => {
    const keys = [
      "password[0]",
      "password[primary]",
      "password.value",
      "credentials.password.value",
      "token[access]",
      "api_key[prod]",
      "password(confirm)",
    ];
    for (const key of keys) {
      expectSingleRule(`${key}="opaque secret"`, `${key}="[REDACTED]"`, "credential-assignment");
    }
  });

  it.each([
    ['"password":\n  "opaque secret"', '"password":\n  "[REDACTED]"'],
    ['"password":\r\n\t"opaque secret"', '"password":\r\n\t"[REDACTED]"'],
    ['password:\n\n  "opaque secret"', 'password:\n\n  "[REDACTED]"'],
  ])("preserves bounded JSON/YAML value whitespace in %s", (input, expected) => {
    expectSingleRule(input, expected, "credential-assignment");
  });

  it.each([
    ['password={"nested":{"value":"opaque"},"safe":1}', "password=[REDACTED]"],
    ['password=[{"value":"opaque"},1]', "password=[REDACTED]"],
    ['payload={"password":"opaque","safe":1}', 'payload={"password":"[REDACTED]","safe":1}'],
    [
      'payload=[{"password":"opaque"},{"safe":1}]',
      'payload=[{"password":"[REDACTED]"},{"safe":1}]',
    ],
  ])("redacts balanced structured credential values in %s", (input, expected) => {
    expectSingleRule(input, expected, "credential-assignment");
  });

  it.each([
    ['password={"nested":"opaque"', "password=[REDACTED]"],
    ['password={"nested":]opaque', "password=[REDACTED]"],
    ['password={"nested":"opaque"}tail', "password=[REDACTED]"],
  ])("fails closed for malformed structured credential value %s", (input, expected) => {
    expectSingleRule(input, expected, "credential-assignment");
  });

  it("fails closed when structured key or value budgets are exceeded", () => {
    const longKey = `"${"x".repeat(256)}password": "opaque"`;
    const longKeyResult = redactWithRuleCounts(longKey);
    expect(longKeyResult.value).not.toContain("opaque");
    expect(longKeyResult.rules).toEqual([{ code: "credential-assignment", count: 1 }]);
    expect(scanSensitiveText(longKeyResult.value)).toBeNull();
    expect(redactWithRuleCounts(longKeyResult.value)).toEqual({
      value: longKeyResult.value,
      rules: [],
    });
    const deepValue = `password=${"[".repeat(65)}"opaque"${"]".repeat(65)}`;
    expectSingleRule(deepValue, "password=[REDACTED]", "credential-assignment");
  });

  it("preserves token-to-authorization precedence and concrete counts", () => {
    expectSingleRule(
      "token=Bearer opaque-token",
      "token=Bearer [REDACTED]",
      "authorization-secret",
    );
    const result = redactWithRuleCounts("password=one\nsafe=two\ntoken=three");
    expect(result).toEqual({
      value: "password=[REDACTED]\nsafe=two\ntoken=[REDACTED]",
      rules: [{ code: "credential-assignment", count: 2 }],
    });
    expect(redactWithRuleCounts(result.value)).toEqual({ value: result.value, rules: [] });
  });

  it("handles a bounded separator storm linearly and still finds the final credential", () => {
    const input = `${Array.from({ length: 2_000 }, (_, index) => `field${String(index)}: safe`).join("\n")}\npassword=opaque`;
    const result = redactWithRuleCounts(input);
    expect(result.value).not.toContain("password=opaque");
    expect(result.rules).toContainEqual({ code: "credential-assignment", count: 1 });
    const sameLine = `${"field:".repeat(5_000)} password=opaque`;
    const sameLineResult = redactWithRuleCounts(sameLine);
    expect(sameLineResult.value).not.toContain("opaque");
    expect(sameLineResult.rules).toEqual([{ code: "credential-assignment", count: 1 }]);
    expect(redactWithRuleCounts(sameLineResult.value)).toEqual({
      value: sameLineResult.value,
      rules: [],
    });
  });

  it.each([
    ["escaped quote", (size: number): string => `"${'\\"'.repeat(size)}`],
    ["separator", (size: number): string => `${":".repeat(size)} password=opaque`],
    ["deep delimiter", (size: number): string => `password=${"[".repeat(size)}opaque`],
    ["unterminated value", (size: number): string => `password="${"x".repeat(size)}`],
  ])("keeps a maximum-size %s storm within a linear scaling bound", (_label, build) => {
    const small = fastestRedactionMs(build(4_000));
    const maximum = fastestRedactionMs(build(16_000));

    expect(maximum).toBeLessThan(small * 8 + 5);
  });

  it("continues after unmatched prose quotes and honors semicolon key anchors", () => {
    expectSingleRule(
      'stray " prose\npassword=opaque',
      'stray " prose\npassword=[REDACTED]',
      "credential-assignment",
    );
    expectSingleRule(
      "safe; password: opaque",
      "safe; password: [REDACTED]",
      "credential-assignment",
    );
  });

  it.each([
    ["https://password:secret@host/repo", "https://[REDACTED]@host/repo"],
    ["postgres://token:p:a@db/app", "postgres://[REDACTED]@db/app"],
  ])("preserves URL-userinfo precedence for governed username %s", (input, expected) => {
    expectSingleRule(input, expected, "url-userinfo");
  });

  it.each([
    "Password reset: follow the documented flow",
    "Visit https://example.com:443/path",
    "timestamp 12:30:00",
    "C:\\Users\\Alice\\public.txt",
    'payload={"message":"password reset guidance"}',
    'payload={"passwordReset":"safe"}',
  ])("does not overclassify benign structured text %s", (input) => {
    expect(redact(input)).toBe(input);
    expect(scanSensitiveText(input)).toBeNull();
  });

  it.each([
    "password: |\n  first secret line\n  second secret line\nnext: safe",
    "password: |\nopaque unindented secret\nnext: safe",
  ])("fully consumes a YAML block-scalar credential remainder in %s", (input) => {
    expectSingleRule(input, "password: [REDACTED]", "credential-assignment");
  });

  it("fully consumes an unterminated quoted credential instead of partially replacing it", () => {
    expectSingleRule(
      'password="unterminated secret\nstill secret',
      'password="[REDACTED]"',
      "credential-assignment",
    );
  });

  it.each([
    "tokenCount = 3",
    "Follow the password reset link.",
    "monkey=value",
    "api_key_count = 2",
    "connectionStringBuilder(config)",
  ])("does not overclassify benign key-like text %s", (input) => {
    expect(redact(input)).toBe(input);
    expect(scanSensitiveText(input)).toBeNull();
  });
});
