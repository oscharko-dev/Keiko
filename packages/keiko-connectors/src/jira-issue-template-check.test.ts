import { describe, expect, it } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  checkJiraIssueTemplate,
  checkJiraIssueTemplates,
  evaluateJiraTemplateChange,
  jiraTemplateValuePresent,
  jiraNoGoverningTemplateGuidance,
  jiraTemplateValueText,
  jiraTemplateViolationGuidance,
  matchingJiraIssueTemplates,
  resolveJiraTemplateFieldIds,
  validateJiraIssueTemplateAgainstInstance,
  type JiraFieldCatalogEntry,
  type JiraTemplateSubject,
} from "./jira-issue-template-check.js";
import { deriveJiraTemplateSections } from "./jira-issue-template-instance.js";

// #4354: a model that passes the refusal text through must pass words a bank clerk can read, not
// `parent-type-mismatch` and `parent: Task`. The structured rule id stays for the card and the log;
// the guidance and the subject carry the allowed and the actual parent type in plain words.
describe("the plain words of a parent refusal (#4354)", () => {
  const withParent = parsed(["parentField: Epic Link", "parentIssueTypes: [Epic]"], "# Story");
  const catalog: readonly JiraFieldCatalogEntry[] = [
    { id: "customfield_10014", name: "Epic Link" },
  ];
  const subject: JiraTemplateSubject = {
    operation: "create",
    projectKey: "ABC",
    issueType: { name: "Story" },
    fields: { customfield_10014: "ABC-5" },
    parentIssueTypes: { customfield_10014: { id: "1", name: "Task" } },
  };

  it("names the allowed and the actual parent type in the violation subject", () => {
    const violations = checkJiraIssueTemplate(withParent, subject, catalog);
    expect(violations).toEqual([
      expect.objectContaining({
        ruleId: "parent-type-mismatch",
        subject: "Epic Link: Epic (found: Task)",
      }),
    ]);
  });

  it("tells the model to explain in plain words, never to quote the rule id or a field id", () => {
    const guidance = jiraTemplateViolationGuidance([
      {
        ruleId: "parent-type-mismatch",
        subject: "Epic Link: Epic (found: Task)",
        template: "ABC/Story",
      },
    ]);
    expect(guidance).toContain("parent");
    expect(guidance).toContain("allowed");
    expect(guidance).toContain("actually");
    expect(guidance).toMatch(/never quote the rule id/iu);
    // The bare rule id is not the explanation the guidance offers.
    expect(guidance?.replaceAll("parent-type-mismatch", "")).toContain("plain words");
  });

  it("says the same for a missing parent: which parent the issue needs, in words", () => {
    const guidance = jiraTemplateViolationGuidance([
      { ruleId: "parent-missing", subject: "Epic Link", template: "ABC/Story" },
    ]);
    expect(guidance).toMatch(/needs a parent/iu);
    expect(guidance).toMatch(/never quote the rule id/iu);
  });
});

describe("the hint when no template governs a write (#4354)", () => {
  it("is fixed words that never carry remote text, and takes one observed sentence", () => {
    const plain = jiraNoGoverningTemplateGuidance({ ruleId: "template-missing" });
    expect(plain).toContain("Nothing was changed");
    expect(plain).toContain("propose templates from an existing project");
    const further = jiraNoGoverningTemplateGuidance(
      { ruleId: "template-missing" },
      "Stored templates exist, but they name another project.",
    );
    expect(further).toContain("Stored templates exist, but they name another project.");
    expect(further.startsWith(plain.slice(0, 60))).toBe(true);
    expect(jiraNoGoverningTemplateGuidance({ ruleId: "template-not-activated" })).toContain(
      "only for entering a status",
    );
  });
});

describe("formal admission guidance", () => {
  it("asks for complete evidence rather than alleging a rule violation when native data is unreadable", () => {
    const guidance = jiraTemplateViolationGuidance([
      { ruleId: "template-unreadable", subject: "labels", template: "SYN/Task" },
    ]);
    expect(guidance).toContain("Refresh the named native fields");
    expect(guidance).toContain("Missing evidence does not establish a rule violation");
    expect(guidance).not.toContain("this breaks the issue template");
  });
  it("keeps correctable known violations on the existing payload correction path", () => {
    expect(
      jiraTemplateViolationGuidance([
        { ruleId: "field-missing", subject: "Story Points", template: "SYN/Task" },
      ]),
    ).toContain("Correct what violations name");
  });
  it("tells the model to write a missing section itself instead of asking the user for its text", () => {
    const section = jiraTemplateViolationGuidance([
      { ruleId: "section-missing", subject: "Testhinweise", template: "SYN/Sub-task" },
    ]);
    expect(section).toContain("Write the section text yourself");
    expect(section).toContain("ask the user only for a fact neither provides");
    expect(
      jiraTemplateViolationGuidance([
        { ruleId: "field-missing", subject: "Story Points", template: "SYN/Task" },
      ]),
    ).not.toContain("Write the section text yourself");
  });
});

