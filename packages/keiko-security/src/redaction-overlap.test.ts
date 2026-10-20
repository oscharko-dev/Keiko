import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact, redactSecretLiterals } from "./redaction.js";

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

describe("overlapping inferred source ownership", () => {
  const value = "fixture_value_q87";
  const cases = ["", "`", "``"].flatMap((ticks) =>
    (
      [
        [`const password: string = "${value}";`, true],
        [`{"pass\\u0077ord":"${value}"}`, true],
        ["const visible: number = 1;", false],
      ] as const
    ).map(([source, privateValue]) => ({
      ticks,
      privateValue,
      text: `Example ${ticks}label: public \n${source}\n`,
    })),
  );

  it.each(cases)("does not append an earlier raw suffix ($ticks, $privateValue)", (fixture) => {
    const safe = redact(fixture.text);
    if (fixture.privateValue) expect(safe).not.toContain(value);
    else expect(safe).toBe(fixture.text);
    expect(redact(safe)).toBe(safe);
    for (let at = 0; at <= fixture.text.length; at += 1) {
      const stream = createStreamingRedactor(redact);
      let output = stream.push(fixture.text.slice(0, at));
      if (fixture.privateValue) expect(output).not.toContain(value);
      output += stream.push(fixture.text.slice(at));
      if (fixture.privateValue) expect(output).not.toContain(value);
      output += stream.finish();
      expect(output).toBe(safe);
      if (fixture.privateValue) expect(output).not.toContain(value);
    }
  });
});
