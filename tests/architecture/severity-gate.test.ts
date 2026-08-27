// Severity-gate test (Issue #169 D5). Loads `.dependency-cruiser.cjs` and asserts every strict
// per-package direction variant (1, 2, 3a, 3b, 3c, 3d, 3e, 3f, 3g, 3h, 3i, 3j, 3k, 3l, 4a,
// 5a, 6a, 7a), the extracted UI/root direction rules (8, 9), the quality-intelligence leaf
// direction rule (10a), and the hard trust-boundary rules are at `severity: "error"`. This
// guards against a silent warn-only softening in a future PR — the codebase-wide memory pattern is
// to add a NEW strict variant when extracting a package, not to weaken an existing one.

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
const STRICT_DIRECTION_VARIANTS = [
  "1",
  "2",
  "2b",
  "3a",
  "3b",
  "3c",
  "3d",
  "3e",
  "3f",
  "3g",
  "3h",
  "3i",
  "3j",
  "3k",
  "3l",
  "4a",
  "5a",
  "6a",
  "7a",
  "8",
  "9",
  "10a",
];
const REQUIRED_TRUST_RULES = [
  "adr-0019-trust-1-provider-sdk-isolation",
  "adr-0019-trust-2-ui-no-provider-config",
  "adr-0019-trust-3-ui-no-gateway-internals",
  "adr-0019-trust-4-no-direct-fs-outside-workspace",
  "adr-0019-trust-5-patch-routes-through-tools",
  "adr-0019-trust-6-evidence-allowed-callers",
  "adr-0019-trust-7-cli-server-no-port-bypass",
  "adr-0019-trust-8-no-do-not-follow-in-prod",
  "adr-0165-editor-read-allowed-callers",
];

// KEIKO-0289: the two lists above are ALLOW-lists — they can only assert what someone remembered
// to enumerate. Re-deriving their own matching logic against the live config found 5 rules covered
// by neither (adr-0128-connectors, adr-0043-sandbox, adr-0019-direction-6-domain-not-server,
// adr-0019-direction-7-domain-not-cli, adr-0042-editor-not-node-domain-values); note
// `adr-0019-direction-6a-…` does NOT satisfy startsWith("adr-0019-direction-6-"), so the pairs of
// similarly-numbered rules were especially easy to miss. arch:check:negative would not have caught
// a downgrade either: it counts a rule NAME's occurrences in stdout and never reads the severity
// label, so a warn-only rule still fires, still prints, and silently stops blocking.
//
// The lists are kept — they pin that these specific boundaries EXIST, which a blanket severity
// sweep cannot do — but severity is now enforced by exhaustion below, so a rule added tomorrow is
// covered on the day it lands rather than on the day someone remembers to list it.
const EXEMPT_FROM_ERROR_SEVERITY: readonly string[] = [
  // Deliberately empty. An entry here makes a dependency-cruiser rule non-blocking, so it needs a
  // reviewed reason on the line above it and belongs in the PR description, not just here.
];

function findRulesByPrefix(prefix: string): readonly DependencyCruiserRule[] {
  const rules = config.forbidden ?? [];
  return rules.filter((rule) => rule.name === prefix || rule.name.startsWith(`${prefix}-`));
}

/**
 * Every forbidden rule must be at `severity: "error"` unless explicitly exempted. Returned as data
 * rather than asserted inline so the test below can run it against a deliberately softened config
 * and prove the check actually catches a downgrade — a check that has never been shown to fail is
 * not yet a gate.
 */
export function findSofteningViolations(
  rules: readonly DependencyCruiserRule[],
): readonly string[] {
  return rules
    .filter((rule) => !EXEMPT_FROM_ERROR_SEVERITY.includes(rule.name) && rule.severity !== "error")
    .map((rule) => `${rule.name} is at severity "${rule.severity ?? "(unset)"}"`);
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

// KEIKO-0289: exhaustive severity coverage. This is the assertion the allow-lists above could not
// make — it holds for rules nobody thought to enumerate, including ones that do not exist yet.
describe("dependency-cruiser severity gate covers every forbidden rule (KEIKO-0289)", () => {
  it("has no rule softened below error", () => {
    expect(findSofteningViolations(config.forbidden ?? [])).toEqual([]);
  });

  it("leaves no rule outside the sweep", () => {
    const swept = new Set(
      (config.forbidden ?? [])
        .filter((rule) => !EXEMPT_FROM_ERROR_SEVERITY.includes(rule.name))
        .map((rule) => rule.name),
    );
    const names = (config.forbidden ?? []).map((rule) => rule.name);
    expect(names.filter((name) => !swept.has(name))).toEqual([]);
    // Guard the guard: an empty `forbidden` array would satisfy every assertion above.
    expect(swept.size).toBeGreaterThan(30);
  });

  it("catches a downgrade on a rule neither allow-list matches", () => {
    // adr-0128-connectors-only-contracts-security is one of the five rules the prefix matching
    // missed. Softening it used to be invisible to this whole file; it must not be now.
    const softened = (config.forbidden ?? []).map((rule) =>
      rule.name === "adr-0128-connectors-only-contracts-security"
        ? { ...rule, severity: "warn" }
        : rule,
    );
    expect(findSofteningViolations(softened)).toEqual([
      'adr-0128-connectors-only-contracts-security is at severity "warn"',
    ]);
  });

  it("catches a rule that declares no severity at all", () => {
    const rules = config.forbidden ?? [];
    const first = rules[0];
    // Narrowing, not ceremony: `noUncheckedIndexedAccess` types rules[0] as possibly undefined, and
    // an empty `forbidden` array would make the assertion below vacuous anyway.
    if (first === undefined) throw new Error("config.forbidden must not be empty");
    expect(findSofteningViolations([{ name: first.name }, ...rules.slice(1)])).toEqual([
      `${first.name} is at severity "(unset)"`,
    ]);
  });
});
