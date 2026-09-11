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

const tables = allowlistTables(
  readFileSync(new URL("../../.gitleaks.toml", import.meta.url), "utf8"),
);

describe(".gitleaks.toml allowlists", () => {
  it("are found by this reader", () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it("use only keys gitleaks reads", () => {
    const unknown = tables.flatMap((table) =>
      [...table.keys()].filter((key) => !ALLOWLIST_KEYS.has(key)),
    );
    expect(unknown).toEqual([]);
  });

  it("combine several criteria with AND, never gitleaks' default OR", () => {
    for (const table of tables) {
      const criteria = [...table.keys()].filter((key) => CRITERIA.has(key));
      if (criteria.length > 1) {
        expect(table.get("condition"), `allowlist combining ${criteria.join(", ")}`).toBe('"AND"');
      }
    }
  });
});
