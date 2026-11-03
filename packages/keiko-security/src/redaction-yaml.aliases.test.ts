import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact } from "./redaction.js";

describe("YAML alias resolution and private key ownership", () => {
  it("bounds a shallow alias sequence under the unchanged two-second child deadline", () => {
    const moduleUrl = new URL("../dist/redaction.js", import.meta.url).href;
    const input = "base: &shared public\nrefs:\n" + "  - *shared\n".repeat(16_384);
    const script = `import {readFileSync} from 'node:fs';
      const {redact}=await import(${JSON.stringify(moduleUrl)});
      const text=readFileSync(0,'utf8');
      process.stdout.write(JSON.stringify({unchanged:redact(text)===text}));`;
    const result: unknown = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        input,
        encoding: "utf8",
        timeout: 2_000,
        killSignal: "SIGKILL",
      }),
    );
    expect(result).toEqual({ unchanged: true });
  });

  it.each(["password", "token", '"pass\\u0077ord"'])(
    "protects values owned by the scalar alias key %s across source and stream projections",
    (name) => {
      const source = `field: &field ${name}\n*field : opaque-private-value\n`;
      for (const text of [source, "```yaml\n" + source + "```\n", "```\n" + source + "```\n"]) {
        expect(redact(text)).not.toContain("opaque-private-value");
        const stream = createStreamingRedactor(redact);
        let output = "";
        for (const part of text) output += stream.push(part);
        expect(output + stream.finish()).not.toContain("opaque-private-value");
      }
      expect(redact(source, [], { sourceLanguage: "yaml" })).not.toContain("opaque-private-value");
    },
  );

  it.each([
    "first: &field password\n*field : opaque-private-value\nsecond: &field note\n*field : public-value\n",
    "first: &field note\n*field : public-value\nsecond: &field password\n*field : opaque-private-value\n",
  ])("uses the nearest preceding key anchor without masking a later public binding", (text) => {
    const safe = redact(text, [], { sourceLanguage: "yaml" });
    expect(safe).not.toContain("opaque-private-value");
    expect(safe).toContain("public-value");
    expect(redact(safe, [], { sourceLanguage: "yaml" })).toBe(safe);
  });

  it.each([
    ["alias-key container", "field: &field password\n*field :\n  nested: opaque-private-value\n"],
    ["anchored first key", "&field password: public-value\n*field : opaque-private-value\n"],
    [
      "private self-reference",
      "node: &self\n  self: *self\n  value: opaque-private-value\npassword: *self\n",
    ],
  ])("protects a %s without expanding the graph", (_label, text) => {
    expect(redact(text)).not.toContain("opaque-private-value");
  });

  it("does not resolve a declared YAML alias to a future anchor", () => {
    const text = "*later : opaque-private-value\nfield: &later password\n";
    let refused = 0;
    const safe = redact(text, [], {
      sourceLanguage: "yaml",
      onCodeProjection: (report): void => {
        refused += report.syntaxRefusals;
      },
    });
    expect(safe).not.toContain("opaque-private-value");
    expect(refused).toBe(1);
  });

  it.each([
    ["&copy; public prose", "\n"],
    ["&copy; public prose", "\r\n"],
    ["&named public scalar", "\n"],
    ["&named public scalar", "\r\n"],
  ])("preserves Markdown after an ambiguous anchored scalar (%s, %j)", (prefix, ending) => {
    const text = [
      prefix,
      "",
      "```ts",
      'const password: string = "opaque-private-value";',
      "```",
      "",
    ].join(ending);
    const safe = redact(text);
    expect(safe).toContain(prefix);
    expect(safe).toContain("```ts" + ending + "const password: string");
    expect(safe).not.toContain("opaque-private-value");
    for (let split = 0; split <= text.length; split += 1) {
      const stream = createStreamingRedactor(redact);
      expect(
        stream.push(text.slice(0, split)) + stream.push(text.slice(split)) + stream.finish(),
      ).toBe(safe);
    }
  });
});
