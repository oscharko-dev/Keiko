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

  it("replaces opaque credential-bearing leaves with a fixed marker", () => {
    const { redacted, summary } = redactPromptEnhancementEvidence(
      { v: "value config-only-api-key here", safe: "still visible" },
      { opaqueSecrets: ["config-only-api-key"] },
    );
    expect(redacted.v).toBe("[REDACTED]");
    expect(redacted.safe).toBe("still visible");
    expect(summary.patternsMatched["opaque-secret"]).toBe(1);
  });
});
