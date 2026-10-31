import { describe, expect, it } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  checkJiraIssueTemplate,
  checkJiraIssueTemplates,
  jiraTemplateValuePresent,
  jiraTemplateValueText,
  matchingJiraIssueTemplates,
  resolveJiraTemplateFieldIds,
  validateJiraIssueTemplateAgainstInstance,
  type JiraFieldCatalogEntry,
  type JiraTemplateSubject,
} from "./jira-issue-template-check.js";

const CATALOG: readonly JiraFieldCatalogEntry[] = [
  { id: "summary", name: "Summary" },
  { id: "description", name: "Description" },
  { id: "labels", name: "Labels" },
  { id: "customfield_10016", name: "Story Points" },
  { id: "customfield_10014", name: "Epic Link" },
  { id: "customfield_20001", name: "Team" },
  { id: "customfield_20002", name: "Team" },
];

function parsed(rules: readonly string[], body: string): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: ABC",
      "issueType: Story",
      "activateOn: [create, edit, transition:Ready]",
      ...rules,
      "---",
      body,
    ].join("\n"),
  );
  if (!result.ok) throw new Error("fixture template must parse");
  return result.template;
}

function subject(
  fields: Record<string, unknown>,
  overrides: Partial<JiraTemplateSubject> = {},
): JiraTemplateSubject {
  return {
    operation: "create",
    projectKey: "ABC",
    issueType: { id: "10001", name: "Story" },
    fields,
    ...overrides,
  };
}

function ids(template: JiraIssueTemplate, value: JiraTemplateSubject): string[] {
  return checkJiraIssueTemplate(template, value, CATALOG).map(
    (violation) => `${violation.ruleId}:${violation.subject}`,
  );
}

describe("summary rules", () => {
  const template = parsed(
    ["summaryMinLength: 8", "summaryMaxLength: 20", "summaryPattern: ^[A-Z]"],
    "# T",
  );

  it("accepts a conforming summary", () => {
    expect(ids(template, subject({ summary: "Add login flow" }))).toEqual([]);
  });

  it("reports length and pattern violations with closed ids", () => {
    expect(ids(template, subject({ summary: "fix" }))).toEqual([
      "summary-too-short:at least 8 characters",
      "summary-pattern:^[A-Z]",
    ]);
    expect(ids(template, subject({ summary: `A${"x".repeat(30)}` }))).toEqual([
      "summary-too-long:at most 20 characters",
    ]);
  });

  it("treats a missing summary as empty", () => {
    expect(ids(template, subject({}))).toContain("summary-too-short:at least 8 characters");
  });

  it("throws, rather than guessing, on a hand-built unsafe pattern", () => {
    const broken: JiraIssueTemplate = {
      ...template,
      summary: { pattern: "(a+)+$" },
    };
    expect(() => ids(broken, subject({ summary: "aaaa" }))).toThrow("pattern structure");
  });
});