describe("sections sampled from native Jira descriptions", () => {
  it("does not invent Markdown headings from native lists, underlines or fence text", () => {
    const native = "# First item\nParagraph\n---\n```\nh2. Goal\nBody\n```";
    expect(deriveJiraTemplateSections([native, native])).toEqual(["Goal"]);
  });
});

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

  it("accepts native wiki headings with content, in any level", () => {
    const description = "h2. Context\nWhy it matters\n\nh3. Acceptance Criteria:\n* works\n";
    expect(ids(template, subject({ description }))).toEqual([]);
  });

  it("checks explicit Markdown using the same canonical text as the write and preview", () => {
    const description = {
      format: "markdown",
      text: "## Context\nWhy\n\nAcceptance criteria\n---\n* works",
    };
    const before = JSON.stringify(description);
    expect(ids(template, subject({ description }))).toEqual([]);
    expect(JSON.stringify(description)).toBe(before);
    const required = parsed(["requiredFields: [Description]"], "# T");
    expect(ids(required, subject({ description: { format: "markdown", text: "  " } }))).toEqual([
      "field-missing:Description",
    ]);
  });

  it("reports a missing section and an empty or placeholder section", () => {
    expect(ids(template, subject({ description: "h2. Context\nWhy" }))).toEqual([
      "section-missing:Acceptance criteria",
    ]);
    expect(
      ids(template, subject({ description: "h2. Context\nTBD\nh2. Acceptance criteria\n\n  \n" })),
    ).toEqual(["section-empty:Context", "section-empty:Acceptance criteria"]);
  });

  it("counts every placeholder the empty-section hint names as no content (#4357 AC3)", () => {
    for (const placeholder of ["TBD", "TODO", "...", "-", "<text>"])
      expect(
        ids(
          template,
          subject({ description: `h2. Context\n${placeholder}\nh2. Acceptance criteria\nOK` }),
        ),
      ).toEqual(["section-empty:Context"]);
  });

  it("does not take a heading from inside another section's text", () => {
    expect(
      ids(template, subject({ description: "Context and Acceptance criteria prose" })),
    ).toEqual(["section-missing:Context", "section-missing:Acceptance criteria"]);
  });

  it("reads an absent description as no sections", () => {
    expect(ids(template, subject({}))).toHaveLength(2);
  });

  it("judges native backticks as text and excludes native wiki code blocks", () => {
    const fenced = "h2. Context\nWhy\n```\nh2. Acceptance criteria\nfake\n```\n";
    // ADR-0128's native-wire section contract: backticks are not Jira wiki code macros.
    expect(ids(template, subject({ description: fenced }))).toEqual([]);
    const wiki = "h2. Context\nWhy\n{code}\nh2. Acceptance criteria\nfake\n{code}\n";
    expect(ids(template, subject({ description: wiki }))).toEqual([
      "section-missing:Acceptance criteria",
    ]);
  });

  it("counts subsections as part of the section that holds them", () => {
    const description =
      "h2. Context\nh3. Background\nWhy\nh3. Impact\nWho\nh2. Acceptance criteria\n* ok";
    expect(ids(template, subject({ description }))).toEqual([]);
  });

  it("still ends a section at the next heading of the same level", () => {
    const description = "h2. Context\nh2. Acceptance criteria\n* ok";
    expect(ids(template, subject({ description }))).toEqual(["section-empty:Context"]);
  });

  it("reads explicitly tagged setext Markdown with the template's required section", () => {
    const setext = parsed(
      [],
      "Context\n=======\nIgnored H1\n\nAcceptance criteria\n-------------------\n",
    );
    expect(setext.requiredSections).toEqual(["Acceptance criteria"]);
    const description = {
      format: "markdown",
      text: "Acceptance criteria\n-------------------\n* ok\n",
    };
    expect(ids(setext, subject({ description }))).toEqual([]);
    expect(
      ids(
        setext,
        subject({ description: { format: "markdown", text: "Acceptance criteria\n---\n" } }),
      ),
    ).toEqual(["section-empty:Acceptance criteria"]);
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

describe("a plain activation governs creating and editing, never a transition (#4354)", () => {
  const withActivation = (activateOn: string): JiraIssueTemplate => {
    const result = parseJiraIssueTemplate(
      [
        "---",
        "keiko: jira-issue-template",
        "version: 1",
        "project: ABC",
        "issueType: Story",
        `activateOn: [${activateOn}]`,
        "summaryMinLength: 3",
        "---",
        "# T",
      ].join("\n"),
    );
    if (!result.ok) throw new Error("fixture template must parse");
    return result.template;
  };
  const governed = (activateOn: string, operation: JiraTemplateSubject["operation"]): number =>
    matchingJiraIssueTemplates(
      [withActivation(activateOn)],
      subject(
        {},
        { operation, transition: { id: "31", name: "Start", targetStatusName: "Ready" } },
      ),
    ).length;

  it.each(["create", "edit"])("lets %s govern creating and editing, not a transition", (word) => {
    expect(governed(word, "create")).toBe(1);
    expect(governed(word, "edit")).toBe(1);
    expect(governed(word, "transition")).toBe(0);
  });
  it("lets a transition activation govern only the transition it names", () => {
    expect(governed("transition:Ready", "transition")).toBe(1);
    expect(governed("transition:Done", "transition")).toBe(0);
    expect(governed("transition:Ready", "create")).toBe(0);
    expect(governed("transition:Ready", "edit")).toBe(0);
  });
});

describe("evaluating a change against its before-state and after-state (#4354)", () => {
  const template = parsed(["summaryMinLength: 10", "requiredLabels: [reviewed]"], "# T");
  const evaluate = (
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown>,
    touched: readonly string[],
  ): ReturnType<typeof evaluateJiraTemplateChange> =>
    evaluateJiraTemplateChange({
      templates: [template],
      before: before === undefined ? undefined : subject(before, { operation: "edit" }),
      after: subject(after, { operation: before === undefined ? "create" : "edit" }),
      touched: new Set(touched),
      catalog: CATALOG,
    });
  const ids = (list: readonly { ruleId: string }[]): string[] =>
    list.map((violation) => violation.ruleId);

  it("judges a creation on its after-state alone: everything blocks", () => {
    const verdict = evaluate(undefined, { summary: "short", labels: [] }, ["summary"]);
    expect(ids(verdict.blocking)).toEqual(["summary-too-short", "label-missing"]);
    expect(verdict.notices).toEqual([]);
  });
  it("blocks an edit that breaks a field it touches and notices what was already broken elsewhere", () => {
    const before = { summary: "A long enough summary", labels: [] };
    const verdict = evaluate(before, { ...before, summary: "short" }, ["summary"]);
    expect(ids(verdict.blocking)).toEqual(["summary-too-short"]);
    expect(ids(verdict.notices)).toEqual(["label-missing"]);
  });
  it("lets an edit through when every rule it fails already failed in an untouched field", () => {
    const before = { summary: "short", labels: [] };
    const verdict = evaluate(before, { ...before, description: "x" }, ["description"]);
    expect(verdict.blocking).toEqual([]);
    expect(ids(verdict.notices)).toEqual(["summary-too-short", "label-missing"]);
  });
  it("blocks an edit that touches a field that was already broken and stays broken", () => {
    const before = { summary: "short", labels: ["reviewed"] };
    const verdict = evaluate(before, { ...before, summary: "tiny" }, ["summary"]);
    expect(ids(verdict.blocking)).toEqual(["summary-too-short"]);
  });
  it("blocks a violation the edit introduces even in a field it did not list as touched", () => {
    const verdict = evaluate(
      { summary: "A long enough summary", labels: ["reviewed"] },
      { summary: "A long enough summary", labels: [] },
      [],
    );
    expect(ids(verdict.blocking)).toEqual(["label-missing"]);
  });
  it("counts labels and links as touched fields", () => {
    const before = { summary: "A long enough summary", labels: [] };
    const verdict = evaluate(before, before, ["labels"]);
    expect(ids(verdict.blocking)).toEqual(["label-missing"]);
  });
  it("keeps a rule about a field the instance lacks a notice when the edit does not set it", () => {
    const unreadable = parsed(["requiredFields: [Story Points]"], "# T");
    const verdict = evaluateJiraTemplateChange({
      templates: [unreadable],
      before: subject({}, { operation: "edit" }),
      after: subject({}, { operation: "edit" }),
      touched: new Set(),
      catalog: [],
    });
    expect(verdict.blocking.map((violation) => violation.ruleId)).toEqual([]);
    expect(verdict.notices.map((violation) => violation.ruleId)).toEqual(["field-unavailable"]);
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

  it("decides presence of composite and opaque values by content, not by a displayable identity", () => {
    expect(jiraTemplateValuePresent({ originalEstimate: "1h" })).toBe(true);
    expect(jiraTemplateValuePresent({ remainingEstimateSeconds: 0 })).toBe(true);
    expect(jiraTemplateValuePresent({ originalEstimate: "", remainingEstimate: " " })).toBe(false);
    expect(jiraTemplateValuePresent({})).toBe(false);
    expect(jiraTemplateValuePresent([])).toBe(false);
    expect(jiraTemplateValuePresent([{}, null, ""])).toBe(false);
    expect(jiraTemplateValuePresent(null)).toBe(false);
    expect(jiraTemplateValuePresent({ name: "core" })).toBe(true);
    expect(jiraTemplateValuePresent("x")).toBe(true);
    expect(jiraTemplateValuePresent(false)).toBe(true);
  });

  it("does not refuse an issue whose required time tracking holds a value", () => {
    const tracked = parsed(["requiredFields: [Time Tracking]"], "## Context");
    const catalog = [{ id: "timetracking", name: "Time Tracking" }];
    const present = checkJiraIssueTemplate(
      tracked,
      subject({ timetracking: { originalEstimate: "1h" } }, { operation: "edit" }),
      catalog,
    );
    expect(present.map((violation) => violation.ruleId)).not.toContain("field-missing");
    for (const empty of [null, {}, { originalEstimate: "" }]) {
      const missing = checkJiraIssueTemplate(
        tracked,
        subject({ timetracking: empty }, { operation: "edit" }),
        catalog,
      );
      expect(missing.map((violation) => violation.ruleId)).toContain("field-missing");
    }
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

// #4354 AC2: a Task or Sub-task template names the field that links it to its parent; the instance
// decides which field that is. A Parent Link on a Task (customfield_10101 in the customer's Jira)
// matched "Jira" although the Task-to-Epic relation is the Epic Link (customfield_10109).
describe("the parent relation of a template's issue type (#4354)", () => {
  const RELATIONS: readonly JiraFieldCatalogEntry[] = [
    { id: "summary", name: "Summary" },
    { id: "parent", name: "Parent" },
    {
      id: "customfield_10109",
      name: "Epic Link",
      schemaCustom: "com.pyxis.greenhopper.jira:gh-epic-link",
    },
    {
      id: "customfield_10101",
      name: "Parent Link",
      schemaCustom: "com.atlassian.jpo:jpo-custom-field-parent",
    },
  ];
  const instance = {
    fields: RELATIONS,
    project: {
      key: "ABC",
      issueTypes: [
        { id: "1", name: "Task", subtask: false },
        { id: "2", name: "Sub-task", subtask: true },
        { id: "3", name: "Epic", subtask: false },
      ],
    },
  };
  const findings = (issueType: string, field: string): readonly string[] =>
    validateJiraIssueTemplateAgainstInstance(
      { ...parsed([`parentField: ${field}`], "# T"), issueType },
      instance,
    ).map((finding) => `${finding.code}:${finding.subject}`);

  it("flags a Task template whose parent field is the Parent Link, naming the Epic Link", () => {
    expect(findings("Task", "customfield_10101")).toEqual([
      "wrong-parent-field:customfield_10101 instead of Epic Link (customfield_10109)",
    ]);
  });
  it("accepts the Epic Link on a Task and the system parent on a Sub-task", () => {
    expect(findings("Task", "customfield_10109")).toEqual([]);
    expect(findings("Task", "Epic Link")).toEqual([]);
    expect(findings("Sub-task", "parent")).toEqual([]);
  });
  it("flags an Epic Link or a Parent Link on a Sub-task, naming the system parent", () => {
    expect(findings("Sub-task", "customfield_10109")).toEqual([
      "wrong-parent-field:customfield_10109 instead of Parent (parent)",
    ]);
    expect(findings("Sub-task", "customfield_10101")).toEqual([
      "wrong-parent-field:customfield_10101 instead of Parent (parent)",
    ]);
  });
  it("leaves an Epic alone: it is linked to an initiative by the Parent Link", () => {
    expect(findings("Epic", "customfield_10101")).toEqual([]);
  });
  it("says nothing about the relation when the project or the field kinds are not known", () => {
    const codes = (
      template: JiraIssueTemplate,
      facts: Parameters<typeof validateJiraIssueTemplateAgainstInstance>[1],
    ): readonly string[] =>
      validateJiraIssueTemplateAgainstInstance(template, facts).map((finding) => finding.code);
    const bare = { ...parsed(["parentField: customfield_10101"], "# T"), issueType: "Task" };
    expect(codes(bare, { fields: RELATIONS })).not.toContain("wrong-parent-field");
    expect(
      codes(bare, {
        fields: [{ id: "customfield_10101", name: "Parent Link" }],
        project: instance.project,
      }),
    ).not.toContain("wrong-parent-field");
  });
});

describe("native description rendering contract", () => {
  const required = parsed([], "## Criteria\n## Source\n");

  it("refuses Markdown section credit for a native Jira description without rewriting it", () => {
    const description = "## Criteria\n# first\n## nested\n## Source\nReference";
    const issue = subject({ description });
    const before = structuredClone(issue);
    expect(ids(required, issue)).toEqual(["section-missing:Criteria", "section-missing:Source"]);
    expect(issue).toEqual(before);
  });

  it("accepts native wiki headings and explicit Markdown using the same section contract", () => {
    const native = "h2. Criteria\n# first\n## nested\nh2. Source\nReference";
    expect(ids(required, subject({ description: native }))).toEqual([]);
    expect(
      ids(
        required,
        subject({
          description: { format: "markdown", text: "## Criteria\n* exact\n## Source\nReference" },
        }),
      ),
    ).toEqual([]);
  });
});

// #4357 AC3: three rules whose subject alone does not say what to change get one short sentence each.
describe("the hints of rules a subject does not explain (#4357 AC3)", () => {
  const HINTS = {
    "section-empty":
      " A section that holds only a placeholder (TBD, TODO, ..., -, or <text>) counts as empty: write real content.",
    "label-pattern":
      " A label rule has a pattern: the subject is the label that does not match it; use a label the template's labels rule allows.",
    "field-unavailable":
      " A field-unavailable subject is a field this project's screen does not offer, so it cannot be set: do not retry with it, tell the person.",
  } as const;
  const guidanceFor = (ruleId: keyof typeof HINTS): string =>
    jiraTemplateViolationGuidance([{ ruleId, subject: "x", template: "SYN/Story" }]) ?? "";
  it.each(Object.keys(HINTS) as (keyof typeof HINTS)[])(
    "adds the sentence for %s, and only for it",
    (ruleId) => {
      expect(guidanceFor(ruleId)).toContain(HINTS[ruleId]);
      for (const other of Object.keys(HINTS) as (keyof typeof HINTS)[])
        if (other !== ruleId) expect(guidanceFor(ruleId)).not.toContain(HINTS[other]);
    },
  );
});

describe("a bulk or schema change a formal rule refers to (#4357 AC3)", () => {
  const IMPACT =
    "Nothing was changed: a formal template rule of this project refers to a field this change would alter on issues that Keiko cannot check one by one. Do not retry it. Change the affected issues one at a time with the edit tool, or tell the person it has to be done in Jira.";
  it.each([
    "Bulk issue-field impact: Fix versions",
    "Schema changes require complete governed issue migration",
  ])("says the rule exists and what to do, not that evidence is missing: %s", (subject) => {
    const guidance = jiraTemplateViolationGuidance([
      { ruleId: "template-unreadable", subject, template: "SYN/Story" },
    ]);
    expect(guidance).toBe(IMPACT);
    expect(guidance).not.toMatch(/could not be read|Missing evidence/u);
  });
  it("keeps the evidence wording for an unreadable library", () => {
    expect(
      jiraTemplateViolationGuidance([
        { ruleId: "template-unreadable", subject: "template library", template: "*" },
      ]),
    ).toMatch(/could not be read completely/u);
  });
});
