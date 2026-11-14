// Issue-template support of the requirements lab (epic #4173, #4177). A project lead defines a
// template as a Markdown skill in the library and the product activates it by its front matter.
// This module builds the template the lab's structure rules describe, drives the product's own
// skill-library routes (the lead's settings surface), and holds the pure oracles of S01, S02 and
// S06. A template is graded against what the library lists, what the instance validates and what
// Jira finally holds; the model's account of a refusal is never evidence.
import { Buffer } from "node:buffer";
import { STRUCTURE_RULES } from "./corpus.mjs";
import { epicConforms } from "./oracles.mjs";
import { toolExchangeOf, completedToolExchange } from "./tool-exchanges.mjs";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const sameSet = (left, right) => left.size === right.size && [...left].every((id) => right.has(id));

/** Runtime runs require an explicit key; the reusable Markdown builders retain their inputs. */
export function runtimeTemplateProjectKey(projectKey) {
  if (typeof projectKey !== "string" || !/^[A-Z][A-Z0-9_]{1,31}$/u.test(projectKey)) {
    throw new TypeError("Invalid runtime template project key");
  }
  return projectKey;
}

/** The summary every epic of the lab starts with: `[LH-001] <title>`. */
export const EPIC_SUMMARY_PATTERN = String.raw`^\[LH-\d{3}\] \S`;

/**
 * The Epic summary rule of the golden Lastenheft run: the bracketed requirement ID, then the title.
 * The Lastenheft numbers its requirements in several schemes (REQ-FA-017, NFA-SEC-003, MIG_DAT-002,
 * ABN-45.1), so the rule names the ID shape, not one scheme. It is flat because the product refuses
 * a quantified group that holds a quantifier (ADR-0128 D4).
 */
const REQUIREMENT_EPIC_SUMMARY_PATTERN = String.raw`^\[[A-Z][A-Z0-9_.-]*[0-9]\] \S`;

/** The one formal rule the bulk run breaks on purpose: the installed Epic template's summary pattern. */
export const EPIC_SUMMARY_VIOLATION = Object.freeze({
  ruleId: "summary-pattern",
  prompt: "Deliberately omit the required bracketed requirement ID from the summary.",
});

/**
 * The Markdown template a lead would write for `issueType` from the lab's structure rule: the
 * rule's description sections become the body headings, its labels the required labels, and the
 * epic summary format a summary pattern.
 */
export function templateMarkdown({
  project,
  issueType,
  rule,
  summaryPattern,
  parentField,
  parentIssueTypes,
  requiredFields = [],
  activateOn = ["create"],
}) {
  const quoted = (value) => JSON.stringify(value);
  const front = [
    "---",
    "keiko: jira-issue-template",
    "version: 1",
    `project: ${project}`,
    `issueType: ${quoted(issueType)}`,
    `activateOn: [${activateOn.join(", ")}]`,
    ...(summaryPattern === undefined ? [] : [`summaryPattern: ${quoted(summaryPattern)}`]),
    ...(rule.labels?.length > 0
      ? [`requiredLabels: [${rule.labels.map((label) => quoted(label)).join(", ")}]`]
      : []),
    ...(parentField === undefined ? [] : [`parentField: ${quoted(parentField)}`]),
    ...(parentIssueTypes === undefined
      ? []
      : [`parentIssueTypes: [${parentIssueTypes.map(quoted).join(", ")}]`]),
    ...(requiredFields.length > 0
      ? [`requiredFields: [${requiredFields.map((field) => quoted(field)).join(", ")}]`]
      : []),
    "---",
  ];
  const body = rule.sections.flatMap((section) => [`## ${section}`, ""]);
  return [...front, `# Vorlage ${issueType}`, "", ...body].join("\n").trimEnd() + "\n";
}

/** The template of the lab's work project for epics. */
export const epicTemplateMarkdown = (project, summaryPattern = EPIC_SUMMARY_PATTERN) =>
  templateMarkdown({
    project,
    issueType: "Epic",
    rule: STRUCTURE_RULES.Epic,
    summaryPattern,
  });

/** The structure a project lead defines for Stories: a user goal, the criteria and the done list. */
export const STORY_STRUCTURE_RULE = Object.freeze({
  sections: ["Nutzerziel", "Akzeptanzkriterien", "Definition of Done"],
  parent: true,
});

