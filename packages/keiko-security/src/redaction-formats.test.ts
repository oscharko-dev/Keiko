import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact } from "./redaction.js";

describe("source formats retain syntax at the shared redaction boundary", () => {
  it.each([
    'password=@"private-first""private-second";',
    'password=@"private-first\nprivate-second";',
    'password=$@"private-first\nprivate-second";',
    'password="""private-first\nprivate-second""";',
    "password='''private-first\nprivate-second''';",
    'namespace Public { string password=@"private-first""private-second"; }',
  ])(
    "keeps unsupported quoted credential data closed in plain text and streaming (%s)",
    (input) => {
      const output = redact(input);
      expect(output).not.toContain("private-first");
      expect(output).not.toContain("private-second");
      const stream = createStreamingRedactor(redact);
      expect(
        Array.from(input, (character) => stream.push(character)).join("") + stream.finish(),
      ).toBe(output);
    },
  );

  it.each(["\n", "\r\n"])(
    "recognizes a bare program before Markdown splits its multiline template (%j)",
    (newline) => {
      const input = "const password = `private-first" + newline + "private-second`;";
      const expected = "const password = `[REDACTED]" + newline + "`;";
      expect(redact(input)).toBe(expected);
      const stream = createStreamingRedactor(redact);
      expect(
        Array.from(input, (character) => stream.push(character)).join("") + stream.finish(),
      ).toBe(expected);
    },
  );

  it.each(["password: private-value", "token: private-value"])(
    "keeps a canonical plain-text placeholder stable across repeated masking (%s)",
    (input) => {
      const output = redact(input);
      expect(output).not.toContain("private-value");
      expect(redact(output)).toBe(output);
    },
  );

  it("immediately publishes a complete harmless prose line", () => {
    const stream = createStreamingRedactor(redact);
    expect(stream.push("PUBLIC safe first.\n")).toBe("PUBLIC safe first.\n");
  });

  it("retains a mapping-shaped line until later private bindings are known", () => {
    const stream = createStreamingRedactor(redact);
    expect(stream.push("PUBLIC: safe first.\n")).toBe("");
    const output = stream.push('password: "safe first."\n') + stream.finish();
    expect(output).not.toContain("safe first.");
  });
  it.each([
    ['const password: string = "private-first private-second', "ts"],
    ["const token: string = `private-first\nprivate-second", "ts"],
    ['class Example { String password = """\nprivate-first\nprivate-second', "java"],
  ])("refuses exposed literal tails in malformed source (%s)", (source, language) => {
    for (const text of [source, "```\n" + source, "```" + language + "\n" + source]) {
      const output = redact(text);
      expect(output).not.toContain("private-first");
      expect(output).not.toContain("private-second");
      const stream = createStreamingRedactor(redact);
      expect(
        Array.from(text, (character) => stream.push(character)).join("") + stream.finish(),
      ).toBe(output);
    }
  });
  it.each([false, true])(
    "applies final YAML alias sensitivity independently of entry order (%s)",
    (reverse) => {
      const aliases = ["password: *shared", "public: *shared"];
      if (reverse) aliases.reverse();
      const input = ['source: &shared "Bearer private-first private-second"', ...aliases].join(
        "\n",
      );
      const output = redact(input);
      expect(output).not.toContain("private-first");
      expect(output).not.toContain("private-second");
    },
  );
  it.each([
    "function complete(\n token: string\n): string { return token; }",
    "class Example { String token; String get() { return client.reserve(); } }",
  ])("retains quoted unlabelled source (%s)", (source) => {
    const quoted = ["```", ...source.split("\n"), "```"].map((line) => "> " + line).join("\n");
    expect(redact(quoted)).toBe(quoted);
    const stream = createStreamingRedactor(redact);
    expect(
      Array.from(quoted, (character) => stream.push(character)).join("") + stream.finish(),
    ).toBe(quoted);
  });
  it.each([
    "let complete: (token: string) => void;",
    "interface Input { readonly token: string; }",
    "function complete(\n  token: string\n): string { return token; }",
    "class Example { String token; String reserve() { return client.reserve(); } }",
    "Public sentence.\n\nlet complete: (token: string) => void;\n\nAnother sentence.",
  ])("retains public bare and unlabelled source (%s)", (source) => {
    expect(redact(source)).toBe(source);
    expect(redact("```\n" + source + "\n```")).toBe("```\n" + source + "\n```");
    const stream = createStreamingRedactor(redact);
    const output =
      Array.from({ length: source.length }, (_, index) => stream.push(source.charAt(index))).join(
        "",
      ) + stream.finish();
    expect(output).toBe(source);
  });

  it.each([
    'const password = """private-first private-second""";',
    'const password = "private-first\nprivate-second";',
  ])("refuses private literal syntax whose lexical error detaches its data (%s)", (source) => {
    for (const output of [
      redact(source, [], { sourceLanguage: "typescript" }),
      redact("```ts\n" + source + "\n```"),
    ]) {
      expect(output).not.toContain("private-first");
      expect(output).not.toContain("private-second");
    }
  });

  it.each([
    '{"password":"private-\\"-tail", "public":"kept"}',
    '{"pass\\u0077ord":"private-escaped-key", "public":"kept"}',
  ])("retains valid JSON while masking decoded credential values (%s)", (input) => {
    const original: unknown = JSON.parse(input);
    expect(original).toBeTypeOf("object");
    const output = redact(input);
    expect(output).not.toContain("private-");
    expect(JSON.parse(output)).toEqual({ password: "[REDACTED]", public: "kept" });
    const stream = createStreamingRedactor(redact);
    expect(
      Array.from(input, (character) => stream.push(character)).join("") + stream.finish(),
    ).toBe(output);
  });

  it("masks an entire quoted plain-text value including escaped quote tails and spaces", () => {
    expect(redact('password="private-\\"-tail with spaces" public=kept')).toBe(
      'password="[REDACTED]" public=kept',
    );
  });

  it.each([
    "password: 'private-first''private-second'\npublic: kept\n",
    "password: |-\n  private-first\n  private-second\npublic: kept\n",
    "password: >-\n  private-first\n  private-second\npublic: kept\n",
    "spring.datasource.password: |-\n  private-first\n  private-second\npublic: kept\n",
    "password: private-first\n  private-second\npublic: kept\n",
    'password:\n  first: "private-first"\n  second: "private-second"\npublic: kept\n',
    '---\r\npassword: "private-first"\r\npublic: kept\r\n',
  ])("protects complete YAML values (%s)", (input) => {
    const output = redact(input);
    expect(output).not.toContain("private-first");
    expect(output).not.toContain("private-second");
    expect(output).toContain("public: kept");
    expect(redact("```yaml\n" + input + "```")).not.toContain("private-first");
    const stream = createStreamingRedactor(redact);
    expect(
      Array.from(input, (character) => stream.push(character)).join("") + stream.finish(),
    ).toBe(output);
  });

  it.each([
    "password: private-value",
    "token: private-value",
    "Authorization: Bearer private-value",
    "export PASSWORD=private-value",
    "The class explains password=private-value and safe prose.",
  ])("retains strict plain-text credential protection (%s)", (input) => {
    expect(redact(input)).not.toContain("private-value");
  });
});
