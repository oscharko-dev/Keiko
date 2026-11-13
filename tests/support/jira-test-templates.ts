import type { JiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * The shape the connectors and the server take as their template source. Declared here so test
 * support does not import a package-internal module.
 */
export interface JiraTestTemplateSet {
  readonly templates: readonly JiraIssueTemplate[];
  readonly unreadable: number;
}

/**
 * A template with no rules beyond its existence. A creation is refused unless a template governs
 * its project and issue type (#4354); a test of the write itself, not of a template rule, supplies
 * this so the write is not refused for a reason the test is not about. Never use it to prove a
 * refusal: a test of the gate builds the template it needs.
 */
export function permissiveJiraTemplate(project: string, issueType: string): JiraIssueTemplate {
  return {
    project: project.toUpperCase(),
    issueType,
    activations: [{ kind: "create" }],
    summary: {},
    requiredFields: [],
    requiredSections: [],
    labels: { required: [] },
    parent: {},
  };
}

/** One permissive template per project and issue type pair. */
export function permissiveJiraTemplates(
  projects: readonly string[],
  issueTypes: readonly string[],
): JiraTestTemplateSet {
  return {
    templates: projects.flatMap((project) =>
      issueTypes.map((issueType) => permissiveJiraTemplate(project, issueType)),
    ),
    unreadable: 0,
  };
}

/** Every Jira issue type name the synthetic fixtures of this repository create. */
export const SYNTHETIC_ISSUE_TYPES = [
  "Epic",
  "Story",
  "Task",
  "Sub-task",
  "Bug",
  "Improvement",
  "New Feature",
  // Numeric ids: a template may name an issue type by its id, and the fixtures read ids.
  "1",
  "2",
  "3",
  "4",
  "5",
  "7",
  "10000",
  "10001",
  "10002",
  "10003",
] as const;

/** The slice of the private store a test seeds templates into. */
export interface JiraTestTemplateStore {
  readonly markdownSkills: {
    readonly import: (input: {
      readonly fileName: string;
      readonly contentBase64: string;
    }) => unknown;
  };
}

/**
 * Saves one template per project and issue type into the private skill store the server reads its
 * template library from. A stored template needs at least one rule to parse, so each carries the
 * smallest one every test summary satisfies. For a test of a write, not of a template rule.
 */
export function seedPermissiveJiraTemplates(
  store: JiraTestTemplateStore,
  projects: readonly string[],
  issueTypes: readonly string[],
): void {
  for (const project of projects)
    for (const issueType of issueTypes) {
      const text = [
        "---",
        "keiko: jira-issue-template",
        "version: 1",
        `project: ${project}`,
        `issueType: ${issueType}`,
        "activateOn: [create]",
        "summaryMinLength: 1",
        "---",
        "",
      ].join("\n");
      store.markdownSkills.import({
        fileName: `${project}-${issueType}.md`,
        contentBase64: Buffer.from(text).toString("base64"),
      });
    }
}
