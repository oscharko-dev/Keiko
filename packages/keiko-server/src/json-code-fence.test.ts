import { describe, expect, it } from "vitest";
import { stripJsonCodeFence } from "./json-code-fence.js";

describe("model JSON fence projection", () => {
  it.each([
    ['{"ok":true}', '{"ok":true}'],
    ['```json\r\n{"ok":true}\r\n```', '{"ok":true}'],
    ['```\n{"value":"```nested```"}\n```', '{"value":"```nested```"}'],
  ])("preserves the complete JSON body in %s", (raw, expected) => {
    expect(stripJsonCodeFence(raw)).toBe(expected);
    const actualValue: unknown = JSON.parse(stripJsonCodeFence(raw));
    const expectedValue: unknown = JSON.parse(expected);
    expect(actualValue).toEqual(expectedValue);
  });

  it.each(["```json\n{}\n```\n```json\n{}\n```", "Leading prose\n```json\n{}\n```", "```json\n{}"])(
    "does not turn multiple, prefixed or unterminated fences into valid JSON: %s",
    (raw) => {
      expect(() => {
        JSON.parse(stripJsonCodeFence(raw));
      }).toThrow(SyntaxError);
    },
  );

  it("handles a large wrapping body without changing the JSON", () => {
    const whitespace = " ".repeat(500_000);
    expect(stripJsonCodeFence(`\`\`\`json${whitespace}{}${whitespace}\`\`\``)).toBe("{}");
  });
});
