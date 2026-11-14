import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_MUTATION_LINKS_MAX,
  JIRA_MUTATION_DETAIL_LIMITS,
  JIRA_MUTATION_OPERATIONS,
  JIRA_MUTATION_RESULT_STATES,
  JIRA_TEMPLATE_RULE_IDS,
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  jiraOperationInReleaseScope,
  jiraTemplateGovernanceOf,
  type JiraMutationAttempt,
  type JiraMutationFailureDetail,
  type JiraMutationLinkAccount,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraDeclarationForTool } from "./jiraManagedProvider.js";
import { jiraAttemptToolResult, jiraMutationToolResult } from "./jiraMutationResult.js";

// #4354 (live Gemma composer run, 2026-11-14): a Sub-task asked under a Story was refused by the
// template's parent rule, and the refusal's guidance (549 characters) did not fit the 512 the
// result schema of jira.create allowed, so the catalog rejected the provider's result
// (`result-contract-failed`, data null) and the model never learned why. A refusal must always
// settle as a valid, explained result: for EVERY operation a template can refuse, and for every rule
// id a refusal can name, what the producer builds is what the operation's own contract accepts.
const GOVERNED = JIRA_MUTATION_OPERATIONS.filter(
  (operation) =>
    jiraOperationInReleaseScope(operation) &&
    jiraTemplateGovernanceOf(operation)?.class !== "not-governed",
);
const violation = (ruleId: JiraTemplateViolation["ruleId"]): JiraTemplateViolation => ({
  ruleId,
  subject: "x".repeat(120),
  template: "SYN/Task",
});
const REFUSALS: readonly (readonly [name: string, violations: readonly JiraTemplateViolation[]])[] =
  [
    ...JIRA_TEMPLATE_RULE_IDS.map((ruleId) => [ruleId, [violation(ruleId)]] as const),
    // The longest guidance: every kind of rule at once.
    ["every rule id together", JIRA_TEMPLATE_RULE_IDS.map(violation)],
  ];

describe("a template refusal is a valid result of every operation it can come from", () => {
  it("covers every governed operation of this release", () => {
    expect(GOVERNED.length).toBeGreaterThan(20);
    expect(GOVERNED).toContain("jira.create");
    expect(GOVERNED).toContain("jira.edit");
  });

  it.each(GOVERNED)("%s accepts every refusal the template gate can produce", (operation) => {
    const schema = jiraDeclarationForTool(operation)?.descriptor.resultSchema;
    if (schema === undefined) throw new TypeError(`${operation} declares no result schema`);
    for (const [name, violations] of REFUSALS) {
      const { data } = jiraMutationToolResult(
        "rejected",
        "field-validation",
        {},
        false,
        undefined,
        undefined,
        violations,
      );
      const mismatch = describeCatalogSchemaMismatch(schema, data);
      expect(mismatch && JSON.stringify(mismatch), `${operation}: ${name}`).toBeUndefined();
    }
  });
});

// The lesson, generalised (#4354): a refusal that is too long, or carries something its contract
// does not know, turns into `result-contract-failed` and the model learns nothing. So every shape the
// producers of the Jira write tools can build, in its worst case, passes the result schema of EVERY
// write tool. The shapes are walked from the producers' own closed vocabularies (outcomes, reasons,
// field validations, rule ids, detail and link limits), not listed by hand. `jira.draft` and
// `jira.create-issues` build their results in the draft producers, which have their own proofs.
type ResultData = ReturnType<typeof jiraMutationToolResult>["data"];
const WRITE_TOOLS = JIRA_MUTATION_OPERATIONS.filter(
  (operation) =>
    jiraOperationInReleaseScope(operation) &&
    operation !== "jira.draft" &&
    operation !== "jira.create-issues",
);
const MAX_DETAIL = (
  validation: (typeof JIRA_FIELD_VALIDATION_FAILURES)[number],
): JiraMutationFailureDetail => ({
  unchanged: true,
  fieldId: "f".repeat(64),
  validation,
  fieldErrors: Array.from({ length: JIRA_MUTATION_DETAIL_LIMITS.fieldErrors }, () => ({
    fieldId: "f".repeat(64),
    fieldName: "n".repeat(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
    message: "m".repeat(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
  })),
  messages: Array.from({ length: JIRA_MUTATION_DETAIL_LIMITS.messages }, () =>
    "m".repeat(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
  ),
});
const MAX_LINKS: JiraMutationLinkAccount = {
  requested: JIRA_MUTATION_LINKS_MAX,
  created: 0,
  missing: Array.from({ length: JIRA_MUTATION_LINKS_MAX }, () => ({
    type: "t".repeat(255),
    direction: "outward" as const,
    issueKey: "K".repeat(128),
  })),
  unconfirmed: true,
};
const ALL_VIOLATIONS = Array.from({ length: JIRA_TEMPLATE_VIOLATIONS_MAX }, (_, index) =>
  violation(JIRA_TEMPLATE_RULE_IDS[index % JIRA_TEMPLATE_RULE_IDS.length] ?? "summary-too-short"),
);

/** Every worst-case result the producers build, by their own vocabularies. */
function producedShapes(): readonly (readonly [name: string, data: ResultData])[] {
  const shapes: (readonly [string, ResultData])[] = [];
  for (const state of JIRA_MUTATION_RESULT_STATES) {
    for (const reason of ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS) {
      shapes.push([
        `${state}/${reason}/replayed`,
        jiraMutationToolResult(
          state,
          reason,
          {},
          true,
          MAX_DETAIL("invalid-field"),
          MAX_LINKS,
          ALL_VIOLATIONS,
        ).data,
      ]);
      // A settled attempt has no `pending` outcome: that state is only the producer's direct input.
      if (state === "pending") continue;
      for (const validation of JIRA_FIELD_VALIDATION_FAILURES) {
        const failed: JiraMutationAttempt = {
          ok: false,
          reason,
          detail: MAX_DETAIL(validation),
          links: MAX_LINKS,
          violations: ALL_VIOLATIONS,
        };
        shapes.push([
          `${state}/${reason}/${validation}`,
          jiraAttemptToolResult(state, failed).data,
        ]);
      }
    }
    if (state === "pending") continue;
    const succeeded: JiraMutationAttempt = {
      ok: true,
      receipt: {},
      links: MAX_LINKS,
      templateNotices: ALL_VIOLATIONS,
    };
    shapes.push([`${state}/succeeded with notices`, jiraAttemptToolResult(state, succeeded).data]);
  }
  return shapes;
}

describe("every shape the write producers build passes the result schema of every write tool", () => {
  const shapes = producedShapes();

  it("walks a real set of shapes", () => {
    expect(shapes.length).toBeGreaterThan(500);
    expect(WRITE_TOOLS.length).toBeGreaterThan(100);
  });

  it.each(WRITE_TOOLS)("%s accepts all of them", (operation) => {
    const schema = jiraDeclarationForTool(operation)?.descriptor.resultSchema;
    if (schema === undefined) throw new TypeError(`${operation} declares no result schema`);
    const refused = shapes
      .map(([name, data]) => [name, describeCatalogSchemaMismatch(schema, data)] as const)
      .filter(([, mismatch]) => mismatch !== undefined)
      .map(([name]) => name);
    expect(refused.slice(0, 5)).toEqual([]);
  });
});
