import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact, REDACTION_PLACEHOLDER } from "./redaction.js";

const privateValue = ["synthetic", "credential", "482917"].join("-");
const labels = [
  "**Password:**",
  "**Password**:",
  "*Password:*",
  "__Password__:",
  "**_Password:_**",
  "**_Password_**:",
  "__*Password:*__",
];

describe("Markdown credential labels", () => {
  it.each(labels)("redacts the value after %s through the shared boundary", (label) => {
    for (const prefix of ["", "- ", "> ", "> - "]) {
      const text = `${prefix}${label} ${privateValue}\nPublic explanation.\n`;
      const safe = redact(text);
      expect(safe).not.toContain(privateValue);
      expect(safe).toContain(REDACTION_PLACEHOLDER);
      expect(safe).toContain("Public explanation.");
      expect(redact(safe)).toBe(safe);
    }
  });

  it.each(labels)("retains unresolved %s context across every stream split", (label) => {
    const text = `${label}\n${privateValue}\nPublic explanation.\n`;
    for (let split = 0; split <= text.length; split += 1) {
      const stream = createStreamingRedactor(redact);
      const first = stream.push(text.slice(0, split));
      const second = stream.push(text.slice(split));
      const safe = first + second + stream.finish();
      expect(safe).not.toContain(privateValue);
      expect(safe).toBe(redact(text));
    }
  });

  it.each(["**Note:**", "**Step1:**", "**Step 1:**", "*Note:*", "__Note:__"])(
    "publishes a completed public %s line before stream completion",
    (label) => {
      const text = `${label} Public progress.\n`;
      const stream = createStreamingRedactor(redact);
      expect(redact(text)).toBe(text);
      expect(stream.push(text)).toBe(text);
      expect(stream.finish()).toBe("");
    },
  );

  it("keeps public label progress and a following encoded private object consistent", () => {
    const prefix = "**Note:** Public progress.\n";
    const text = prefix + `{"pass\\u0077ord":"${privateValue}"}`;
    const safe = redact(text);
    const stream = createStreamingRedactor(redact);
    const first = stream.push(prefix);
    expect(first).toBe(prefix);
    expect(first + stream.push(text.slice(prefix.length)) + stream.finish()).toBe(safe);
    expect(safe).toContain(prefix);
    expect(safe).not.toContain(privateValue);
  });
});
