import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactContent } from "./content-redaction.js";
import { createStreamingRedactor, redact } from "./redaction.js";
import {
  MAX_YAML_NESTING,
  YamlDepthRefusal,
  isYamlDocument,
  yamlNestingExceeds,
} from "./redaction-yaml.js";

/** The child process runs the built output, so a stale build must fail loudly, not pass. */
function assertDistIsCurrent(): void {
  for (const name of ["redaction", "redaction-yaml", "redaction-source-map", "redaction-code"]) {
    const built = new URL(`../dist/${name}.js`, import.meta.url);
    const source = new URL(`./${name}.ts`, import.meta.url);
    if (!existsSync(built) || statSync(built).mtimeMs < statSync(source).mtimeMs)
      throw new Error(`dist/${name}.js is missing or older than src: run npm run build:packages.`);
  }
}

const SECRET = "hunter2hunter2-value";

/** `git ls-files --debug`-style stat records, spelled as YAML mapping entries. */
function statRecords(count: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `f${String(i)}.ctime: 1700000000:${String(i)}\nf${String(i)}.mtime: 1700000000:${String(i)}\n` +
      `f${String(i)}.dev: 16777230\nf${String(i)}.ino: ${String(i)}\nf${String(i)}.uid: 501\n` +
      `f${String(i)}.gid: 20\nf${String(i)}.size: ${String(i * 7)}\n`,
  ).join("");
}

function nestedMapping(depth: number): string {
  return (
    Array.from({ length: depth }, (_, i) => `${" ".repeat(i)}k${String(i)}:\n`).join("") +
    `${" ".repeat(depth)}v: 1\n`
  );
}

describe("YAML projection never exhausts the call stack", () => {
  it.each([300, 3_000])("keeps a %i-record stat listing readable", (records) => {
    const listing = statRecords(records);
    expect(redact(listing)).toBe(listing);
    expect(redactContent(listing, "redact")).toBe(listing);
  });

  it("projects a 3,000-record listing on a small stack, masking only the secret", () => {
    // A call site on a deep stack leaves little of it: `--stack-size=150` models that. The
    // projection used to spread one argument per mapping entry onto the call stack.
    assertDistIsCurrent();
    const moduleUrl = new URL("../dist/redaction.js", import.meta.url).href;
    const script = `import {readFileSync} from 'node:fs';
      const {redact}=await import(${JSON.stringify(moduleUrl)});
      const text=readFileSync(0,'utf8');
      process.stdout.write(JSON.stringify({out:redact(text)}));`;
    const listing = `${statRecords(3_000)}password: ${SECRET}\n`;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--stack-size=150", "--input-type=module", "--eval", script],
        {
          encoding: "utf8",
          input: listing,
          maxBuffer: 64 * 1024 * 1024,
          timeout: 20_000,
          killSignal: "SIGKILL",
        },
      ),
    ) as { out: string };
    expect(result.out).not.toContain(SECRET);
    expect(result.out.startsWith(statRecords(3_000).slice(0, 4_000))).toBe(true);
    expect(result.out.split("\n").filter((line) => line.includes("[REDACTED]"))).toHaveLength(1);
  });

  it("refuses 10,000 nested levels with an explicit depth outcome, never a stack overflow", () => {
    const deep = `${nestedMapping(10_000)}password: ${SECRET}\n`;
    let refusal: unknown;
    try {
      isYamlDocument(deep);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(YamlDepthRefusal);
    expect((refusal as Error).message).not.toMatch(/call stack/iu);
    expect(redact(deep)).not.toContain(SECRET);
    expect(redactContent(deep, "redact")).not.toContain(SECRET);
  });

  it("keeps the credential-floor path off the YAML projection", () => {
    const deep = `${nestedMapping(10_000)}password: ${SECRET}\n`;
    expect(redactContent(deep, "preserve")).toBe(deep);
  });

  it.each(["? ", "&anchor "])(
    "streams a %j line of 600 compact markers without throwing",
    (prefix) => {
      const text = `${prefix}${"- ".repeat(600)}x\npassword: ${SECRET}\n`;
      const stream = createStreamingRedactor(redact);
      let out = "";
      expect(() => {
        for (let i = 0; i < text.length; i += 50) out += stream.push(text.slice(i, i + 50));
        out += stream.finish();
      }).not.toThrow();
      expect(out).not.toContain(SECRET);
    },
  );

  it("measures block depth over indentation and compact markers, one level per marker", () => {
    expect(yamlNestingExceeds(nestedMapping(MAX_YAML_NESTING - 1))).toBe(false);
    expect(yamlNestingExceeds(nestedMapping(MAX_YAML_NESTING + 1))).toBe(true);
    expect(yamlNestingExceeds("- ".repeat(MAX_YAML_NESTING - 1) + "x\n")).toBe(false);
    expect(yamlNestingExceeds("- ".repeat(MAX_YAML_NESTING + 1) + "x\n")).toBe(true);
    expect(yamlNestingExceeds("a: 1\n# comment\n\n  # indented comment\nb: 2\r\n")).toBe(false);
  });
});
