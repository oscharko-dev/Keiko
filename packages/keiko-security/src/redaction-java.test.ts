import { describe, expect, it } from "vitest";
import { redact } from "./redaction.js";

const options = { sourceLanguage: "java" as const, preserveSourceLineBreaks: true };

describe("Java redaction uses the initializer's syntax ownership", () => {
  it.each(["password", "pa\u200cssword"])(
    "keeps an invalid bare private assignment unavailable (%s)",
    (name) => {
      expect(redact(`${name} += 918273;`, [], options)).not.toContain("918273");
    },
  );

  it("retains a public malformed fragment without literal or sensitive-name ambiguity", () => {
    const input = "@Broken(!) class Example {}";
    expect(redact(input, [], options)).toBe(input);
  });

  it.each(["password", "pa\u200cssword"])(
    "keeps malformed private numeric assignments closed (%s)",
    (name) => {
      const input = `@Broken(!) class Example { int ${name} = 918273; }`;
      expect(redact(input, [], options)).not.toContain("918273");
    },
  );

  it("keeps a configured literal closed in an otherwise public malformed fragment", () => {
    const input = "@Broken(!) class Example { int quota = 918273; }";
    expect(redact(input, ["918273"], options)).not.toContain("918273");
  });

  it.each([
    [
      "annotation member",
      '@Config(password="private-data", label="public-data") class Example {}',
      'label="public-data"',
    ],
    [
      "declarator",
      'class Example { String password="private-data", label="public-data"; }',
      'label="public-data"',
    ],
    [
      "assignment in a call",
      'class Example { void run(){ accept(password="private-data", "public-data"); } }',
      '"public-data"',
    ],
  ])("protects a private %s without changing its public sibling", (_kind, input, publicData) => {
    const output = redact(input, [], options);
    expect(output).not.toContain("private-data");
    expect(output).toContain(publicData);
  });

  it("retains a public argument that computes a private result", () => {
    const input = 'class Example { String password = derive("public-data"); }';
    expect(redact(input, [], options)).toBe(input);
  });

  it("protects configured text-block values after incidental indentation is removed", () => {
    const input = [
      'class Example { String label = """',
      "    private-first",
      "    private-second",
      '    """; }',
    ].join("\n");
    const output = redact(input, ["private-first\nprivate-second"], options);
    expect(output).not.toContain("private-first");
    expect(output).not.toContain("private-second");
    expect(output.split("\n")).toHaveLength(input.split("\n").length);
  });
});
