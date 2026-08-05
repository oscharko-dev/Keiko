import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Audit KEIKO-0118: keiko-ui sits in the root config's `ignores`, so the repo-wide complexity /
// function-length / explicit-return-type bar reached every package EXCEPT the product's largest TSX
// surface — 839 files, undocumented and total. The package config now sets those three rules
// itself, and the 1,325 pre-existing violations are held in an ESLint suppression register that can
// only shrink. Both halves are pinned here: the rules cannot be quietly dropped again, and the
// register cannot quietly grow back.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUPPRESSIONS = join(repoRoot, "packages", "keiko-ui", "eslint-suppressions.json");
const BARRED_RULES = [
  "complexity",
  "max-lines-per-function",
  "@typescript-eslint/explicit-function-return-type",
];

// The values are read from the ROOT config rather than restated here. A hand-written copy would
// pass forever if the repo-wide bar moved and keiko-ui's did not — the exact "fixture restates a
// formula the code owns" failure AGENTS.md §7 names.
//
// Selected by VALUE, not by position. Both configs define each rule more than once: the strict base
// setting, then an `"off"` in a `files`-scoped block exempting test files from
// max-lines-per-function. Taking the first or the last entry would compare an arbitrary one of
// those — and taking the last would compare `"off"` against `"off"` in both configs, which passes
// no matter how far keiko-ui's real bar drifts. The enabled setting is the one that is not "off".
function enabledSetting(config, rule) {
  return config
    .map((block) => block?.rules?.[rule])
    .find((setting) => setting !== undefined && setting !== "off");
}

async function loadConfigs() {
  return {
    root: (await import(join(repoRoot, "eslint.config.js"))).default,
    ui: (await import(join(repoRoot, "packages", "keiko-ui", "eslint.config.mjs"))).default,
  };
}

function readSuppressions() {
  return JSON.parse(readFileSync(SUPPRESSIONS, "utf8"));
}

function totalSuppressed(register) {
  return Object.values(register)
    .flatMap((byRule) => Object.values(byRule))
    .reduce((sum, entry) => sum + entry.count, 0);
}

// The recorded ceiling at the moment the bar was enabled. Lower it when suppressions are pruned;
// never raise it. Raising it means keiko-ui took on new debt against a bar it is already behind on,
// which is the state this pin exists to end.
const SUPPRESSION_CEILING = 1325;

describe("keiko-ui is held to the repository lint bar (KEIKO-0118)", () => {
  for (const rule of BARRED_RULES) {
    it(`enables ${rule} at exactly the root config's setting`, async () => {
      const { root, ui } = await loadConfigs();
      const expected = enabledSetting(root, rule);

      expect(expected, `${rule} must be enabled in the root config`).toBeDefined();
      expect(enabledSetting(ui, rule)).toEqual(expected);
    });
  }

  it("keeps keiko-ui in the root config's ignores (the package config is the only owner)", async () => {
    const { root } = await loadConfigs();
    const ignores = root.flatMap((block) => block?.ignores ?? []);

    expect(ignores).toContain("packages/keiko-ui/**");
  });
});

describe("keiko-ui suppression register (KEIKO-0118)", () => {
  it("exists and only records the three newly-barred rules", () => {
    const register = readSuppressions();
    const rules = new Set(Object.values(register).flatMap((byRule) => Object.keys(byRule)));

    expect(Object.keys(register).length).toBeGreaterThan(0);
    expect([...rules].sort()).toEqual([...BARRED_RULES].sort());
  });

  it("records no file that has since been deleted", () => {
    const missing = Object.keys(readSuppressions()).filter(
      (file) => !existsSync(join(repoRoot, "packages", "keiko-ui", file)),
    );

    expect(missing).toEqual([]);
  });

  // The ratchet. ESLint fails the lint run on its own when a suppressed file gains a violation, but
  // only against the per-file count — nothing stops the register itself from being regenerated
  // wholesale at a larger total. This is what makes the list shrink-only.
  it("does not exceed the recorded suppression ceiling", () => {
    expect(totalSuppressed(readSuppressions())).toBeLessThanOrEqual(SUPPRESSION_CEILING);
  });
});
