import { describe, expect, it } from "vitest";
import { createSecretSpellingStreamRedactor } from "./redaction-spelling.js";
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

// PR #4064 review (#3903 AC3): an MCP relay streams a server's response, and a credential the server
// echoes can arrive split anywhere across its chunks, and escaped any way JSON, a URL or HTML allows.
describe("createSecretSpellingStreamRedactor", () => {
  const secret = "Bearer static-secret-canary";
  const text = `{"text":"got ${secret}; ok"}\n`;

  function streamed(chunks: readonly string[], secrets: readonly string[]): string {
    const redactor = createSecretSpellingStreamRedactor(secrets);
    return chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.finish();
  }

  function unicodeEscaped(value: string): string {
    return Array.from(
      value,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ).join("");
  }

  it("replaces a secret split at every position across two chunks", () => {
    for (let cut = 0; cut <= text.length; cut += 1) {
      expect(streamed([text.slice(0, cut), text.slice(cut)], [secret]), String(cut)).toBe(
        '{"text":"got [REDACTED]; ok"}\n',
      );
    }
  });

  it("replaces a secret arriving one character per chunk, and counts it once", () => {
    const redactor = createSecretSpellingStreamRedactor([secret, "static-secret-canary"]);
    let published = "";
    for (let index = 0; index < text.length; index += 1)
      published += redactor.push(text.charAt(index));
    expect(published + redactor.finish()).toBe('{"text":"got [REDACTED]; ok"}\n');
    expect(redactor.redactedCount()).toBe(1);
  });

  it("replaces every spelling a JSON parser, a URL decoder or a browser turns back into it", () => {
    const value = 'ab/cd"ef\\gh&<1>';
    const escaped = JSON.stringify(value).slice(1, -1);
    const spellings = [
      value,
      escaped,
      escaped.replaceAll("/", "\\/"),
      JSON.stringify(escaped).slice(1, -1),
      unicodeEscaped(value),
      unicodeEscaped(value).toUpperCase().replaceAll("\\U", "\\u"),
      JSON.stringify(unicodeEscaped(value)).slice(1, -1),
      encodeURIComponent(value),
      Array.from(value, (character) => `&#${String(character.charCodeAt(0))};`).join(""),
      Array.from(value, (character) => `&#x${character.charCodeAt(0).toString(16)};`).join(""),
      "ab/cd&quot;ef\\gh&amp;&lt;1&gt;",
      // Any mix of the above, one character at a time.
      String.raw`a\u0062%2fc&#100;\"ef\\gh&amp;<1&#x3e;`,
    ];
    for (const spelling of spellings) {
      expect(JSON.stringify(streamed([`<${spelling}>`], [value])), spelling).toBe(
        JSON.stringify("<[REDACTED]>"),
      );
    }
    // A parsed JSON string really is the secret, so the spelling above is the disclosure it guards.
    expect(JSON.parse(`"${unicodeEscaped(value)}"`)).toBe(value);
  });

  it("replaces an escaped secret split at every position", () => {
    const escaped = `{"text":"${unicodeEscaped(secret)}"}`;
    for (let cut = 0; cut <= escaped.length; cut += 1) {
      expect(streamed([escaped.slice(0, cut), escaped.slice(cut)], [secret]), String(cut)).toBe(
        '{"text":"[REDACTED]"}',
      );
    }
  });

  it("holds back only what may still spell a secret, and never a line break", () => {
    const redactor = createSecretSpellingStreamRedactor([secret]);
    expect(redactor.push("event: message\ndata: Bear")).toBe("event: message\ndata: ");
    expect(redactor.push("ings\n\n")).toBe("Bearings\n\n");
    expect(redactor.push("data: 100% \\u0041 &amp;\n\n")).toBe("data: 100% \\u0041 &amp;\n\n");
    expect(redactor.push("data: \\u004")).toBe("data: ");
    expect(redactor.push("2\n\n")).toBe("\\u0042\n\n");
    expect(redactor.finish()).toBe("");
    expect(redactor.redactedCount()).toBe(0);
  });

  it("publishes a whole secret the held tail would otherwise cut", () => {
    expect(streamed(["xab", "a", "y"], ["aba"])).toBe("x[REDACTED]y");
    expect(streamed(["x", "abaab", "a"], ["aba"])).toBe("x[REDACTED][REDACTED]");
  });

  it("passes everything through unchanged without secrets", () => {
    expect(streamed(["café ", "☕", "", "\\u0041 %41 &#65;"], [])).toBe("café ☕\\u0041 %41 &#65;");
    expect(streamed(["a", "b"], [""])).toBe("ab");
  });
});
