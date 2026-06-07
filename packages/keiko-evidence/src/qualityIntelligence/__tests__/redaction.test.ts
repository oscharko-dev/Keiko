// QI deep-redaction covers: caller-supplied literals (apiKey, baseUrl), the security-package
// built-in patterns (Bearer, sk-, gh*_), and the QI-specific deny-list (JWT shape, password=,
// token=). The output of a second pass over the redacted result is byte-identical to the first
// (idempotence).

import { describe, expect, it } from "vitest";
import { redactQualityIntelligenceEvidence } from "../redaction.js";

describe("redactQualityIntelligenceEvidence", () => {
  it("scrubs Bearer tokens, sk- keys, and JWT shapes from string leaves", () => {
    const input = {
      a: "Authorization: Bearer abcdefghijklmnop",
      b: "key=sk-AAAAAAAAAAAAAAAAAAAA",
      // A BARE JWT shape (no secret key-name prefix) so the QI-specific jwt pattern is what scrubs
      // it. (A `id_token=<jwt>` form is now caught earlier by the security package's key-name
      // redaction — strictly stronger, but it would not exercise this QI bucket.)
      c: "trace context aaaaaaaa.bbbbbbbb.cccccccc tail",
      d: "ok",
    };
    const { redacted, summary } = redactQualityIntelligenceEvidence(input);
    expect(redacted.a).not.toContain("abcdefghijklmnop");
    expect(redacted.a).toContain("[REDACTED]");
    expect(redacted.b).not.toContain("sk-AAAAA");
    expect(redacted.c).not.toContain("aaaaaaaa.bbbbbbbb.cccccccc");
    expect(redacted.d).toBe("ok");
    expect(summary.totalStringsScanned).toBe(4);
    expect(summary.stringsRedacted).toBe(3);
    expect(summary.patternsMatched["security-package"]).toBeGreaterThan(0);
    expect(summary.patternsMatched.jwt).toBeGreaterThan(0);
  });

  it("scrubs password= and token= assignments with the QI deny-list", () => {
    const input = "config: password=correcthorse; token=abcdefgh";
    const { redacted, summary } = redactQualityIntelligenceEvidence({ value: input });
    expect(redacted.value).not.toContain("correcthorse");
    expect(redacted.value).not.toContain("abcdefgh");
    expect(redacted.value).toContain("password=[REDACTED]");
    expect(redacted.value).toContain("token=[REDACTED]");
    expect(summary.patternsMatched["password-assignment"]).toBe(1);
    expect(summary.patternsMatched["token-assignment"]).toBe(1);
  });

  it("scrubs caller-supplied literal secrets", () => {
    const input = { msg: "the value is secret-customer-key-12345" };
    const { redacted } = redactQualityIntelligenceEvidence(input, {
      additionalSecrets: ["secret-customer-key-12345"],
    });
    expect(redacted.msg).not.toContain("secret-customer-key-12345");
    expect(redacted.msg).toContain("[REDACTED]");
  });

  it("recurses into nested objects and arrays", () => {
    const input = {
      level1: {
        level2: ["Bearer leaky-token-here", { key: "sk-BBBBBBBBBBBBBBBBBBBB" }],
      },
    };
    const { redacted } = redactQualityIntelligenceEvidence(input);
    const arr = redacted.level1.level2 as readonly unknown[];
    expect(arr[0]).not.toContain("leaky-token-here");
    expect((arr[1] as { key: string }).key).not.toContain("sk-BBBBB");
  });

  it("is idempotent: re-running over already-redacted text yields the same output", () => {
    const input = {
      a: "Bearer tokenABC123XYZ",
      b: "sk-CCCCCCCCCCCCCCCCCCCC",
      c: "password=changeme",
    };
    const first = redactQualityIntelligenceEvidence(input);
    const second = redactQualityIntelligenceEvidence(first.redacted);
    expect(second.redacted).toEqual(first.redacted);
    expect(second.summary.stringsRedacted).toBe(0);
  });

  it("preserves non-string scalars (numbers, booleans, null) unchanged", () => {
    const input = { n: 42, b: true, nul: null, arr: [1, 2, 3], s: "Bearer xxxxxxxxxxxxxxxxx" };
    const { redacted } = redactQualityIntelligenceEvidence(input);
    expect(redacted.n).toBe(42);
    expect(redacted.b).toBe(true);
    expect(redacted.nul).toBeNull();
    expect(redacted.arr).toEqual([1, 2, 3]);
    expect(redacted.s).not.toContain("xxxxxxxxxxxxxxxxx");
  });

  it("emits counts-only summary (never the matched secret text)", () => {
    const { summary } = redactQualityIntelligenceEvidence({
      a: "Bearer matchedSecretAbc1234567",
      b: "password=matchedPwd",
    });
    const summaryJson = JSON.stringify(summary);
    expect(summaryJson).not.toContain("matchedSecretAbc");
    expect(summaryJson).not.toContain("matchedPwd");
  });
});
