import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PATH_DENY_PATTERNS,
  ENV_EXAMPLE_BASENAME,
  TOOL_STATE_PATH_DENY_PATTERNS,
} from "@oscharko-dev/keiko-contracts/sensitive-path-patterns";
import { CREDENTIAL_PATH_SEATBELT_RULE } from "./seatbelt-credential-paths.js";

// The Seatbelt regex dialect used here is a strict subset of JavaScript's, so the generated
// arguments can be exercised directly. Real kernel behaviour is proven in runtime-gateway.test.ts.
function ruleRegexes(): { readonly plain: RegExp[]; readonly exemptable: RegExp[] } {
  const denies = CREDENTIAL_PATH_SEATBELT_RULE.split("(deny file-read* file-write* ").slice(1);
  const compile = (rule: string): RegExp[] =>
    [...rule.matchAll(/\(regex ((?:"[^"]*" ?)+)\)/gu)]
      .flatMap((match) => [...(match[1] ?? "").matchAll(/"([^"]*)"/gu)])
      .map((argument) => new RegExp(argument[1] ?? "", "u"));
  return { plain: compile(denies[0] ?? ""), exemptable: compile(denies[1] ?? "") };
}

function sampleName(pattern: string): string {
  return pattern.replaceAll("*", "x");
}

describe("native credential path rule", () => {
  const { plain, exemptable } = ruleRegexes();
  const denied = (path: string): boolean => [...plain, ...exemptable].some((r) => r.test(path));

  it("keeps every Seatbelt string literal below the 1,023 character limit", () => {
    for (const literal of CREDENTIAL_PATH_SEATBELT_RULE.matchAll(/"([^"]*)"/gu))
      expect((literal[1] ?? "").length).toBeLessThan(1_023);
    expect(plain.length + exemptable.length).toBeGreaterThan(1);
  });

  it.each(CREDENTIAL_PATH_DENY_PATTERNS.filter((pattern) => pattern !== ".env.*"))(
    "denies %s as a file, as a directory prefix and in any letter case",
    (pattern) => {
      const name = sampleName(pattern);
      expect(denied(`/work/ws/${name}`)).toBe(true);
      expect(denied(`/work/ws/${name}/child.txt`)).toBe(true);
      expect(denied(`/work/ws/nested/${name.toUpperCase()}`)).toBe(true);
      expect(denied(`/work/ws/not${name}`)).toBe(pattern.startsWith("*"));
    },
  );

  it("denies .env.* except the documented .env.example leaf", () => {
    const envPattern = exemptable;
    expect(envPattern.some((r) => r.test("/work/ws/.env.local"))).toBe(true);
    expect(envPattern.some((r) => r.test(`/work/ws/${ENV_EXAMPLE_BASENAME}`))).toBe(true);
    const exempt = new RegExp(
      /\(require-not \(regex "([^"]*)"\)\)/u.exec(CREDENTIAL_PATH_SEATBELT_RULE)?.[1] ?? "(?!)",
      "u",
    );
    expect(exempt.test(`/work/ws/${ENV_EXAMPLE_BASENAME}`)).toBe(true);
    expect(exempt.test("/work/ws/.env.local")).toBe(false);
    // A child of an `.env.example` directory is not the exempt leaf, and a denied directory above
    // the exempt name still denies it through its own pattern.
    expect(exempt.test(`/work/ws/${ENV_EXAMPLE_BASENAME}/secret`)).toBe(false);
    expect(denied("/work/ws/.ssh/.env.example")).toBe(true);
  });

  it("never denies the tool state the toolchain itself needs", () => {
    for (const pattern of TOOL_STATE_PATH_DENY_PATTERNS)
      expect(denied(`/work/ws/${sampleName(pattern)}/file`)).toBe(false);
    expect(denied("/work/ws/src/app.js")).toBe(false);
  });
});