describe("description sections", () => {
  const template = parsed([], "# T\n## Context\n## Acceptance criteria\n");

  it("accepts Markdown and wiki headings with content, in any level", () => {
    const description = "## Context\nWhy it matters\n\nh3. Acceptance Criteria:\n* works\n";
    expect(ids(template, subject({ description }))).toEqual([]);
  });

  it("reports a missing section and an empty or placeholder section", () => {
    expect(ids(template, subject({ description: "## Context\nWhy" }))).toEqual([
      "section-missing:Acceptance criteria",
    ]);
    expect(
      ids(template, subject({ description: "## Context\nTBD\n## Acceptance criteria\n\n  \n" })),
    ).toEqual(["section-empty:Context", "section-empty:Acceptance criteria"]);
  });

  it("does not take a heading from inside another section's text", () => {
    expect(
      ids(template, subject({ description: "Context and Acceptance criteria prose" })),
    ).toEqual(["section-missing:Context", "section-missing:Acceptance criteria"]);
  });

  it("reads an absent description as no sections", () => {
    expect(ids(template, subject({}))).toHaveLength(2);
  });

  it("does not take a heading from fenced code or a wiki code block", () => {
    const fenced = "## Context\nWhy\n```\n## Acceptance criteria\nfake\n```\n";
    expect(ids(template, subject({ description: fenced }))).toEqual([
      "section-missing:Acceptance criteria",
    ]);
    const wiki = "## Context\nWhy\n{code}\nh2. Acceptance criteria\nfake\n{code}\n";
    expect(ids(template, subject({ description: wiki }))).toEqual([
      "section-missing:Acceptance criteria",
    ]);
  });

  it("counts subsections as part of the section that holds them", () => {
    const description =
      "## Context\n### Background\nWhy\n### Impact\nWho\n## Acceptance criteria\n* ok";
    expect(ids(template, subject({ description }))).toEqual([]);
  });

  it("still ends a section at the next heading of the same level", () => {
    const description = "## Context\n## Acceptance criteria\n* ok";
    expect(ids(template, subject({ description }))).toEqual(["section-empty:Context"]);
  });

  it("reads setext headings on the issue and in the template alike", () => {
    const setext = parsed(
      [],
      "Context\n=======\nIgnored H1\n\nAcceptance criteria\n-------------------\n",
    );
    expect(setext.requiredSections).toEqual(["Acceptance criteria"]);
    const description = "Acceptance criteria\n-------------------\n* ok\n";
    expect(ids(setext, subject({ description }))).toEqual([]);
    expect(ids(setext, subject({ description: "Acceptance criteria\n---\n" }))).toEqual([
      "section-empty:Acceptance criteria",
    ]);
  });

  it("reads an adversarial 100k character description in bounded time", () => {
    const description = `# a${" ".repeat(100_000)}b\n## Context\nWhy`;
    const started = performance.now();
    ids(template, subject({ description }));
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("pattern rules cannot be made slow", () => {
  it("evaluates a catastrophic pattern on a maximum-length summary in milliseconds", () => {
    const hostile = parsed(["summaryPattern: ^.*.*.*.*!"], "# T");
    const started = performance.now();
    expect(ids(hostile, subject({ summary: "a".repeat(255) }))).toEqual([
      "summary-pattern:^.*.*.*.*!",
    ]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("required fields and the parent relation", () => {
  const template = parsed(
    ["requiredFields: [Story Points, Unknown thing, Team]", "parentField: Epic Link"],
    "# T",
  );

  it("resolves names and ids against the catalog", () => {
    expect(resolveJiraTemplateFieldIds("Story Points", CATALOG)).toEqual(["customfield_10016"]);
    expect(resolveJiraTemplateFieldIds("customfield_10016", CATALOG)).toEqual([
      "customfield_10016",
    ]);
    expect(resolveJiraTemplateFieldIds("story points", CATALOG)).toEqual(["customfield_10016"]);
    expect(resolveJiraTemplateFieldIds("Nope", CATALOG)).toEqual([]);
  });

  it("reports missing, unavailable and parent violations", () => {
    expect(ids(template, subject({ customfield_20002: { value: "Core" } }))).toEqual([
      "field-missing:Story Points",
      "field-unavailable:Unknown thing",
      "parent-missing:Epic Link",
    ]);
  });

  it("accepts values of every wire shape and a duplicate field name satisfied by either id", () => {
    expect(
      ids(
        template,
        subject({
          customfield_10016: 0,
          customfield_20001: [{ name: "core" }],
          customfield_10014: "ABC-1",
        }),
      ),
    ).toEqual(["field-unavailable:Unknown thing"]);
  });

  it("treats blank, null and empty values as missing", () => {
    const blank = subject({
      customfield_10016: null,
      customfield_20001: "  ",
      customfield_10014: [],
    });
    expect(ids(template, blank)).toContain("field-missing:Story Points");
    expect(ids(template, blank)).toContain("parent-missing:Epic Link");
  });

  it("checks a parent link on every write, counting links the write adds", () => {
    const linked = parsed(["parentLink: is child of"], "# T");
    expect(ids(linked, subject({}))).toEqual(["parent-missing:is child of"]);
    expect(ids(linked, subject({}, { linkTypes: ["Is Child Of"] }))).toEqual([]);
    expect(ids(linked, subject({}, { operation: "edit", linkTypes: [] }))).toEqual([
      "parent-missing:is child of",
    ]);
    expect(
      ids(linked, subject({}, { operation: "edit", linkTypes: ["Is Child Of", "blocks"] })),
    ).toEqual([]);
  });
});

describe("label rules", () => {
  const template = parsed(
    ["requiredLabels: [backend]", "labelPattern: ^[a-z-]+$", "minLabels: 2"],
    "# T",
  );

  it("accepts conforming labels and matches required names case-insensitively", () => {
    expect(ids(template, subject({ labels: ["backend", "team-a"] }))).toEqual([]);
    const loose = parsed(["requiredLabels: [backend]"], "# T");
    expect(ids(loose, subject({ labels: ["Backend"] }))).toEqual([]);
  });

  it("reports missing, count and pattern violations", () => {
    expect(ids(template, subject({ labels: ["BAD LABEL"] }))).toEqual([
      "label-missing:backend",
      "label-count:at least 2 labels",
      "label-pattern:BAD LABEL",
    ]);
    expect(ids(template, subject({}))).toEqual([
      "label-missing:backend",
      "label-count:at least 2 labels",
    ]);
  });
});

describe("activation and matching", () => {
  const template = parsed(["summaryMinLength: 3"], "# T");
  const transition = { id: "31", name: "Start", targetStatusName: "Ready" };

  it("matches project, issue type name or id, and activation point", () => {
    expect(matchingJiraIssueTemplates([template], subject({}))).toHaveLength(1);
    expect(matchingJiraIssueTemplates([template], subject({}, { projectKey: "abc" }))).toHaveLength(
      1,
    );
    expect(
      matchingJiraIssueTemplates([template], subject({}, { projectKey: "OTHER" })),
    ).toHaveLength(0);
    expect(
      matchingJiraIssueTemplates([template], subject({}, { issueType: { name: "Bug" } })),
    ).toHaveLength(0);
    const byId = { ...template, issueType: "10001" };
    expect(matchingJiraIssueTemplates([byId], subject({}))).toHaveLength(1);
  });

  it("activates a transition template by target status, transition name or id only", () => {
    const at = (value: JiraTemplateSubject): number =>
      matchingJiraIssueTemplates([template], value).length;
    const base = subject({}, { operation: "transition" });
    expect(at({ ...base, transition })).toBe(1);
    expect(at({ ...base, transition: { id: "31", name: "Ready" } })).toBe(1);
    expect(at({ ...base, transition: { id: "Ready" } })).toBe(1);
    expect(
      at({ ...base, transition: { id: "99", name: "Block", targetStatusName: "Blocked" } }),
    ).toBe(0);
    expect(at(base)).toBe(0);
  });

  it("activates a bare transition for every transition and not for other operations", () => {
    const every = { ...template, activations: [{ kind: "transition" as const }] };
    expect(
      matchingJiraIssueTemplates([every], subject({}, { operation: "transition", transition })),
    ).toHaveLength(1);
    expect(matchingJiraIssueTemplates([every], subject({}))).toHaveLength(0);
    expect(matchingJiraIssueTemplates([every], subject({}, { operation: "edit" }))).toHaveLength(0);
  });
});

describe("checkJiraIssueTemplates", () => {
  it("merges the violations of every governing template once and in a stable order", () => {
    const first = parsed(["summaryMinLength: 5"], "# T");
    const second = parsed(["summaryMinLength: 5", "requiredLabels: [x]"], "# T");
    const result = checkJiraIssueTemplates([first, second], subject({ summary: "ab" }), CATALOG);
    expect(result.map((violation) => violation.ruleId)).toEqual([
      "summary-too-short",
      "label-missing",
    ]);
  });

  it("bounds the output", () => {
    const sections = Array.from({ length: 40 }, (_, index) => `## S${String(index)}`).join("\n");
    const big = parsed([], sections);
    expect(checkJiraIssueTemplates([big], subject({}), CATALOG)).toHaveLength(25);
  });

  it("is deterministic", () => {
    const template = parsed(["requiredFields: [Story Points]", "requiredLabels: [x]"], "## A\n");
    const value = subject({ summary: "s" });
    expect(checkJiraIssueTemplates([template], value, CATALOG)).toEqual(
      checkJiraIssueTemplates([template], value, CATALOG),
    );
  });

  it("returns nothing when no template governs the write", () => {
    const template = parsed(["summaryMinLength: 5"], "# T");
    expect(
      checkJiraIssueTemplates([template], subject({}, { projectKey: "ZZZ" }), CATALOG),
    ).toEqual([]);
  });
});

describe("value helpers", () => {
  it("reads text from every wire shape", () => {
    expect(jiraTemplateValueText("a")).toBe("a");
    expect(jiraTemplateValueText(5)).toBe("5");
    expect(jiraTemplateValueText(Number.NaN)).toBe("");
    expect(jiraTemplateValueText([{ name: "a" }, { value: "b" }, 3])).toBe("a b 3");
    expect(jiraTemplateValueText({ key: "ABC-1" })).toBe("ABC-1");
    expect(jiraTemplateValueText({ id: 12 })).toBe("12");
    expect(jiraTemplateValueText(null)).toBe("");
    expect(jiraTemplateValueText(true)).toBe("");
    expect(jiraTemplateValueText({ other: "x" })).toBe("");
  });

  it("decides presence", () => {
    expect(jiraTemplateValuePresent(0)).toBe(true);
    expect(jiraTemplateValuePresent(Number.POSITIVE_INFINITY)).toBe(false);
    expect(jiraTemplateValuePresent(" ")).toBe(false);
    expect(jiraTemplateValuePresent(undefined)).toBe(false);
    expect(jiraTemplateValuePresent([{ name: "a" }])).toBe(true);
  });
});

describe("validateJiraIssueTemplateAgainstInstance", () => {
  const template = parsed(
    [
      "requiredFields: [Story Points, Team, Nope]",
      "parentField: Epic Link",
      "parentLink: relates to",
    ],
    "# T",
  );
  const instance = {
    fields: CATALOG,
    linkTypes: [{ name: "Blocks", inward: "is blocked by", outward: "blocks" }],
    project: { key: "ABC", issueTypes: [{ id: "10001", name: "Story" }] },
    statuses: ["To Do", "Ready"],
  };

  it("reports unknown and ambiguous fields and unknown link types", () => {
    expect(
      validateJiraIssueTemplateAgainstInstance(template, instance).map(
        (finding) => `${finding.code}:${finding.subject}`,
      ),
    ).toEqual(["ambiguous-field:Team", "unknown-field:Nope", "unknown-link-type:relates to"]);
  });

  it("reports an unknown project, issue type and transition target", () => {
    expect(
      validateJiraIssueTemplateAgainstInstance(template, { fields: CATALOG }).map(
        (finding) => finding.code,
      ),
    ).toContain("unknown-project");
    const other = { ...template, issueType: "Epic" };
    expect(
      validateJiraIssueTemplateAgainstInstance(other, instance).map((finding) => finding.code),
    ).toContain("unknown-issue-type");
    const target = parsed(["summaryMinLength: 3"], "# T");
    const missing = { ...target, activations: [{ kind: "transition" as const, target: "Done" }] };
    expect(
      validateJiraIssueTemplateAgainstInstance(missing, instance).map(
        (finding) => `${finding.code}:${finding.subject}`,
      ),
    ).toEqual(["unknown-transition-target:Done"]);
  });

  it("is clean for a template that matches the instance", () => {
    const clean = parsed(["requiredFields: [Story Points]", "parentField: Epic Link"], "# T");
    expect(validateJiraIssueTemplateAgainstInstance(clean, instance)).toEqual([]);
  });
});
