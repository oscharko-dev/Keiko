import { describe, expect, it } from "vitest";

import {
  createAuditRedactor,
  deepRedactStrings,
  redact,
  redactWithRuleCounts,
} from "./redaction.js";
import { scanSensitiveText } from "./sensitive-text.js";

describe("credential review regressions", () => {
  it("detects and removes a credential value after a newline separator", () => {
    const rawAtom = "opaque-secret-value";
    const input = `password=\n${rawAtom}`;
    const redacted = redactWithRuleCounts(input);

    expect(scanSensitiveText(input)).toBe("credential-shape");
    expect(redacted.value).not.toContain(rawAtom);
    expect(redacted.rules).toEqual([{ code: "credential-assignment", count: 1 }]);
    expect(scanSensitiveText(redacted.value)).toBeNull();
  });

  it("does not leak a suffix from over-budget pre-separator whitespace", () => {
    const rawAtom = "opaque-secret-value";
    const input = `password${" ".repeat(4_097)}=${rawAtom}`;
    const redacted = redactWithRuleCounts(input);

    expect(scanSensitiveText(input)).toBe("credential-shape");
    expect(redacted.value).not.toContain(rawAtom);
    expect(redacted.rules).toEqual([{ code: "credential-assignment", count: 1 }]);
    expect(scanSensitiveText(redacted.value)).toBeNull();
  });

  it.each(['"', "'"] as const)(
    "removes the complete known multiline %s-quoted assignment value",
    (quote) => {
      const rawAtom = "opaque-secret-value";
      const input = `password=${quote}\n${rawAtom}${quote}`;
      const redacted = redactWithRuleCounts(input);

      expect(scanSensitiveText(input)).toBe("credential-shape");
      expect(redacted.value).not.toContain(rawAtom);
      expect(redacted.rules).toEqual([{ code: "credential-assignment", count: 1 }]);
      expect(scanSensitiveText(redacted.value)).toBeNull();
    },
  );

  it.each([
    ["quoted Bearer", 'Safe prefix Bearer "opaque-auth-value" safe suffix'],
    ["unquoted Basic", "Safe prefix Basic opaque-auth-value safe suffix"],
    ["multiline Bearer", "Safe prefix Bearer\nopaque-auth-value safe suffix"],
    ["multiline Basic", "Safe prefix Basic\nopaque-auth-value safe suffix"],
  ])("redacts the exact %s boundary and preserves safe text", (_label, input) => {
    const redacted = redactWithRuleCounts(input);

    expect(scanSensitiveText(input)).toBe("credential-shape");
    expect(redacted.value).toContain("Safe prefix");
    expect(redacted.value).toContain("safe suffix");
    expect(redacted.value).not.toContain("opaque-auth-value");
    expect(redacted.rules).toEqual([{ code: "authorization-secret", count: 1 }]);
    expect(scanSensitiveText(redacted.value)).toBeNull();
  });

  it("uses the longest overlapping configured literal independent of caller order", () => {
    const input = "Safe prefix tenant-alpha-prod safe suffix";
    const shortFirst = redactWithRuleCounts(input, ["tenant-alpha", "tenant-alpha-prod"]);
    const longFirst = redactWithRuleCounts(input, ["tenant-alpha-prod", "tenant-alpha"]);

    expect(shortFirst).toEqual(longFirst);
    expect(shortFirst).toEqual({
      value: "Safe prefix [REDACTED] safe suffix",
      rules: [{ code: "configured-literal", count: 1 }],
    });
    expect(shortFirst.value).not.toContain("-prod");
  });

  it.each([
    ["complete embedded quote", 'Safe prefix "password=opaque-secret-value" safe suffix'],
    ["closed multiline outer quote", 'Safe prefix "password=\nopaque-secret-value" safe suffix'],
  ])("gives every classified %s a fail-safe generic redaction span", (_label, input) => {
    const rawAtom = "opaque-secret-value";
    expect(scanSensitiveText(input)).toBe("credential-shape");

    const tracked = redactWithRuleCounts(input);
    expect(tracked.value).not.toContain(rawAtom);
    expect(tracked.rules).toContainEqual({ code: "credential-assignment", count: 1 });
    expect(scanSensitiveText(tracked.value)).toBeNull();
    expect(redact(input)).not.toContain(rawAtom);
    expect(createAuditRedactor({}, {})(input)).not.toContain(rawAtom);

    const deep = deepRedactStrings({ nested: [input] }, createAuditRedactor({}, {})) as {
      readonly nested: readonly string[];
    };
    expect(deep.nested[0]).not.toContain(rawAtom);
  });
});
