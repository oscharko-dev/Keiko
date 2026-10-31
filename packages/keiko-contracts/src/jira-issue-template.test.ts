import { describe, expect, it } from "vitest";
import {
  compileJiraTemplatePattern,
  describeJiraTemplateParseErrors,
  isJiraIssueTemplateDocument,
  jiraIssueTemplateLabel,
  jiraTemplatePatternIssue,
  normalizeJiraSectionHeading,
  parseJiraIssueTemplate,
} from "./jira-issue-template.js";

function template(frontMatter: readonly string[], body = "# Story\n\n## Context\nWhy.\n"): string {
  return ["---", ...frontMatter, "---", body].join("\n");
}
const MINIMAL = ["keiko: jira-issue-template", "version: 1", "project: abc", "issueType: Story"];
const VALID = [...MINIMAL, "activateOn: [create]"];

function failure(markdown: string): readonly { code: string; key?: string; line?: number }[] {
  const result = parseJiraIssueTemplate(markdown);
  if (result.ok) throw new Error("expected a parse failure");
  return result.errors;
}

describe("parseJiraIssueTemplate", () => {
  it("parses a full template with every rule type", () => {
    const result = parseJiraIssueTemplate(
      template(
        [
          ...MINIMAL,
          "# a comment line",
          'activateOn: [create, edit, transition:In Progress, "transition:Ready for dev"]',
          "summaryMinLength: 10",
          "summaryMaxLength: 120",
          "summaryPattern: ^[A-Z].*",
          "requiredFields:",
          "  - Story Points",
          '  - "Epic Link"',
          "requiredLabels: [backend, reviewed]",
          "labelPattern: ^[a-z-]+$",
          "minLabels: 2",
          "parentField: Epic Link",
          "parentLink: is child of",
          "optionalSections: [Notes]",
        ],
        "# Story template\n\n## Context\ntext\n## Acceptance criteria\n- x\n## Notes\n",
      ),
    );
    expect(result).toEqual({
      ok: true,
      template: {
        project: "ABC",
        issueType: "Story",
        activations: [
          { kind: "create" },
          { kind: "edit" },
          { kind: "transition", target: "In Progress" },
          { kind: "transition", target: "Ready for dev" },
        ],
        summary: { minLength: 10, maxLength: 120, pattern: "^[A-Z].*" },
        requiredFields: ["Story Points", "Epic Link"],
        requiredSections: ["Context", "Acceptance criteria"],
        labels: {
          required: ["backend", "reviewed"],
          pattern: "^[a-z-]+$",
          minCount: 2,
        },
        parent: { field: "Epic Link", link: "is child of" },
      },
    });
  });

  it("derives sections from H2 headings and ignores fenced code and other levels", () => {
    const result = parseJiraIssueTemplate(
      template(VALID, "# Title\n### Deep\n## One\n```\n## Not a section\n```\n## ONE\n## Two ##\n"),
    );
    expect(result.ok && result.template.requiredSections).toEqual(["One", "Two"]);
  });

  it("accepts a template whose only rule is a description section", () => {
    expect(parseJiraIssueTemplate(template(VALID, "## Goal\n")).ok).toBe(true);
  });

  it("normalises Windows line endings", () => {
    expect(parseJiraIssueTemplate(template(VALID).replace(/\n/gu, "\r\n")).ok).toBe(true);
  });

  it("reports a document without front matter as not a template", () => {
    expect(failure("# Plain skill\n\ntext")).toEqual([{ code: "not-a-template" }]);
    expect(failure("---\nname: other\n---\nbody")).toEqual([{ code: "not-a-template" }]);
  });

  it("rejects an unterminated front matter", () => {
    expect(failure("---\nkeiko: jira-issue-template\nproject: ABC")).toEqual([
      { code: "front-matter-unterminated" },
    ]);
  });

  it("rejects unknown and duplicate keys", () => {
    const errors = failure(template([...VALID, "colour: red", "project: XYZ"]));
    expect(errors).toContainEqual({ code: "unknown-key", key: "colour", line: 7 });
    expect(errors).toContainEqual({ code: "duplicate-key", key: "project", line: 8 });
  });

  it("rejects malformed lines", () => {
    const errors = failure(
      template([...VALID, "just words", "summaryMinLength: 5", "- orphan item"]),
    );
    expect(errors.map((error) => error.code)).toEqual(["malformed-line", "malformed-line"]);
  });

  it("requires the identifying keys", () => {
    const errors = failure(template(["keiko: jira-issue-template"], "## Goal\n"));
    expect(
      errors.filter((error) => error.code === "missing-key").map((error) => error.key),
    ).toEqual(["version", "project", "issueType", "activateOn"]);
  });

  it.each([
    ["version: 2", "version"],
    ["project: 12", "project"],
    ["project: A-B", "project"],
    ["summaryMinLength: 0", "summaryMinLength"],
    ["summaryMinLength: 999", "summaryMinLength"],
    ["summaryMinLength: ten", "summaryMinLength"],
    ["minLabels: 51", "minLabels"],
    ["activateOn: [launch]", "activateOn"],
    ["activateOn: []", "activateOn"],
    ["activateOn: [transition:]", "activateOn"],
    ["requiredFields: Story Points", "requiredFields"],
    ["requiredFields: [a, b", "requiredFields"],
    ['requiredFields: ["a, b]', "requiredFields"],
    ["parentField:", "parentField"],
    ['issueType: "unterminated', "issueType"],
  ])("rejects an invalid value: %s", (line, key) => {
    const base = VALID.filter((entry) => !entry.startsWith(`${key}:`));
    const errors = failure(template([...base, line]));
    expect(errors.some((error) => error.key === key)).toBe(true);
  });

  it("rejects a minimum above the maximum", () => {
    const errors = failure(template([...VALID, "summaryMinLength: 20", "summaryMaxLength: 10"]));
    expect(errors).toContainEqual(expect.objectContaining({ key: "summaryMaxLength" }));
  });

  it("rejects an unsafe or invalid pattern", () => {
    expect(failure(template([...VALID, "summaryPattern: ^(a+)+$"]))).toContainEqual(
      expect.objectContaining({ code: "unsafe-pattern", key: "summaryPattern" }),
    );
    expect(failure(template([...VALID, `labelPattern: ${"a".repeat(201)}`]))).toContainEqual(
      expect.objectContaining({ code: "invalid-value", key: "labelPattern" }),
    );
  });

  it("bounds list sizes", () => {
    const items = Array.from({ length: 51 }, (_, index) => `f${String(index)}`).join(", ");
    expect(failure(template([...VALID, `requiredFields: [${items}]`]))).toContainEqual(
      expect.objectContaining({ code: "limit-exceeded", key: "requiredFields" }),
    );
    const sections = Array.from({ length: 51 }, (_, index) => `## S${String(index)}`).join("\n");
    expect(failure(template(VALID, sections))).toContainEqual({ code: "limit-exceeded" });
  });

  it("rejects a template that states no rule", () => {
    expect(failure(template(VALID, "# Only a title\n"))).toEqual([{ code: "no-rules" }]);
  });

  it("bounds the number of reported errors", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `k${String(index)}: x`);
    expect(failure(template(lines)).length).toBeLessThanOrEqual(20);
  });

  it("describes errors with closed codes only", () => {
    expect(
      describeJiraTemplateParseErrors([
        { code: "unknown-key", key: "colour", line: 6 },
        { code: "no-rules" },
      ]),
    ).toBe("unknown-key (colour) at line 6; no-rules");
  });
});

