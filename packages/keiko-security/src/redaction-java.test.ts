import { describe, expect, it } from "vitest";
import { redact } from "./redaction.js";
import { isJavaSource } from "./redaction-java.js";

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

// java-parser predicts with ALL(*) lookahead, whose work grows superlinearly on some invalid
// expressions: 400 characters of "x x=y&x=y&…" once took 21 s and 1,600 exhausted a 4 GB heap.
describe("Java parsing on hostile text", () => {
  const hostile = (count: number): string => `x ${"x=y&".repeat(count)}`;

  it("refuses within its budget instead of blocking or exhausting memory", () => {
    const started = performance.now();
    expect(() => isJavaSource(hostile(100))).toThrow(RangeError);
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it("keeps hostile text closed through the public redactor and recovers for valid Java", () => {
    const started = performance.now();
    const output = redact(`${hostile(100)} password=hunter2`, [], {
      preserveSourceLineBreaks: true,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(output).not.toContain("hunter2");
    const valid = 'class Example { String password = "private-data"; String label = "public"; }';
    expect(redact(valid, [], options)).toContain('"public"');
    expect(redact(valid, [], options)).not.toContain("private-data");
  }, 30_000);

  it("answers the same hostile text again from its last outcome without a second wait", () => {
    expect(() => isJavaSource(hostile(100))).toThrow(RangeError);
    const started = performance.now();
    expect(() => isJavaSource(hostile(100))).toThrow(RangeError);
    expect(performance.now() - started).toBeLessThan(100);
  }, 30_000);

  it("still recognises ordinary Java after a refusal", () => {
    expect(() => isJavaSource(hostile(100))).toThrow(RangeError);
    expect(isJavaSource("class Example { int value = 1; }")).toBe(true);
    expect(isJavaSource("Ich nutze Excel für Berichte.")).toBe(false);
  }, 30_000);
});