/** The Story template of the work project: its sections, and the epic link the lead requires. */
export const storyTemplateMarkdown = (project, epicLinkFieldId) =>
  templateMarkdown({
    project,
    issueType: "Story",
    rule: STORY_STRUCTURE_RULE,
    parentField: epicLinkFieldId,
  });

/** The Sub-task template of the work project; `parentIssueTypes` names the types it may hang under. */
export const subtaskTemplateMarkdown = (project, parentIssueTypes = ["Task"]) =>
  templateMarkdown({
    project,
    issueType: "Sub-task",
    rule: STRUCTURE_RULES.Task,
    parentField: "parent",
    parentIssueTypes,
  });

/** The issue types whose templates the limit run installs for its work project. */
const LIMIT_TEMPLATE_TYPES = Object.freeze(["Epic", "Task", "Bug", "Sub-task"]);

function limitTemplateMarkdown(project, issueType, epicLinkFieldId) {
  if (issueType === "Epic") return epicTemplateMarkdown(project, REQUIREMENT_EPIC_SUMMARY_PATTERN);
  if (issueType === "Sub-task") return subtaskTemplateMarkdown(project, ["Task"]);
  return templateMarkdown({
    project,
    issueType,
    rule: STRUCTURE_RULES[issueType],
    parentField: epicLinkFieldId,
    requiredFields: issueType === "Bug" ? ["priority"] : [],
  });
}

/**
 * The four templates the limit run installs for its work project, as the lead defines them. The
 * Epic rule is the golden Lastenheft one, so every correctly traced golden Epic can meet it.
 */
export function limitTemplateDefinitions(project, epicLinkFieldId) {
  return LIMIT_TEMPLATE_TYPES.map((issueType) => {
    const subtask = issueType === "Sub-task";
    const parentIssueTypes = subtask ? ["Task"] : undefined;
    return {
      issueType,
      markdown: limitTemplateMarkdown(project, issueType, epicLinkFieldId),
      formal: { project, issueType, ...(subtask ? { parentIssueTypes } : {}) },
    };
  });
}

/**
 * The templates a lead defines for the report project before judging its compliance (S11): the
 * epic template of the work project, a task template that requires the epic link and, where
 * the instance offers one, the estimate field, and a bug template that requires the epic link.
 */
export function complianceTemplates(project, fieldIds) {
  return [
    { name: `${project}-Epic`, markdown: epicTemplateMarkdown(project) },
    {
      name: `${project}-Task`,
      markdown: templateMarkdown({
        project,
        issueType: "Task",
        rule: STRUCTURE_RULES.Task,
        parentField: fieldIds.epicLink,
        requiredFields: fieldIds.storyPoints === undefined ? [] : [fieldIds.storyPoints],
      }),
    },
    // The seed gives bugs a parent deviation (three bugs without an epic link), so the project lead
    // defines a bug template too; without it the report checks no bug and S11 expected three
    // deviations no template could raise.
    {
      name: `${project}-Bug`,
      markdown: templateMarkdown({
        project,
        issueType: "Bug",
        rule: STRUCTURE_RULES.Bug,
        parentField: fieldIds.epicLink,
      }),
    },
  ];
}

const EPIC_SUMMARY = /^\[(LH-\d{3})\] \S/;

/** Whether an epic read from Jira satisfies the epic template, judged by the lab's own rules. */
export function epicTemplateConforms(issue) {
  const id = EPIC_SUMMARY.exec(issue.fields.summary ?? "")?.[1];
  return id !== undefined && epicConforms(issue, id);
}

// ---------- the product's skill-library routes ----------

const FILE_PREFIX = "Vorlage";

/** Imports a template skill and returns its identity (`id`, `revision`, `digest`). */
async function defineTemplate(http, markdown, name) {
  const { skill } = await http("template-import", "/api/skills", {
    fileName: `${FILE_PREFIX}-${name}.md`,
    contentBase64: Buffer.from(markdown).toString("base64"),
  });
  return skill;
}

/** Deletes a template skill at the revision the import returned. */
export async function removeTemplate(http, skill) {
  await http(
    "template-delete",
    `/api/skills/${encodeURIComponent(skill.id)}`,
    { expectedRevision: skill.revision },
    "DELETE",
  );
}

