import { describe, expect, it } from "vitest";
import { redact, redactSecretLiterals } from "./redaction.js";

describe("configured literal redaction uses original source intervals", () => {
  it.each([false, true])(
    "unions overlapping and contained secrets regardless of order (%s)",
    (reverse) => {
      const first = "private-first-overlapping-middle";
      const second = "overlapping-middle-private-second";
      const text = "private-first-overlapping-middle-private-second";
      const secrets = [first, second, "private-first"];
      if (reverse) secrets.reverse();
      expect(redactSecretLiterals("before " + text + " after", secrets)).toBe(
        "before [REDACTED] after",
      );
      expect(redact("before " + text + " after", secrets)).toBe("before [REDACTED] after");
    },
  );

  it("protects an entire configured value before a built-in pattern can consume its middle", () => {
    const secret = "private-first Bearer opaque-credential private-second";
    expect(redact("before " + secret + " after", [secret])).toBe("before [REDACTED] after");
  });

  it.each(["typescript", "java", "yaml"] as const)(
    "protects repeated private literal data in %s",
    (language) => {
      const text =
        language === "java"
          ? 'class Example { String password="private-data", label="private-data"; }'
          : language === "yaml"
            ? 'password: "private-data"\nlabel: "private-data"\n'
            : 'const password="private-data"; const label="private-data";';
      expect(redact(text, [], { sourceLanguage: language })).not.toContain("private-data");
    },
  );

  it("preserves public property-name syntax when a weak private literal has the same spelling", () => {
    const text = 'const password="label"; const shape={"label":1};';
    expect(redact(text, [], { sourceLanguage: "typescript" })).toBe(
      'const password="[REDACTED]"; const shape={"label":1};',
    );
  });
});
