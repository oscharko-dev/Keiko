// Severity-gate test (Issue #169 D5). Loads `.dependency-cruiser.cjs` and asserts every strict
// per-package direction variant (1, 2, 3a, 3b, 3c, 3d, 4a, 5a, 6a, 7a) plus the trust-1
// provider-SDK-isolation rule is at `severity: "error"`. This guards against a silent warn-only
// softening in a future PR — the codebase-wide memory pattern is to add a NEW strict variant when
// extracting a package, not to weaken an existing one, so a regression that flips an extracted
// rule back to warn is almost certainly accidental and should fail CI.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface DependencyCruiserRule {
  readonly name: string;
  readonly severity?: string;
}

interface DependencyCruiserConfig {
  readonly forbidden?: readonly DependencyCruiserRule[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath = resolve(repoRoot, ".dependency-cruiser.cjs");
const require = createRequire(import.meta.url);
const config = require(configPath) as DependencyCruiserConfig;

// The strict direction-variant rule numbers that must be at `error` severity. Each entry pins a
// physically-extracted package boundary (see ADR-0019 + ADR-0020). Adding a new package extraction
// requires adding its rule number here so a future PR cannot silently weaken the new variant to
// warn.
const STRICT_DIRECTION_VARIANTS = ["1", "2", "3a", "3b", "3c", "3d", "4a", "5a", "6a", "7a"];
const REQUIRED_TRUST_RULES = ["adr-0019-trust-1"];

function findRulesByPrefix(prefix: string): readonly DependencyCruiserRule[] {
  const rules = config.forbidden ?? [];
  return rules.filter((rule) => rule.name === prefix || rule.name.startsWith(`${prefix}-`));
}

describe("dependency-cruiser severity gate", () => {
  it("loads the config", () => {
    expect(config).toBeTruthy();
    expect(Array.isArray(config.forbidden)).toBe(true);
    expect((config.forbidden ?? []).length).toBeGreaterThan(0);
  });

  for (const variant of STRICT_DIRECTION_VARIANTS) {
    const prefix = `adr-0019-direction-${variant}`;
    it(`rule ${prefix} is present and at severity "error"`, () => {
      const matches = findRulesByPrefix(prefix);
      expect(
        matches.length,
        `expected at least one rule named ${prefix} or ${prefix}-…`,
      ).toBeGreaterThan(0);
      for (const rule of matches) {
        expect(rule.severity, `rule ${rule.name} must be at severity "error"`).toBe("error");
      }
    });
  }

  for (const name of REQUIRED_TRUST_RULES) {
    it(`rule ${name} is present and at severity "error"`, () => {
      const matches = findRulesByPrefix(name);
      expect(
        matches.length,
        `expected at least one rule named ${name} or ${name}-…`,
      ).toBeGreaterThan(0);
      for (const rule of matches) {
        expect(rule.severity, `rule ${rule.name} must be at severity "error"`).toBe("error");
      }
    });
  }
});
