import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact } from "./redaction.js";

const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const end = ["-----END ", "PRIVATE KEY-----"].join("");

function projected(parts: readonly string[], secrets: readonly string[] = []): string {
  const stream = createStreamingRedactor((text) => redact(text, secrets), secrets);
  return parts.map((part) => stream.push(part)).join("") + stream.finish();
}

describe("stream redaction protects unresolved contexts", () => {
  it("withholds a head-truncated private-key body until its closing boundary", () => {
    const stream = createStreamingRedactor(redact);
    expect(stream.push("TruncatedPrivateBody\n")).toBe("");
    const output = stream.push(`${end}\n`) + stream.finish();
    expect(output).not.toContain("TruncatedPrivateBody");
    expect(output).toBe(`[REDACTED]\n`);
  });

  it("publishes unrelated complete prose while retaining the later candidate key body", () => {
    const stream = createStreamingRedactor(redact);
    expect(stream.push("Public sentence.\nTruncatedPrivateBody\n")).toBe("Public sentence.\n");
    const output = stream.push(`${end}\nPublic tail.\n`) + stream.finish();
    expect(output).not.toContain("TruncatedPrivateBody");
    expect(output).toContain("Public tail.");
  });

  it.each([
    `${begin}\nFirstPrivateBody\n${end}\nPublic sentence.\n`,
    `Public sentence.\nTruncatedPrivateBody\n${end}\nPublic tail.\n`,
    "password:\nopaque-private-value\nPublic sentence.\n",
    "```ts\nlet complete: (token: string) => void;\n```\nPublic sentence.\n",
    '```tsx\nconst token: string = "opaque-private-value";\n```\n',
  ])("retains terminal agreement for every split of %j", (text) => {
    for (let at = 1; at < text.length; at += 1) {
      const output = projected([text.slice(0, at), text.slice(at)]);
      expect(output, `split ${at.toString()}`).toBe(redact(text));
      expect(output).not.toContain("FirstPrivateBody");
      expect(output).not.toContain("TruncatedPrivateBody");
      expect(output).not.toContain("opaque-private-value");
    }
  });

  it("retains configured literals spanning completed source lines", () => {
    const secret = "first-private-part\nsecond-private-part";
    const text = `Public.\n${secret}\nPublic tail.\n`;
    for (let at = 1; at < text.length; at += 1) {
      expect(projected([text.slice(0, at), text.slice(at)], [secret])).toBe(redact(text, [secret]));
    }
  });

  it("emits complete safe blocks before the provider finishes", () => {
    const stream = createStreamingRedactor(redact);
    expect(stream.push("First complete sentence.\n")).toBe("First complete sentence.\n");
    expect(stream.push("Second complete sentence.\n")).toBe("Second complete sentence.\n");
    expect(stream.finish()).toBe("");
  });
  it("retains quoted language context at every provider fragment boundary", () => {
    const text = '> ```tsx\n> const token: string = "opaque-private-value";\n> ```\n';
    for (let at = 1; at < text.length; at += 1) {
      const output = projected([text.slice(0, at), text.slice(at)]);
      expect(output, `quoted split ${at.toString()}`).toBe(redact(text));
      expect(output).not.toContain("opaque-private-value");
    }
    expect(
      projected(Array.from({ length: text.length }, (_unused, index) => text.charAt(index))),
    ).toBe(redact(text));
  });
  it("protects head-truncated material across malformed inserted prose", () => {
    const text = `Public sentence.\nTruncatedPrivateBody\nIntervening public-looking prose!\nMorePrivateBody\n${end}\nPublic tail.\n`;
    for (let at = 1; at < text.length; at += 1) {
      const output = projected([text.slice(0, at), text.slice(at)]);
      expect(output).not.toContain("TruncatedPrivateBody");
      expect(output).not.toContain("MorePrivateBody");
      expect(output).toBe(redact(text));
    }
  });
});
