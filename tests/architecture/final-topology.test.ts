import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath = resolve(repoRoot, ".dependency-cruiser.cjs");
const configSource = readFileSync(configPath, "utf8");
const require = createRequire(import.meta.url);
const config = require(configPath) as {
  readonly forbidden?: readonly { readonly name: string; readonly severity?: string }[];
};

const FORBIDDEN_PHRASES = [
  "legacy",
  "not-yet-extracted",
  "physically exists",
  "migration",
  "pre-extraction",
  "warn-level safety net",
];

describe("dependency-cruiser final topology", () => {
  it("contains no migration-era phrases in the architecture gate source", () => {
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(configSource.includes(phrase), `unexpected phrase in .dependency-cruiser.cjs: ${phrase}`).toBe(false);
    }
  });

  it("contains no warn-level rules", () => {
    const warnRules = (config.forbidden ?? [])
      .filter((rule) => rule.severity === "warn")
      .map((rule) => rule.name);
    expect(warnRules).toEqual([]);
  });
});
