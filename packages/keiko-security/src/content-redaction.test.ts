import { describe, expect, it } from "vitest";
import { redactContent, resolveContentRedactionPolicy } from "./content-redaction.js";
import {
  createAuditRedactor,
  createStreamingRedactor,
  redact,
  redactCredentialShapes,
} from "./redaction.js";

const CONTENT = [
  "Contact: +49 30 12345678",
  "Account: DE89 3704 0044 0532 0130 00",
  'password: "customer-owned-example"',
  "```python",
  "from mcp.server.models import InitializationOptions",
  "```",
  "",
].join("\n");
const INFRASTRUCTURE_SECRET = "fixture-provider-credential-2026";

describe("deployment content policy resolution", () => {
  it.each([
    [undefined, "redact", "default"],
    ["", "redact", "default"],
    ["on", "redact", "on"],
    ["off", "preserve", "off"],
    ["OFF", "redact", "invalid"],
    ["false", "redact", "invalid"],
    ["0", "redact", "invalid"],
    [" off", "redact", "invalid"],
  ] as const)("resolves %j to %s (%s)", (value, policy, setting) => {
    expect(resolveContentRedactionPolicy({ KEIKO_CONTENT_REDACTION: value })).toEqual({
      policy,
      setting,
    });
  });
});

describe("content policy remains separate from evidence protection", () => {
  it("keeps the default projection byte for byte", () => {
    expect(redactContent(CONTENT, "redact")).toBe(redact(CONTENT));
    expect(redactContent(CONTENT, "redact")).not.toContain("+49 30 12345678");
  });

  it("preserves customer content while still removing configured infrastructure secrets", () => {
    expect(redactContent(CONTENT, "preserve")).toBe(CONTENT);
    expect(
      redactContent(CONTENT + INFRASTRUCTURE_SECRET, "preserve", [INFRASTRUCTURE_SECRET]),
    ).toBe(CONTENT + "[REDACTED]");
    expect(redact(CONTENT)).not.toContain("customer-owned-example");
    expect(createAuditRedactor({}, {})(CONTENT)).not.toContain("+49 30 12345678");
  });

  it("does not scrub configured literals too short to be a plausible secret", () => {
    expect(redactContent("abc and abcd", "preserve", ["abc", "abcd"])).toBe("abc and [REDACTED]");
  });

  it("retains source bytes and configured-secret protection at every stream split", () => {
    const text = CONTENT + INFRASTRUCTURE_SECRET + "\nPublic tail.\n";
    for (let at = 0; at <= text.length; at += 1) {
      const stream = createStreamingRedactor(
        (part) => redactContent(part, "preserve", [INFRASTRUCTURE_SECRET]),
        [INFRASTRUCTURE_SECRET],
      );
      const first = stream.push(text.slice(0, at));
      expect(first).not.toContain(INFRASTRUCTURE_SECRET);
      const result = first + stream.push(text.slice(at)) + stream.finish();
      expect(result).toBe(CONTENT + "[REDACTED]\nPublic tail.\n");
    }
  });

  it("protects encoded configured credentials without interpreting customer content", () => {
    const encoded = Array.from(
      INFRASTRUCTURE_SECRET,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ).join("");
    expect(redactContent(CONTENT + encoded, "preserve", [INFRASTRUCTURE_SECRET])).toBe(
      CONTENT + "[REDACTED]",
    );
    expect(redactContent("Public text", "preserve", ["non-ASCII-ü-value"])).toBe("Public text");
  });
});

describe("credential floor of preserved content", () => {
  // Synthetic fixtures, split so no credential-shaped literal is contiguous in the source.
  const PRIVATE_KEY = [
    "-----BEGIN RSA " + "PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
    "-----END RSA " + "PRIVATE KEY-----",
  ].join("\n");

  it.each([
    ["an OpenAI-style key", "key sk-proj-AbCdEfGhIjKlMnOpQrSt1234"],
    ["a GitHub token", "token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    ["an AWS access key", "id AKIAIOSFODNN7EXAMPLE"],
    ["a Slack token", "slack xoxb-1234567890-abcdefghij"],
    ["a Google API key", "maps AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStU"],
    ["a Stripe key", "pay sk_live_" + "AbCdEfGhIjKlMnOp1234"],
    ["URL credentials", "db https://admin:hunter22@db.example.test/app"],
    ["a token used as URL user", "clone https://ghtoken123456@git.example.test/o/r.git"],
    ["a bearer credential", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl"],
    ["a basic credential", "Authorization: Basic dXNlcjpwYXNzd29yZA=="],
    ["a short basic credential", "Authorization: Basic cm9vdDp0b29y"],
    ["a letters-only header value", '"authorization": "Bearer abcdefghijklmnop"'],
    ["a proxy header value", "Proxy-Authorization: Token abcd"],
    ["a short bearer value", "use Bearer abc123def456 for staging"],
    ["a private key block", PRIVATE_KEY],
  ])("removes %s", (_label, text) => {
    const preserved = redactContent(text, "preserve");
    expect(preserved).toContain("[REDACTED]");
    expect(preserved).toBe(redactCredentialShapes(text));
  });

  it("keeps the values a document question needs", () => {
    const text = [
      "Bearer authentication is configured per tenant.",
      "Basic configurationoptions apply to every node.",
      "ssh://git@git.example.test/team/repo.git",
      "IBAN DE89 3704 0044 0532 0130 00, phone 030 12345678",
      "api_token = local-development-value",
      "const password = readConfig('db');",
    ].join("\n");
    expect(redactContent(text, "preserve")).toBe(text);
  });

  it("keeps physical line coordinates when the caller asks for them", () => {
    const text = `line1\n${PRIVATE_KEY}\nline6\nline7`;
    const preserved = redactContent(text, "preserve", [], { preserveSourceLineBreaks: true });
    expect(preserved.split("\n")).toHaveLength(text.split("\n").length);
    expect(preserved.split("\n")[4]).toBe("line6");
    expect(preserved).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("removes the whole private key block, the same way the default projection does", () => {
    expect(redactContent(PRIVATE_KEY, "preserve")).toBe(redact(PRIVATE_KEY));
    expect(redactContent(`before\n${PRIVATE_KEY}\nafter`, "preserve")).toBe(
      "before\n[REDACTED]\nafter",
    );
  });
});
