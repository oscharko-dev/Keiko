import { describe, expect, it } from "vitest";
import { redact } from "./redaction.js";

const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const end = ["-----END ", "PRIVATE KEY-----"].join("");
const options = { preserveSourceLineBreaks: true };

describe("source-coordinate redaction", () => {
  it.each(["\n", "\r\n"])(
    "keeps independent secret spans and safe facts on their physical lines (%j)",
    (newline) => {
      const raw = [
        "preamble",
        begin,
        "first-private-body",
        end,
        "MiddleSafeFact VERIFIED_MIDDLE",
        begin,
        "second-private-body",
        end,
        "LastSafeFact VERIFIED_LAST",
      ].join(newline);
      const safe = redact(raw, [], options);
      const lines = safe.split(newline);
      expect(lines).toHaveLength(9);
      expect(lines[4]).toBe("MiddleSafeFact VERIFIED_MIDDLE");
      expect(lines[8]).toBe("LastSafeFact VERIFIED_LAST");
      expect(safe).not.toContain("first-private-body");
      expect(safe).not.toContain("second-private-body");
      expect(safe).not.toContain(begin);
      expect(safe).not.toContain(end);
    },
  );

  it("preserves the remaining source lines while masking an unterminated private-key body", () => {
    const raw = ["SafeBefore", begin, "private-body", "unfinished-body"].join("\n");
    expect(redact(raw, [], options)).toBe("SafeBefore\n[REDACTED]\n\n");
    expect(redact(raw)).toBe("SafeBefore\n[REDACTED]");
  });

  it("preserves multiline additional literal secrets without leaving their body", () => {
    const literal = "first-private-literal\r\nsecond-private-literal";
    const raw = `SafeBefore\r\n${literal}\r\nSafeAfter`;
    expect(redact(raw, [literal], options)).toBe("SafeBefore\r\n[REDACTED]\r\n\r\nSafeAfter");
    expect(redact(raw, [literal])).toBe("SafeBefore\r\n[REDACTED]\r\nSafeAfter");
  });

  it.each(["Bearer", "Basic"])(
    "retains source lines removed from %s credential whitespace",
    (scheme) => {
      const raw = `${scheme}\r\nopaque-fixture-value\nSafeAfter`;
      expect(redact(raw, [], options)).toBe(`${scheme} [REDACTED]\r\n\nSafeAfter`);
      expect(redact(raw)).toBe(`${scheme} [REDACTED]\nSafeAfter`);
    },
  );

  it.each(["x-api-key:\r\n", "api_key=\n", "password:\n"])(
    "preserves already captured assignment/header whitespace (%j)",
    (prefix) => {
      const raw = `${prefix}opaque-fixture-value\nSafeAfter`;
      const safe = redact(raw, [], options);
      expect(safe).toBe(`${prefix}[REDACTED]\nSafeAfter`);
      expect(safe).toBe(redact(raw));
    },
  );
});