/** Defines every template for the duration of `body`, removing each one afterwards. */
export function withTemplates(http, templates, body) {
  const [first, ...rest] = templates;
  if (first === undefined) return body();
  return withTemplate(http, first.markdown, first.name, () => withTemplates(http, rest, body));
}

export const listTemplates = async (http) =>
  (await http("template-list", "/api/skills/jira-templates", undefined, "GET")).templates;

export const validateTemplate = (http, markdown, podId) =>
  http("template-validate", "/api/skills/jira-templates/validate", { markdown, podId });

export const proposeTemplates = async (http, projectKey, podId) =>
  (await http("template-propose", "/api/skills/jira-templates/propose", { projectKey, podId }))
    .proposals;

/**
 * Defines a template for the duration of `body` and removes it afterwards, so a template never
 * outlives its journey in the retained state (it would govern every later write of the project).
 */
export async function withTemplate(http, markdown, name, body) {
  const skill = await defineTemplate(http, markdown, name);
  try {
    return await body(skill);
  } finally {
    await removeTemplate(http, skill).catch((error) => {
      console.log(
        JSON.stringify({
          operation: "requirements-template-cleanup",
          error: String(error.message),
        }),
      );
    });
  }
}

// ---------- S01 / S02: definition, activation, proposal ----------

/**
 * What the library reports for a defined template: listed, parseable, bound to the project and
 * issue type, and activated on `create` (the front matter's `activateOn`; the library holds no
 * second activation switch, a valid template is active).
 */
export function gradeTemplateListing(templates, skill, { project, issueType }) {
  const entry = (templates ?? []).find((item) => item.id === skill.id);
  const bound =
    entry?.valid === true &&
    entry.project?.toUpperCase() === project.toUpperCase() &&
    entry.issueType?.toLowerCase() === issueType.toLowerCase();
  return {
    defined: bound,
    activated: bound && Array.isArray(entry.activations) && entry.activations.includes("create"),
  };
}

/** The instance check of a template: parseable, nothing the instance contradicts, Jira was read. */
export function gradeTemplateValidation(validation) {
  const ok =
    isRecord(validation) &&
    validation.valid === true &&
    Array.isArray(validation.findings) &&
    validation.findings.length === 0 &&
    validation.checked?.project === true;
  return {
    ok,
    findings: Array.isArray(validation?.findings) ? validation.findings.length : undefined,
  };
}

