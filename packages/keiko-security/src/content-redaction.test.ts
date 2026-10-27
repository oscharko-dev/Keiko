import { afterEach, describe, expect, it, vi } from "vitest";
import { contentRedactionEnabled, redactContent } from "./content-redaction.js";
import { createAuditRedactor, createStreamingRedactor, redact } from "./redaction.js";

const CONTENT = 'Contact: +49 30 12345678\npassword: "customer-owned-example"\n';
const INFRASTRUCTURE_SECRET = "fixture-provider-credential-2026";

afterEach(() => vi.unstubAllEnvs());

describe("content policy remains separate from evidence protection", () => {
  it.each([undefined, "on", "false", "OFF", "invalid"])(
    "requires the exact deployment opt-out (%s)",
    (setting) => {
      vi.stubEnv("KEIKO_CONTENT_REDACTION", setting);
      expect(contentRedactionEnabled()).toBe(true);
      expect(redactContent(CONTENT)).toBe(redact(CONTENT));
    },
  );

  it("preserves customer content while still removing configured infrastructure secrets", () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    expect(contentRedactionEnabled()).toBe(false);
    expect(redactContent(CONTENT)).toBe(CONTENT);
    expect(redactContent(CONTENT + INFRASTRUCTURE_SECRET, [INFRASTRUCTURE_SECRET])).toBe(
      CONTENT + "[REDACTED]",
    );
    expect(redact(CONTENT)).not.toContain("customer-owned-example");
    expect(createAuditRedactor({}, {})(CONTENT)).not.toContain("+49 30 12345678");
  });

  it("retains source bytes and configured-secret protection at every stream split", () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const text = CONTENT + INFRASTRUCTURE_SECRET + "\nPublic tail.\n";
    for (let at = 0; at <= text.length; at += 1) {
      const stream = createStreamingRedactor(
        (part) => redactContent(part, [INFRASTRUCTURE_SECRET]),
        [INFRASTRUCTURE_SECRET],
      );
      const first = stream.push(text.slice(0, at));
      expect(first).not.toContain(INFRASTRUCTURE_SECRET);
      const result = first + stream.push(text.slice(at)) + stream.finish();
      expect(result).toBe(CONTENT + "[REDACTED]\nPublic tail.\n");
    }
  });

  it("protects encoded configured credentials without interpreting customer content", () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const encoded = Array.from(
      INFRASTRUCTURE_SECRET,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ).join("");
    expect(redactContent(CONTENT + encoded, [INFRASTRUCTURE_SECRET])).toBe(CONTENT + "[REDACTED]");
    expect(redactContent("Public text", ["non-ASCII-ü-value"])).toBe("Public text");
  });
});
