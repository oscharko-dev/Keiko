import { resolve } from "node:path";

import { ESLint } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";
import { describe, expect, it } from "vitest";

import { sonarNewCodeRules } from "../check-sonar-new-code.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const filePath = resolve(root, "scripts/check-mutation-quality.mjs");
const eslint = new ESLint({ cwd: root });
const uiEslint = new ESLint({
  cwd: resolve(root, "packages", "keiko-ui"),
  overrideConfigFile: resolve(root, "packages", "keiko-ui", "eslint.config.mjs"),
});
const sonarEslint = new ESLint({
  cwd: root,
  overrideConfig: [{ plugins: { sonarjs }, rules: sonarNewCodeRules }],
});

async function lint(source) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages
    .filter(
      ({ ruleId }) =>
        ruleId === "no-restricted-syntax" || ruleId?.startsWith("keiko-sonar/") === true,
    )
    .map(({ message, ruleId }) => ({ message, ruleId }));
}

describe("local Sonar compatibility preflight", () => {
  it("rejects the sort patterns that triggered Sonar S4043 and S2871", async () => {
    const messages = await lint("const sorted = values.sort();\n");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "no-restricted-syntax" }),
        expect.objectContaining({ ruleId: "keiko-sonar/require-sort-comparator" }),
      ]),
    );
  }, 45_000);

  it("rejects fractional numeric separators that trigger Sonar S7749", async () => {
    expect(await lint("const epsilon = 0.000_001;\n")).toContainEqual(
      expect.objectContaining({ ruleId: "keiko-sonar/no-fractional-numeric-separators" }),
    );
  }, 45_000);

  it("accepts non-mutating comparator sorting and scientific notation", async () => {
    expect(
      await lint(
        "const sorted = values.toSorted((left, right) => left.localeCompare(right));\n" +
          "const epsilon = 1e-6;\n",
      ),
    ).toEqual([]);
  }, 45_000);

  it("rejects ARIA list roles when native list elements provide the semantics", async () => {
    const [result] = await uiEslint.lintText(
      'export function List() { return <div role="list"><div role="listitem" /></div>; }\n',
      {
        filePath: resolve(
          root,
          "packages",
          "keiko-ui",
          "src",
          "app",
          "components",
          "desktop",
          "widgets",
          "panels",
          "SonarPreflight.tsx",
        ),
      },
    );

    expect(result.messages.map(({ ruleId }) => ruleId)).toContain("jsx-a11y/prefer-tag-over-role");
  }, 45_000);

  it("rejects inline union parameters that Sonar requires to use a named alias", async () => {
    const [result] = await sonarEslint.lintText(
      [
        "export function firstHeader(value: string | readonly string[] | undefined): string { return String(value); }",
        "export function secondHeader(value: string | readonly string[] | undefined): string { return String(value); }",
        "export function thirdHeader(value: string | readonly string[] | undefined): string { return String(value); }",
      ].join("\n"),
      {
        filePath: resolve(root, "packages", "keiko-server", "src", "update-preflight-catalog.ts"),
      },
    );

    expect(result.messages.map(({ ruleId }) => ruleId)).toContain("sonarjs/use-type-alias");
  }, 45_000);

  it("rejects duplicated functions and excessive cognitive complexity", async () => {
    const branches = Array.from(
      { length: 16 },
      (_, index) => `if (values[${String(index)}]) total += ${String(index)};`,
    ).join("\n");
    const source = [
      "export function first(value: number): number {",
      "  const next = value + 1;",
      "  const doubled = next * 2;",
      "  return doubled;",
      "}",
      "export function second(value: number): number {",
      "  const next = value + 1;",
      "  const doubled = next * 2;",
      "  return doubled;",
      "}",
      "export function complex(values: readonly boolean[]): number {",
      "  let total = 0;",
      branches,
      "  return total;",
      "}",
    ].join("\n");
    const [result] = await sonarEslint.lintText(source, {
      filePath: resolve(root, "packages", "keiko-server", "src", "update-preflight-report.ts"),
    });
    const ruleIds = result.messages.map(({ ruleId }) => ruleId);

    expect(ruleIds).toContain("sonarjs/no-identical-functions");
    expect(ruleIds).toContain("sonarjs/cognitive-complexity");
  }, 45_000);
});
