import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isYamlDocument } from "./redaction-yaml.js";
import { redact } from "./redaction.js";

describe("malformed YAML block-scalar classification", () => {
  it.each([
    ["\nX", true],
    ["\r\nX", true],
    ["", true],
    ["\rX", false],
    ["\u2028X", false],
    ["\u2029X", false],
    ["\r", false],
  ] as const)("retains the existing header ending decision (%j)", (ending, expected) => {
    expect(isYamlDocument("value: [ :># comment" + ending)).toBe(expected);
  });

  it("keeps malformed private block values closed", () => {
    const input = "password: [ :># comment\n  private-first\n  private-second";
    expect(redact(input)).not.toContain("private-first");
    expect(redact(input)).not.toContain("private-second");
  });

  it("bounds repeated near-miss header work at the existing two-second child grant", () => {
    const moduleUrl = new URL("../dist/redaction.js", import.meta.url).href;
    const script = `
      const {redact} = await import(${JSON.stringify(moduleUrl)});
      const input = "value: [ " + ":>#".repeat(65_536) + "\\rX";
      process.stdout.write(JSON.stringify({unchanged:redact(input) === input}));
    `;
    const result: unknown = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
        timeout: 2_000,
        killSignal: "SIGKILL",
      }),
    );
    expect(result).toEqual({ unchanged: true });
  });
});
