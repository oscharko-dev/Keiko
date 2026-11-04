import { describe, expect, it } from "vitest";
import { compileJiraTemplatePattern, jiraTemplatePatternIssue } from "./jira-template-pattern.js";

function elapsed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("the template pattern engine is not backtracking", () => {
  // Each of these took tens of seconds, or never finished, as a RegExp on 255 characters.
  const hostile: readonly (readonly [string, string])[] = [
    ["^.*.*.*.*!", "a".repeat(255)],
    [`${"(a|aa)".repeat(28)}!`, "a".repeat(255)],
    [`${"a?".repeat(40)}${"a".repeat(40)}!`, "a".repeat(40)],
    [
      "^(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)c",
      "ab".repeat(120),
    ],
    ["a{0,600}a{0,600}a{0,600}!", "a".repeat(255)],
  ];

  it.each(hostile)("matches %s on adversarial text in milliseconds", (pattern, text) => {
    expect(jiraTemplatePatternIssue(pattern)).toBeUndefined();
    const matcher = compileJiraTemplatePattern(pattern);
    let result = true;
    const duration = elapsed(() => {
      result = matcher.test(text);
    });
    expect(result).toBe(false);
    expect(duration).toBeLessThan(500);
  });

  it("bounds the program, so a repeated repeat cannot allocate without limit", () => {
    expect(jiraTemplatePatternIssue("(ab){999}(cd){999}(ef){999}(gh){999}(ij){999}")).toBe(
      "pattern structure",
    );
  });
});

describe("assertions cannot be quantified, so every accepted pattern is matchable", () => {
  it.each([String.raw`\b*`, String.raw`\B+`, String.raw`\b{2}`, "^+", "$?", String.raw`a\b*`])(
    "refuses %s (new RegExp would throw on it)",
    (pattern) => {
      expect(jiraTemplatePatternIssue(pattern)).toBeDefined();
      expect(() => compileJiraTemplatePattern(pattern)).toThrow(TypeError);
    },
  );

  it.each([
    String.raw`\p{L}`,
    String.raw`\1`,
    String.raw`\k<a>`,
    String.raw`\x4`,
    String.raw`\u12`,
    String.raw`\c`,
    String.raw`[\b]`,
    String.raw`[a-\d]`,
    "(?<n>a)",
    "(?!a)",
    "(?<=a)",
    "a{2}{3}",
    "a*??",
  ])("refuses the construct %s outside the closed grammar", (pattern) => {
    expect(jiraTemplatePatternIssue(pattern)).toBeDefined();
  });
});

describe("a brace quantifier is never read as literal text (review)", () => {
  const range = "^REQ-[0-9]{1,1000}$";

  it("compiles a count above three digits, with the meaning RegExp gives it", () => {
    expect(jiraTemplatePatternIssue(range)).toBeUndefined();
    const matcher = compileJiraTemplatePattern(range);
    const native = new RegExp(range, "u");
    for (const text of ["REQ-123", "REQ-1{1,1000}", "REQ-", "REQ-" + "9".repeat(1000)]) {
      expect(matcher.test(text), text).toBe(native.test(text));
    }
    expect(matcher.test("REQ-123")).toBe(true);
    expect(matcher.test("REQ-1{1,1000}")).toBe(false);
  });

  it("honours open and exact counts of any width", () => {
    expect(compileJiraTemplatePattern("^a{1000,}$").test("a".repeat(1000))).toBe(true);
    expect(compileJiraTemplatePattern("^a{1000,}$").test("a".repeat(999))).toBe(false);
    expect(compileJiraTemplatePattern("^a{0010}$").test("a".repeat(10))).toBe(true);
  });

  it.each(["a{5000}", "a{1,5000}", "a{99999999999999999999}", "a{5000,}", "^[0-9]{1,100000}$"])(
    "refuses the count beyond the program bound in %s instead of matching its text",
    (pattern) => {
      expect(jiraTemplatePatternIssue(pattern)).toBeDefined();
      expect(() => compileJiraTemplatePattern(pattern)).toThrow(TypeError);
    },
  );

  it("keeps a brace that is not a quantifier literal, as RegExp does without the u flag", () => {
    expect(compileJiraTemplatePattern("x{a}").test("x{a}")).toBe(true);
    expect(compileJiraTemplatePattern("a{,3}").test("a{,3}")).toBe(true);
  });
});

describe("characters are code points", () => {
  it("treats an astral character as one character, for a dot and for a literal", () => {
    expect(compileJiraTemplatePattern("^.$").test("\u{1F600}")).toBe(true);
    expect(compileJiraTemplatePattern("^\u{1F600}+$").test("\u{1F600}\u{1F600}")).toBe(true);
    expect(compileJiraTemplatePattern("^[\u{1F600}-\u{1F64F}]$").test("\u{1F610}")).toBe(true);
    expect(compileJiraTemplatePattern("^.{2}$").test("\u{1F600}")).toBe(false);
  });
});

describe("the automaton agrees with RegExp on the closed grammar", () => {
  const patterns = [
    "^[A-Z][a-z ]+$",
    String.raw`^\d{3}-\w+$`,
    "colou?r",
    "^(?:foo|bar)baz$",
    "^(ab)+$",
    "a{2,3}",
    "a{2,}",
    "^a.c$",
    String.raw`\bcat\b`,
    String.raw`\Bat`,
    "[^a-c]+x",
    "[a\\-z]",
    "^[\\d_-]+$",
    String.raw`\s+end$`,
    "x*",
    "^$",
    String.raw`^[\w.-]+@[\w.-]+$`,
    "a|b|c",
    "^(?:[A-Z]+-\\d+)$",
    "[]",
    "[^]",
    String.raw`\x41B\t`,
    "a.*?b",
    "{literal}",
    "a{,3}",
  ];
  const inputs = [
    "",
    "Add login",
    "add login",
    "123-abc",
    "color",
    "colour",
    "foobaz",
    "ababab",
    "aa",
    "aaaa",
    "abc",
    "a\nc",
    "a cat sat",
    "concat",
    "xyzx",
    "a-z",
    "a_1-2",
    "word   end",
    "me@host.example",
    "PROJ-12 fix it",
    "AB\t",
    "a{,3}",
    "{literal}",
    "café",
  ];

  it.each(patterns)("%s", (pattern) => {
    const matcher = compileJiraTemplatePattern(pattern);
    const reference = new RegExp(pattern);
    for (const input of inputs) {
      expect(matcher.test(input), `${pattern} on ${JSON.stringify(input)}`).toBe(
        reference.test(input),
      );
    }
  });
});