/** Section titles of a proposed template's body, in document order (`## Title` headings). */
export function proposedSections(markdown) {
  return [...markdown.matchAll(/^## +(.+?) *$/gm)].map((match) => match[1].trim());
}

/**
 * Whether a proposal for `issueType` reproduces the description sections the project's existing
 * issues of that type carry (the seeded ground truth of the lab's structure rules) and was drawn
 * from at least one existing issue.
 */
export function gradeProposal(proposals, issueType) {
  const proposal = (proposals ?? []).find(
    (item) => item.issueType?.toLowerCase() === issueType.toLowerCase(),
  );
  const expected = new Set(STRUCTURE_RULES[issueType].sections.map((name) => name.toLowerCase()));
  const found = new Set(
    proposal ? proposedSections(proposal.markdown).map((s) => s.toLowerCase()) : [],
  );
  return {
    issueType,
    ok: proposal !== undefined && proposal.sampledIssueCount > 0 && sameSet(expected, found),
    missing: [...expected].filter((name) => !found.has(name)),
    surplus: [...found].filter((name) => !expected.has(name)),
  };
}

// ---------- S06: refusals before any write ----------

/** Template rules that say the content is wrong, as opposed to the library being unreadable. */
const CONTENT_RULES = new Set([
  "summary-too-short",
  "summary-too-long",
  "summary-pattern",
  "section-missing",
  "section-empty",
  "field-missing",
  "field-unavailable",
  "label-missing",
  "label-pattern",
  "label-count",
  "parent-missing",
]);

const violationsIn = (value) =>
  (Array.isArray(value) ? value : []).filter(
    (item) => isRecord(item) && typeof item.ruleId === "string",
  );

/** The refusal an exchange carries: a `jira.create` rejection or the failed items of a draft. */
function refusalOf(exchange, index) {
  if (toolExchangeOf(exchange, "jira.create")) {
    const data = exchange.result.data;
    const violations = data?.reason === "field-validation" ? violationsIn(data.violations) : [];
    return violations.length === 0
      ? []
      : [{ index, violations, receipt: typeof data.issueKey === "string" }];
  }
  if (!toolExchangeOf(exchange, "jira.draft")) return [];
  const items = Array.isArray(exchange.result.data?.items) ? exchange.result.data.items : [];
  return items
    .filter((item) => isRecord(item) && item.state === "failed")
    .map((item) => ({
      index,
      violations: violationsIn(item.detail?.violations),
      receipt: typeof item.issueKey === "string",
    }))
    .filter((refusal) => refusal.violations.length > 0);
}

/** Every template refusal of the turn with its position, the violations and a receipt, if any. */
export function templateRefusals(exchanges) {
  return (Array.isArray(exchanges) ? exchanges : []).flatMap((exchange, index) =>
    refusalOf(exchange, index),
  );
}

/**
 * Every `jira.edit` the gate refused with template violations (the same structured rejection a
 * create carries). An edit that failed for another reason carries no violation and is not listed.
 */
export function editRefusals(exchanges) {
  return (Array.isArray(exchanges) ? exchanges : []).flatMap((exchange, index) => {
    if (!toolExchangeOf(exchange, "jira.edit")) return [];
    const data = exchange.result.data;
    const violations = data?.outcome === "rejected" ? violationsIn(data.violations) : [];
    return violations.length === 0 ? [] : [{ index, violations }];
  });
}

/**
 * Every succeeded `jira.edit` with the template notices it carried: the rules an issue already
 * broke in fields the edit did not touch (the product's closed account, never its wording).
 */
export function succeededEdits(exchanges) {
  return (Array.isArray(exchanges) ? exchanges : [])
    .filter(
      (exchange) =>
        toolExchangeOf(exchange, "jira.edit") && exchange.result.data?.outcome === "succeeded",
    )
    .map((exchange) => ({ notices: violationsIn(exchange.result.data?.templateNotices) }));
}

/** Whether an exchange wrote an issue: a succeeded create or a draft item in state created. */
export function wroteIssue(exchange) {
  if (completedToolExchange(exchange, "jira.create"))
    return exchange.result.data?.outcome === "succeeded";
  const items = toolExchangeOf(exchange, "jira.draft") ? exchange.result.data?.items : [];
  return (Array.isArray(items) ? items : []).some(
    (item) => isRecord(item) && item.state === "created",
  );
}

/**
 * Grades the repair of a template refusal. Detected: a refusal of the turn names a content rule
 * of `template` (the `PROJECT/Issue type` the violation reports). Repaired before write: no
 * refusal carries a receipt, an issue was written after the first refusal, and every issue the
 * turn produced satisfies the template as Jira holds it, so the violating content never persisted.
 */
export function gradeTemplateRepair({
  exchanges,
  issues,
  template,
  // The lab's own conformity rule for the template's issue type; Epic unless a lane names another.
  conforms = epicTemplateConforms,
}) {
  const refusals = templateRefusals(exchanges);
  const violations = refusals.flatMap((refusal) => refusal.violations);
  const content = violations.filter(
    (item) =>
      CONTENT_RULES.has(item.ruleId) && item.template?.toLowerCase() === template.toLowerCase(),
  );
  const first = refusals[0]?.index;
  const writtenAfter =
    first !== undefined &&
    (Array.isArray(exchanges) ? exchanges : [])
      .slice(first + 1)
      .some((exchange) => wroteIssue(exchange));
  const nonconforming = issues.filter((issue) => !conforms(issue));
  return {
    detected: content.length > 0,
    ruleIds: [...new Set(content.map((item) => item.ruleId))],
    refusals: refusals.length,
    receipts: refusals.filter((refusal) => refusal.receipt).length,
    writtenAfter,
    issues: issues.length,
    nonconforming: nonconforming.map((issue) => issue.key),
    repaired:
      content.length > 0 &&
      writtenAfter &&
      issues.length > 0 &&
      nonconforming.length === 0 &&
      refusals.every((refusal) => !refusal.receipt),
  };
}
