// Pins the secret-scan allowlists to the configuration vocabulary gitleaks actually reads.
//
// gitleaks unmarshals `.gitleaks.toml` through viper without rejecting unknown keys, so a misspelt
// key is not an error: it is silently dropped. `matchCondition = "AND"` (the key is `condition`)
// did exactly that from epic #3384 until PR #3452. Every allowlist that combined a commit, a path
// and a line regex fell back to gitleaks' default OR and suppressed each criterion on its own:
// every finding in the listed commits, and every finding in the listed files in every later commit.
// The scan stayed green throughout, which is why the scan cannot be trusted to notice.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// gitleaks v8.30.1 (ci.yml GITLEAKS_VERSION) config/config.go `viperRuleAllowlist`, plus the
// global allowlist's `targetRules`. viper matches keys case-insensitively.
const ALLOWLIST_KEYS = new Set([
  "description",
  "condition",
  "commits",
  "paths",
  "regextarget",
  "regexes",
  "stopwords",
  "targetrules",
]);
const CRITERIA = new Set(["commits", "paths", "regexes", "stopwords"]);

// The keys of every `[[allowlists]]` table. Array items sit on indented lines, so only a line that
// starts with an identifier is an assignment.
function allowlistTables(text) {
  const tables = [];
  let current;
  for (const line of text.split("\n")) {
    const header = /^\[\[?([^\]]+)\]\]?\s*$/u.exec(line);
    if (header !== null) {
      current = line.startsWith("[[") && header[1] === "allowlists" ? new Map() : undefined;
      if (current !== undefined) tables.push(current);
      continue;
    }
    const assignment = /^([A-Za-z]\w*)\s*=\s*(.*)$/u.exec(line);
    if (current !== undefined && assignment !== null) {
      current.set(assignment[1].toLowerCase(), assignment[2].trim());
    }
  }
  return tables;
}

// Every key gitleaks would silently drop.
function unknownAllowlistKeys(text) {
  return allowlistTables(text).flatMap((table) =>
    [...table.keys()].filter((key) => !ALLOWLIST_KEYS.has(key)),
  );
}

// Every allowlist that combines criteria without `condition = "AND"`, named by its criteria.
function orCombinedAllowlists(text) {
  return allowlistTables(text)
    .map((table) => [...table.keys()].filter((key) => CRITERIA.has(key)))
    .filter((criteria, index) => {
      const table = allowlistTables(text)[index];
      return criteria.length > 1 && table?.get("condition") !== '"AND"';
    })
    .map((criteria) => criteria.join(", "));
}

const repositoryConfig = readFileSync(new URL("../../.gitleaks.toml", import.meta.url), "utf8");

describe(".gitleaks.toml allowlists", () => {
  it("are found by this reader", () => {
    expect(allowlistTables(repositoryConfig).length).toBeGreaterThan(0);
  });

  it("use only keys gitleaks reads", () => {
    expect(unknownAllowlistKeys(repositoryConfig)).toEqual([]);
  });

  it("combine several criteria with AND, never gitleaks' default OR", () => {
    expect(orCombinedAllowlists(repositoryConfig)).toEqual([]);
  });
});

// The checks above only prove something if they reject the regressions they exist for.
describe("the allowlist checks reject a weakened configuration", () => {
  const scoped = [
    "[[allowlists]]",
    'description = "one fixture line in one commit"',
    'condition = "AND"',
    'commits = ["0000000000000000000000000000000000000000"]',
    "paths = [",
    "  '''fixtures/example\\.test\\.ts''',",
    "]",
  ].join("\n");

  it("accepts a scoped allowlist", () => {
    expect(unknownAllowlistKeys(scoped)).toEqual([]);
    expect(orCombinedAllowlists(scoped)).toEqual([]);
  });

  it("reports the misspelt combinator gitleaks drops, and the OR it leaves behind", () => {
    const misspelt = scoped.replace('condition = "AND"', 'matchCondition = "AND"');
    expect(unknownAllowlistKeys(misspelt)).toEqual(["matchcondition"]);
    expect(orCombinedAllowlists(misspelt)).toEqual(["commits, paths"]);
  });

  it("reports combined criteria that name no combinator at all", () => {
    const missing = scoped.replace('condition = "AND"\n', "");
    expect(orCombinedAllowlists(missing)).toEqual(["commits, paths"]);
  });

  it("reports an explicit OR", () => {
    const explicitOr = scoped.replace('condition = "AND"', 'condition = "OR"');
    expect(orCombinedAllowlists(explicitOr)).toEqual(["commits, paths"]);
  });

  it("reports an unknown key anywhere in an allowlist", () => {
    expect(unknownAllowlistKeys(`${scoped}\nregexTargets = "line"`)).toEqual(["regextargets"]);
  });
});
