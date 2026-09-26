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

// The allowlist tables gitleaks v8.30.1 reads: the global `[[allowlists]]` and its deprecated
// single-table form `[allowlist]`, and the same two forms under a rule.
const ALLOWLIST_TABLES = new Set([
  "allowlists",
  "allowlist",
  "rules.allowlists",
  "rules.allowlist",
]);

// One TOML key: bare, "basic" or 'literal' (TOML 1.0, Keys). A quoted key is a key like any other,
// so a reader of bare keys alone let `"commits" = [...]` through unseen (CodeRabbit review).
const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')`;
const KEY_PART = new RegExp(KEY, "gu");
const HEADER = new RegExp(
  String.raw`^\s*\[\[?\s*(${KEY}(?:\s*\.\s*${KEY})*)\s*\]\]?\s*(?:#.*)?$`,
  "u",
);
const ASSIGNMENT = new RegExp(String.raw`^\s*(${KEY})\s*=\s*(.*)$`, "u");

function unquote(token) {
  if (token.startsWith('"')) return JSON.parse(token);
  if (token.startsWith("'")) return token.slice(1, -1);
  return token;
}

// A header's name with every dotted part unquoted: `[[ "rules" . allowlists ]]` is rules.allowlists.
function tableName(header) {
  return (header.match(KEY_PART) ?? []).map(unquote).join(".").toLowerCase();
}

// A TOML string value without its quotes or a trailing comment; anything else as written.
function stringValue(raw) {
  const quoted = /^("(?:[^"\\]|\\.)*"|'[^']*')/u.exec(raw.trim());
  return quoted === null ? raw.trim() : unquote(quoted[1]);
}

// Where a line leaves the reader: inside a multi-line string (its delimiter) or in plain TOML
// (null). A basic or literal string is skipped whole, and a `#` outside a string ends the line, so
// a comment or a quoted `'''` can never open a multi-line string and hide the allowlist after it
// (CodeRabbit review, PR #3452).
// Just past the multi-line string that closes at or after `i`, or -1 while it stays open. Only a
// `"""` string has escapes.
function multilineCloseIndex(line, delimiter, i) {
  let j = i;
  while (j < line.length) {
    if (delimiter === '"""' && line[j] === "\\") {
      j += 2;
    } else if (line.startsWith(delimiter, j)) {
      return j + 3;
    } else {
      j += 1;
    }
  }
  return -1;
}

// Just past the single-line string that starts at `i`: a literal one ends at the next `'`, a basic
// one at the next unescaped `"`.
function stringEndIndex(line, i) {
  if (line[i] === "'") {
    const close = line.indexOf("'", i + 1);
    return close < 0 ? line.length : close + 1;
  }
  let j = i + 1;
  while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
  return j + 1;
}

function openMultilineAfter(line, open) {
  let delimiter = open;
  let i = 0;
  while (i < line.length) {
    if (delimiter !== null) {
      const close = multilineCloseIndex(line, delimiter, i);
      if (close < 0) return delimiter;
      delimiter = null;
      i = close;
    } else if (line[i] === "#") {
      return null;
    } else if (line.startsWith("'''", i) || line.startsWith('"""', i)) {
      delimiter = line.slice(i, i + 3);
      i += 3;
    } else if (line[i] === '"' || line[i] === "'") {
      i = stringEndIndex(line, i);
    } else {
      i += 1;
    }
  }
  return delimiter;
}

