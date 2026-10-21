import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact } from "./redaction.js";

describe("YAML inference work and complete private context", () => {
  it.each([
    ["plain duplicate keys", "note: public\n".repeat(1_024)],
    [
      "plain unique keys",
      Array.from({ length: 1_024 }, (_, i) => `note${String(i)}: public\n`).join(""),
    ],
    ["quoted duplicate keys", '"note": public\n'.repeat(1_024)],
    ["blank prefix before numeric prose", "\n".repeat(131_072) + "Public 1.\n"],
    ["ambiguous anchor prose", "&copy; public\n".repeat(4_096)],
  ])("bounds %s under the unchanged two-second child deadline", (_label, input) => {
    const moduleUrl = new URL("../dist/redaction.js", import.meta.url).href;
    const script = `import {readFileSync} from 'node:fs';
      const {redact}=await import(${JSON.stringify(moduleUrl)});
      const text=readFileSync(0,'utf8');
      process.stdout.write(JSON.stringify({unchanged:redact(text)===text}));`;
    const result: unknown = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
        input,
        timeout: 2_000,
        killSignal: "SIGKILL",
      }),
    );
    expect(result).toEqual({ unchanged: true });
  });

  it.each(["note: public\n", '"note": public\n'])(
    "keeps private scalar copies bound across duplicate %j rows",
    (line) => {
      const text = 'visible: "hidden-value"\n' + line.repeat(3) + 'password: "hidden-value"\n';
      expect(redact(text)).not.toContain("hidden-value");
      const stream = createStreamingRedactor(redact);
      let output = "";
      for (const part of text.split(/(?<=\n)/u)) output += stream.push(part);
      expect(output).not.toContain("hidden-value");
      output += stream.finish();
      expect(output).not.toContain("hidden-value");
    },
  );

  it("does not release a plain scalar before later private context arrives", () => {
    const text = 'visible: hidden-value\npassword: "hidden-value"\n';
    expect(redact(text)).not.toContain("hidden-value");
    const stream = createStreamingRedactor(redact);
    const first = stream.push("visible: hidden-value\n");
    expect(first).not.toContain("hidden-value");
    const second = stream.push('password: "hidden-value"\n');
    expect(first + second + stream.finish()).not.toContain("hidden-value");
  });

  it("keeps ordinary data before a typed-source transition intact", () => {
    const text = "note: public\nconst password: string = input;\n";
    expect(redact(text)).toBe(text);
  });

  it("retains strict plain fields and public prose before a later source declaration", () => {
    const text =
      "password:\nopaque-private-value\nPublic sentence.\nconst password: string = input;\n";
    const safe = redact(text);
    expect(safe).not.toContain("opaque-private-value");
    expect(safe).toContain("Public sentence.");
    expect(safe).toContain("const password: string = input;");
    expect(redact(safe)).toBe(safe);
  });

  it.each([
    'password: "private-first\nprivate-second\n',
    "password: {value: private-first, other: private-second\n",
  ])("refuses incomplete structured private values (%s)", (text) => {
    expect(redact(text)).not.toContain("private-first");
    expect(redact(text)).not.toContain("private-second");
  });

  it("keeps a canonical standalone placeholder opaque without exempting later private code", () => {
    const text = '[REDACTED]\nconst password: string = "opaque-private-value";\n';
    const safe = redact(text);
    expect(safe).toContain("const password: string");
    expect(safe).not.toContain("opaque-private-value");
    expect(redact(safe)).toBe(safe);
  });

  it("retains strict duplicate-key refusal for explicitly selected YAML", () => {
    const text = "note: public\nnote: ordinary\n";
    let refused = 0;
    redact(text, [], {
      sourceLanguage: "yaml",
      onCodeProjection: (report): void => {
        refused += report.syntaxRefusals;
      },
    });
    expect(refused).toBe(1);
  });
});
