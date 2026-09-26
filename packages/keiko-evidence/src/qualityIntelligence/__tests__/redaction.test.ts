// QI deep-redaction covers: caller-supplied literals (apiKey, baseUrl), the security-package
// built-in patterns (Bearer, sk-, gh*_), and the QI-specific deny-list (JWT shape, password=,
// token=). The output of a second pass over the redacted result is byte-identical to the first
// (idempotence).

import { describe, expect, it } from "vitest";
import { redactQualityIntelligenceEvidence } from "../redaction.js";

describe("redactQualityIntelligenceEvidence", () => {
  it("scrubs Bearer tokens, sk- keys, and JWT shapes from string leaves", () => {
    const bearer = ["Bearer", " ", "abcdefghijklmnop"].join("");
    const apiKey = ["sk-", "AAAAAAAAAAAAAAAAAAAA"].join("");
    const input = {
      a: `Authorization: ${bearer}`,
      b: `key=${apiKey}`,
      // A BARE JWT shape (no secret key-name prefix) so the QI-specific jwt pattern is what scrubs
      // it. (A `id_token=<jwt>` form is now caught earlier by the security package's key-name
      // redaction — strictly stronger, but it would not exercise this QI bucket.)
      c: "trace context aaaaaaaa.bbbbbbbb.cccccccc tail",
      d: "ok",
    };
    const { redacted, summary } = redactQualityIntelligenceEvidence(input);
    expect(redacted.a).not.toContain("abcdefghijklmnop");
    expect(redacted.a).toContain("[REDACTED]");
    expect(redacted.b).not.toContain(apiKey.slice(0, 8));
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
    const bearer = ["Bearer", " ", "leaky-token-here"].join("");
    const apiKey = ["sk-", "BBBBBBBBBBBBBBBBBBBB"].join("");
    const input = {
      level1: {
        level2: [bearer, { key: apiKey }],
      },
    };
    const { redacted } = redactQualityIntelligenceEvidence(input);
    const arr = redacted.level1.level2 as readonly unknown[];
    expect(arr[0]).not.toContain("leaky-token-here");
    expect((arr[1] as { key: string }).key).not.toContain(apiKey.slice(0, 8));
  });

  it("is idempotent: re-running over already-redacted text yields the same output", () => {
    const bearer = ["Bearer", " ", "tokenABC123XYZ"].join("");
    const apiKey = ["sk-", "CCCCCCCCCCCCCCCCCCCC"].join("");
    const input = {
      a: bearer,
      b: apiKey,
      c: "password=changeme",
    };
    const first = redactQualityIntelligenceEvidence(input);
    const second = redactQualityIntelligenceEvidence(first.redacted);
    expect(second.redacted).toEqual(first.redacted);
    expect(second.summary.stringsRedacted).toBe(0);
  });

  it("preserves non-string scalars (numbers, booleans, null) unchanged", () => {
    const input = {
      n: 42,
      b: true,
      nul: null,
      arr: [1, 2, 3],
      s: ["Bearer", " ", "xxxxxxxxxxxxxxxxx"].join(""),
    };
    const { redacted } = redactQualityIntelligenceEvidence(input);
    expect(redacted.n).toBe(42);
    expect(redacted.b).toBe(true);
    expect(redacted.nul).toBeNull();
    expect(redacted.arr).toEqual([1, 2, 3]);
    expect(redacted.s).not.toContain("xxxxxxxxxxxxxxxxx");
  });

  it("emits counts-only summary (never the matched secret text)", () => {
    const bearer = ["Bearer", " ", "matchedSecretAbc1234567"].join("");
    const { summary } = redactQualityIntelligenceEvidence({
      a: bearer,
      b: "password=matchedPwd",
    });
    const summaryJson = JSON.stringify(summary);
    expect(summaryJson).not.toContain("matchedSecretAbc");
    expect(summaryJson).not.toContain("matchedPwd");
  });

  // KEIKO-0778 sibling: this deepRedact used to have no depth ceiling or cycle guard, so a
  // self-referential or deeply-nested QI evidence payload (Figma frame -> children arrays can
  // recurse) would crash the process with an uncaught "RangeError: Maximum call stack size
  // exceeded" instead of failing closed. Guards mirror the promptEnhancement/redaction.ts sibling
  // (commit 52fc7a01) so a re-inlined copy in either place still throws a controlled
  // EvidenceWriteError with a "QI evidence payload contains a circular reference" / "exceeds the
  // maximum redaction depth" message rather than tearing down the process.
  it("throws a controlled error instead of overflowing the stack on a circular object reference", () => {
    const o: Record<string, unknown> = { a: "ok" };
    o.self = o;
    expect(() => redactQualityIntelligenceEvidence(o)).toThrow(/circular/i);
  });

  it("throws a controlled error instead of overflowing the stack on a circular array reference", () => {
    const a: unknown[] = ["ok"];
    a.push(a);
    expect(() => redactQualityIntelligenceEvidence({ list: a })).toThrow(/circular/i);
  });

  it("throws a controlled error on a payload that exceeds the recursion depth ceiling", () => {
    // Build a plain-tree (no cycle) chain 40 deep -- deeper than MAX_REDACT_DEPTH (32).
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) {
      deep = { child: deep };
    }
    expect(() => redactQualityIntelligenceEvidence({ root: deep })).toThrow(/depth/i);
  });

  // KEIKO-0188: the deep-redactor rebuilds objects field-by-field, so a JSON.parse'd input
  // carrying a `__proto__` key silently reassigned the reconstructed object's prototype when the
  // rebuild seed was a plain `{}`. Seeding with Object.create(null) keeps the key as data.
  it("does not let a __proto__ key in the input pollute the rebuilt prototype", () => {
    const rawJson = `{"a":"ok","__proto__":{"polluted":"ghp_${"x".repeat(30)}"}}`;
    const input = JSON.parse(rawJson) as { readonly a: string };
    const { redacted } = redactQualityIntelligenceEvidence(input);
    expect((redacted as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(redacted.a).toBe("ok");
  });
});
