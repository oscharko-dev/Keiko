// Tests for the Prompt Enhancement redaction wrapper (Issue #1313).

import { describe, expect, it } from "vitest";
import { redactPromptEnhancementEvidence } from "../redaction.js";

const SECRET = "sk-abcdefghij1234567890";

describe("redactPromptEnhancementEvidence", () => {
  it("redacts secret material in nested structures and preserves shape", () => {
    const { redacted } = redactPromptEnhancementEvidence({
      a: `key ${SECRET}`,
      nested: { rules: [`leak ${SECRET}`, "safe rule"], count: 2, flag: true, none: null },
    });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted.nested.count).toBe(2);
    expect(redacted.nested.flag).toBe(true);
    expect(redacted.nested.none).toBeNull();
    expect(redacted.nested.rules[1]).toBe("safe rule");
  });

  it("reports counts-only summary without the matched text", () => {
    const { summary } = redactPromptEnhancementEvidence({
      one: `a ${SECRET}`,
      two: "clean",
      three: `b ${SECRET}`,
    });
    expect(summary.totalStringsScanned).toBe(3);
    expect(summary.stringsRedacted).toBe(2);
    expect(summary.patternsMatched["security-package"]).toBe(2);
  });

  it("is idempotent: re-redacting its own output changes nothing", () => {
    const first = redactPromptEnhancementEvidence({ v: `x ${SECRET}` }).redacted;
    const second = redactPromptEnhancementEvidence(first).redacted;
    expect(second).toEqual(first);
  });

  it("scrubs caller-supplied literal secrets", () => {
    const { redacted } = redactPromptEnhancementEvidence(
      { v: "value super-secret-literal here" },
      { additionalSecrets: ["super-secret-literal"] },
    );
    expect(redacted.v).not.toContain("super-secret-literal");
  });

  it("replaces every string leaf with a fixed marker when full redaction is requested", () => {
    const { redacted, summary } = redactPromptEnhancementEvidence(
      { v: "value config-only-api-key here", safe: "still hidden", count: 2 },
      { redactAllStrings: true },
    );
    expect(redacted.v).toBe("[REDACTED]");
    expect(redacted.safe).toBe("[REDACTED]");
    expect(redacted.count).toBe(2);
    expect(summary.patternsMatched["opaque-secret"]).toBe(2);
  });

  // KEIKO-0188: the deep-redactor rebuilds objects field-by-field, so a JSON.parse'd input
  // carrying a `__proto__` key silently reassigned the reconstructed object's prototype when the
  // rebuild seed was a plain `{}`. Seeding with Object.create(null) keeps the key as data.
  it("does not let a __proto__ key in the input pollute the rebuilt prototype", () => {
    const rawJson = `{"a":"ok","__proto__":{"polluted":"ghp_${"x".repeat(30)}"}}`;
    const input = JSON.parse(rawJson) as { readonly a: string };
    const { redacted } = redactPromptEnhancementEvidence(input);
    expect((redacted as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(redacted.a).toBe("ok");
  });
});
