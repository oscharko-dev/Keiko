import { resolve } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const filePath = resolve(root, "scripts/check-mutation-quality.mjs");
const eslint = new ESLint({ cwd: root });

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
});
