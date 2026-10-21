import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact } from "./redaction.js";

const privateValue = ["synthetic", "json", "58291"].join("-");
const object = `{"pass\\u0077ord":"${privateValue}"}`;

describe("inferred JSON scalar boundaries", () => {
  it.each(["true", "false", "null", "0", "-1", "1.25e2", '"public"'])(
    "retains native JSON ownership after a malformed %s prefix",
    (prefix) => {
      for (const separator of [", ", " ", ",\n", ",\r\n"]) {
        const text = `${prefix}${separator}${object}`;
        expect(redact(text)).not.toContain(privateValue);
        const stream = createStreamingRedactor(redact);
        let safe = "";
        for (const character of text) safe += stream.push(character);
        safe += stream.finish();
        expect(safe).toBe(redact(text));
      }
    },
  );

  it.each([
    "1. Public requirement.\n",
    "true story about public facts.\n",
    '"Public quotation" explains the requirement.\n',
    "-1 is a public number.\n",
    "1, password fields are ordinary metadata.\n",
    '"Public quotation", password fields remain metadata.\n',
    "1, do not share password values.\n",
  ])("preserves ordinary scalar-shaped prose", (text) => {
    expect(redact(text)).toBe(text);
  });
});
