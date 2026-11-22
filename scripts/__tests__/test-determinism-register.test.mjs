import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { testDeterminismPlugin } from "../lib/eslint-test-determinism.mjs";

// Quality-gate hardening plan 2026-11-21, P3. The three test-determinism rules apply to every test
// file the root config lints, and the occurrences that predate them are held in a register that may
// only shrink. Both halves are pinned here: the rules cannot be quietly switched off, and the
// register cannot quietly grow back (the same ratchet as the keiko-ui lint bar, KEIKO-0118).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTER = join(repoRoot, "eslint-suppressions.json");
const PREFIX = "keiko-test-determinism/";
const RULES = Object.keys(testDeterminismPlugin.rules).map((rule) => `${PREFIX}${rule}`);

// The ceilings recorded when the rules were enabled, after six digest-prone assertions were
// repaired instead of registered. Lower a ceiling when the register is pruned; never raise it.
const CEILINGS = {
  "keiko-test-determinism/no-fixed-sleep": 75,
  "keiko-test-determinism/no-unguarded-wall-clock-assertion": 204,
  "keiko-test-determinism/no-short-hex-negative-substring": 13,
};

function readRegister() {
  return JSON.parse(readFileSync(REGISTER, "utf8"));
}

function countsByRule(register) {
  const totals = {};
  for (const byRule of Object.values(register)) {
    for (const [rule, { count }] of Object.entries(byRule)) {
      if (!Number.isInteger(count) || count < 0) {
        throw new TypeError(`register needs a non-negative-integer count, got ${String(count)}`);
      }
      totals[rule] = (totals[rule] ?? 0) + count;
    }
  }
  return totals;
}

describe("test-determinism rules in the root ESLint config", () => {
  it.each([
    "packages/keiko-server/src/deps.test.ts",
    "scripts/__tests__/report-ci-health.test.mjs",
    "tests/e2e/chat-send.spec.ts",
  ])("enables every rule at error for %s", async (file) => {
    const eslint = new ESLint({ cwd: repoRoot });
    const config = await eslint.calculateConfigForFile(join(repoRoot, file));
    for (const rule of RULES) expect(config.rules[rule]?.[0], rule).toBe(2);
  });

  it("does not apply the rules to product code", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const config = await eslint.calculateConfigForFile(
      join(repoRoot, "packages/keiko-server/src/deps.ts"),
    );
    for (const rule of RULES) expect(config.rules[rule], rule).toBeUndefined();
  });
});

describe("test-determinism register", () => {
  it("records only the three rules, and only test files that still exist", () => {
    const register = readRegister();
    const rules = new Set(Object.values(register).flatMap((byRule) => Object.keys(byRule)));
    expect(Object.keys(register).length).toBeGreaterThan(0);
    expect([...rules].filter((rule) => !RULES.includes(rule))).toEqual([]);
    const files = Object.keys(register);
    expect(files.filter((file) => !/\.(test|spec)\.(ts|tsx|mjs)$/u.test(file))).toEqual([]);
    expect(files.filter((file) => !existsSync(join(repoRoot, file)))).toEqual([]);
  });

  // ESLint fails a lint run on its own when a registered file gains an occurrence, but only against
  // that file's count; nothing stops the register from being regenerated at a larger total. This
  // is what makes it shrink-only.
  it("does not exceed the recorded ceiling of any rule", () => {
    const totals = countsByRule(readRegister());
    for (const rule of RULES) expect(totals[rule] ?? 0, rule).toBeLessThanOrEqual(CEILINGS[rule]);
  });

  it.each([[-1], [1.5], ["3"], [undefined]])("rejects a count of %p", (count) => {
    expect(() => countsByRule({ "a.test.ts": { [RULES[0]]: { count } } })).toThrow(TypeError);
  });
});