// The keys of every allowlist table. A line inside a multi-line string is text, not an assignment.
function allowlistTables(text) {
  const tables = [];
  let current;
  let open = null;
  for (const line of text.split("\n")) {
    const wasInside = open !== null;
    open = openMultilineAfter(line, open);
    if (wasInside) continue;
    const header = HEADER.exec(line);
    if (header !== null) {
      current = ALLOWLIST_TABLES.has(tableName(header[1])) ? new Map() : undefined;
      if (current !== undefined) tables.push(current);
      continue;
    }
    const assignment = ASSIGNMENT.exec(line);
    if (current !== undefined && assignment !== null) {
      current.set(unquote(assignment[1]).toLowerCase(), assignment[2].trim());
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
    .map((table) => ({
      criteria: [...table.keys()].filter((key) => CRITERIA.has(key)),
      condition: table.has("condition") ? stringValue(table.get("condition")).toUpperCase() : "",
    }))
    .filter(({ criteria, condition }) => criteria.length > 1 && condition !== "AND")
    .map(({ criteria }) => criteria.join(", "));
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

  // CodeRabbit review, PR #3452: gitleaks reads quoted and indented keys, spaced or quoted table
  // headers and every allowlist table form; a check that does not is a way around it.
  it("reads quoted keys as the keys they are", () => {
    const quoted = [
      "[[allowlists]]",
      'condition = "OR"',
      '"commits" = ["0000000000000000000000000000000000000000"]',
      "'paths' = ['''fixtures/example\\.test\\.ts''']",
    ].join("\n");
    expect(orCombinedAllowlists(quoted)).toEqual(["commits, paths"]);
    expect(unknownAllowlistKeys(`${quoted}\n"matchCondition" = "AND"`)).toEqual(["matchcondition"]);
  });

  it("reads indented keys under a spaced, quoted header", () => {
    const spaced = scoped
      .replace("[[allowlists]]", '[[ "allowlists" ]]')
      .replace('condition = "AND"\n', "")
      .replace("commits =", "  commits =");
    expect(orCombinedAllowlists(spaced)).toEqual(["commits, paths"]);
  });

  it.each(["[allowlist]", "[[rules.allowlists]]", "[rules.allowlist]"])(
    "checks the %s table form as well",
    (header) => {
      const other = scoped
        .replace("[[allowlists]]", header)
        .replace('condition = "AND"', 'condition = "OR"');
      expect(orCombinedAllowlists(other)).toEqual(["commits, paths"]);
    },
  );

  // Owner review, PR #3452: a multi-line string may hold text that looks like a header or an
  // assignment. It is text: no second table, no overriding condition, no extra criterion, and the
  // real keys after its closing delimiter are read again.
  it.each(["'''", '"""'])("treats a %s multi-line string's content as text", (quote) => {
    const multiline = [
      "[[allowlists]]",
      `description = ${quote}one fixture line,`,
      "[[allowlists]]",
      'condition = "OR"',
      "stopwords = ['x']",
      quote,
      'condition = "AND"',
      'commits = ["0000000000000000000000000000000000000000"]',
      "paths = ['''fixtures/example\\.test\\.ts''']",
    ].join("\n");
    expect(allowlistTables(multiline)).toHaveLength(1);
    expect([...(allowlistTables(multiline)[0]?.keys() ?? [])]).toEqual([
      "description",
      "condition",
      "commits",
      "paths",
    ]);
    expect(unknownAllowlistKeys(multiline)).toEqual([]);
    expect(orCombinedAllowlists(multiline)).toEqual([]);
  });

  it.each([
    ["a comment line", (config) => `# """\n${config}`],
    [
      "a trailing comment",
      (config) =>
        config.replace(
          'description = "one fixture line in one commit"',
          "description = \"one fixture line in one commit\" # '''",
        ),
    ],
    [
      "a delimiter inside a string",
      (config) =>
        config.replace(
          'description = "one fixture line in one commit"',
          "description = \"a ''' in a basic string\"",
        ),
    ],
  ])("does not read %s as a multi-line string", (_label, withDelimiter) => {
    const orCombined = withDelimiter(scoped.replace('condition = "AND"', 'condition = "OR"'));
    expect(orCombinedAllowlists(orCombined)).toEqual(["commits, paths"]);
  });

  it("accepts AND in any TOML string form", () => {
    const literal = scoped.replace('condition = "AND"', "condition = 'AND' # one commit, one path");
    expect(orCombinedAllowlists(literal)).toEqual([]);
  });
});