describe("template identification", () => {
  it("detects the marker with or without quotes and while malformed", () => {
    expect(isJiraIssueTemplateDocument(template(VALID))).toBe(true);
    expect(isJiraIssueTemplateDocument(template(['keiko: "jira-issue-template"']))).toBe(true);
    expect(isJiraIssueTemplateDocument("---\nkeiko: jira-issue-template\nno end")).toBe(true);
  });

  it("does not detect it in ordinary skills or in the body", () => {
    expect(isJiraIssueTemplateDocument("# Skill\nkeiko: jira-issue-template")).toBe(false);
    expect(isJiraIssueTemplateDocument("---\nname: x\n---\nkeiko: jira-issue-template")).toBe(
      false,
    );
  });

  it("labels a template and normalises headings", () => {
    expect(jiraIssueTemplateLabel({ project: "ABC", issueType: "Bug" })).toBe("ABC/Bug");
    expect(normalizeJiraSectionHeading("  **Acceptance   Criteria**: ")).toBe(
      "acceptance criteria",
    );
  });
});

describe("the template pattern grammar", () => {
  it.each([
    "^[A-Z].*",
    "^[a-z-]+$",
    "(ab)+",
    "a{1,3}b",
    "a+?b",
    "^(?:foo|bar)$",
    String.raw`\d{3}-\w+`,
    "[a-z0-9_]+",
    String.raw`\[x\]`,
    "a|b",
    "{literal}",
  ])("accepts %s and a pattern it accepts always compiles", (pattern) => {
    expect(jiraTemplatePatternIssue(pattern)).toBeUndefined();
    expect(() => compileJiraTemplatePattern(pattern)).not.toThrow();
  });

  it.each([
    "",
    "*a",
    "a**",
    "^*",
    "|*",
    "a+?+",
    "(a+)+",
    "(a|b)*",
    "((a+)b)+",
    "(?=a)",
    "(?<name>a)",
    String.raw`(a)\1`,
    "[z-a]",
    "a{3,1}",
    "(",
    ")",
    "[abc",
    "a\\",
    "a".repeat(201),
  ])("refuses %j", (pattern) => {
    expect(jiraTemplatePatternIssue(pattern)).toBeDefined();
    expect(() => compileJiraTemplatePattern(pattern)).toThrow(TypeError);
  });

  it("matches the way the lead wrote it", () => {
    expect(compileJiraTemplatePattern("^[A-Z][a-z ]+$").test("Add login")).toBe(true);
    expect(compileJiraTemplatePattern("^[A-Z][a-z ]+$").test("add login")).toBe(false);
  });
});
