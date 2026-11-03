import { describe, expect, it } from "vitest";
import {
  createSecretSpellingStreamRedactor,
  SecretSpellingOverflowError,
} from "./redaction-spelling.js";
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

  // PR #4064 review (4371888087): a decoder takes every digit of a numeric reference, leading zeros
  // included and with or without its semicolon, and the longest named reference of the WHATWG
  // table, case-sensitive; the legacy names also stand without their semicolon.
  it("replaces every HTML reference a browser or html.unescape turns back into it", () => {
    const value = ':/._@<fj>&"';
    const spellings = [
      "&colon;&sol;&period;&lowbar;&commat;&lt;&fjlig;&gt;&amp;&quot;",
      "&colon;&sol;&period;&UnderBar;&commat;&LT;fj&GT;&AMP;&QUOT;",
      // The legacy names without their semicolon.
      ":/._@&ltfj&gt&amp&quot",
      ":/._@&LTfj&GT&AMP&QUOT",
      // Zero-padded numeric references, decimal and hexadecimal, with and without semicolons.
      "&#0058;&#x002f;&#X2E;&#0000095&#x00040;&#60fj&#62&#038;&#x22",
      // Python's html.unescape drops a reference to a control character or a noncharacter.
      ':/&#1;._&#x7f;@<f&#xFFFE;j>&"',
    ];
    for (const spelling of spellings) {
      expect(streamed([`(${spelling})`], [value]), spelling).toBe("([REDACTED])");
    }
  });

  it("matches named references by their exact name and takes the longest", () => {
    // `&Colon;` is ∷, and `&ltcc;` is ⪦, not `<` followed by `cc;`.
    expect(streamed(["(&Colon;", "x)"], [":x"])).toBe("(&Colon;x)");
    expect(streamed(["(&ltcc;)"], ["<cc;"])).toBe("(&ltcc;)");
    expect(streamed(["(&ltcx)"], ["<cx"])).toBe("([REDACTED])");
    // A legacy name at the end of a chunk waits until the next decides what it stands for.
    const redactor = createSecretSpellingStreamRedactor(["<b"]);
    expect(redactor.push("(&lt")).toBe("(");
    expect(redactor.push("b)")).toBe("[REDACTED])");
  });

  it("follows a numeric reference's digits across chunks, however many zeros lead", () => {
    const zeros = "0".repeat(200);
    expect(streamed(["(&#", zeros, "6", "5", ";B)"], ["AB"])).toBe("([REDACTED])");
    expect(streamed(["(&#", zeros, "65", "0;B)"], ["AB"])).toBe(`(&#${zeros}650;B)`);
    expect(streamed(["(&#x", zeros, "41B)"], ["AB"])).toBe(`(&#x${zeros}41B)`);
  });

  it("never starts a spelling at a reference that stands for nothing", () => {
    const redactor = createSecretSpellingStreamRedactor(["AB"]);
    expect(redactor.push("&#1;&#1;&#1;x\n")).toBe("&#1;&#1;&#1;x\n");
    expect(redactor.push("&#1;AB")).toBe("&#1;[REDACTED]");
  });

  it("replaces a form's `+` for a space", () => {
    expect(streamed(["(open+sesame)"], ["open sesame"])).toBe("([REDACTED])");
  });

  // A spelling that stays incomplete beyond any secret's longest spelling ends the stream: the held
  // text is never published, and nothing after it either.
  it("ends a stream that holds back more than any spelling needs", () => {
    const redactor = createSecretSpellingStreamRedactor(["AB"]);
    expect(redactor.push("ok &#")).toBe("ok ");
    expect(() => redactor.push("0".repeat(300 * 1024))).toThrow(SecretSpellingOverflowError);
    expect(() => redactor.push("65;B")).toThrow(SecretSpellingOverflowError);
    expect(() => redactor.finish()).toThrow(SecretSpellingOverflowError);
  });

  it("refuses a secret that is not printable ASCII", () => {
    expect(() => createSecretSpellingStreamRedactor(["café-secret"])).toThrow(TypeError);
    expect(() => createSecretSpellingStreamRedactor(["line\nbreak"])).toThrow(TypeError);
  });

  it("passes everything through unchanged without secrets", () => {
    expect(streamed(["café ", "☕", "", "\\u0041 %41 &#65;"], [])).toBe("café ☕\\u0041 %41 &#65;");
    expect(streamed(["a", "b"], [""])).toBe("ab");
  });
});
