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

/** The summary every epic of the lab starts with: `[LH-001] <title>`. */
export const EPIC_SUMMARY_PATTERN = String.raw`^\[LH-\d{3}\] \S`;

/**
 * The Markdown template a lead would write for `issueType` from the lab's structure rule: the
 * rule's description sections become the body headings, its labels the required labels, and the
 * epic summary format a summary pattern.
 */
export function templateMarkdown({ project, issueType, rule, summaryPattern }) {
  const quoted = (value) => JSON.stringify(value);
  const front = [
    "---",
    "keiko: jira-issue-template",
    "version: 1",
    `project: ${project}`,
    `issueType: ${quoted(issueType)}`,
    "activateOn: [create]",
    ...(summaryPattern === undefined ? [] : [`summaryPattern: ${quoted(summaryPattern)}`]),
    ...(rule.labels?.length > 0
      ? [`requiredLabels: [${rule.labels.map((label) => quoted(label)).join(", ")}]`]
      : []),
    "---",
  ];
  const body = rule.sections.flatMap((section) => [`## ${section}`, ""]);
  return [...front, `# Vorlage ${issueType}`, "", ...body].join("\n").trimEnd() + "\n";
}

/** The template of the lab's work project for epics. */
export const epicTemplateMarkdown = (project) =>
  templateMarkdown({
    project,
    issueType: "Epic",
    rule: STRUCTURE_RULES.Epic,
    summaryPattern: EPIC_SUMMARY_PATTERN,
  });

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
async function removeTemplate(http, skill) {
  await http(
    "template-delete",
    `/api/skills/${encodeURIComponent(skill.id)}`,
    { expectedRevision: skill.revision },
    "DELETE",
  );
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
function templateRefusals(exchanges) {
  return (Array.isArray(exchanges) ? exchanges : []).flatMap((exchange, index) =>
    refusalOf(exchange, index),
  );
}

/** Whether an exchange wrote an issue: a succeeded create or a draft item in state created. */
function wroteIssue(exchange) {
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
export function gradeTemplateRepair({ exchanges, issues, template }) {
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
  const nonconforming = issues.filter((issue) => !epicTemplateConforms(issue));
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
