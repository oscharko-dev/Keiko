import {
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  compileJiraTemplatePattern,
  jiraIssueTemplateLabel,
  normalizeJiraSectionHeading,
  type JiraIssueTemplate,
  type JiraTemplateActivation,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * The single pure template checker (#4177). Write admission (create, edit, transition), the
 * backlog draft and the compliance report call this one function over the same subject shape, so
 * a draft and the write that follows can never disagree. It performs no I/O and never throws on
 * hostile input: the subject is the post-write state, the output is closed ids plus short names.
 */
export interface JiraTemplateSubject {
  readonly operation: "create" | "edit" | "transition";
  readonly projectKey: string;
  readonly issueType: { readonly id?: string; readonly name: string };
  readonly transition?: {
    readonly id: string;
    readonly name?: string;
    readonly targetStatusName?: string;
  };
  /** The state after the write, by Jira field id (wire values). */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Names of the link types the issue carries; only meaningful for edit and transition. */
  readonly linkTypes?: readonly string[] | undefined;
}

export interface JiraFieldCatalogEntry {
  readonly id: string;
  readonly name: string;
}

const MATCH_INPUT_MAX = 1024;
const PLACEHOLDER = /^(?:tbd|tba|todo|\.{3}|…|-|<[^<>]*>)$/iu;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const WIKI_HEADING = /^\s*h[1-6]\.[ \t]+(.+?)[ \t]*$/u;
const VALUE_KEYS = ["name", "value", "key", "displayName", "id"] as const;

function same(left: string | undefined, right: string): boolean {
  return left?.trim().toLowerCase() === right.trim().toLowerCase();
}

function scalarText(candidate: unknown): string {
  if (typeof candidate === "string") return candidate.trim().length > 0 ? candidate : "";
  return typeof candidate === "number" ? String(candidate) : "";
}

/** Text a Jira wire value carries; empty for anything that has no readable identity. */
export function jiraTemplateValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (Array.isArray(value)) return value.map(jiraTemplateValueText).join(" ").trim();
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  return VALUE_KEYS.map((key) => scalarText(record[key])).find((text) => text !== "") ?? "";
}

export function jiraTemplateValuePresent(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return jiraTemplateValueText(value).trim().length > 0;
}

function activationMatches(
  activation: JiraTemplateActivation,
  subject: JiraTemplateSubject,
): boolean {
  if (activation.kind !== subject.operation) return false;
  if (activation.kind !== "transition" || activation.target === undefined) return true;
  const { target } = activation;
  const transition = subject.transition;
  return (
    transition !== undefined &&
    (transition.id === target ||
      same(transition.name, target) ||
      same(transition.targetStatusName, target))
  );
}

function issueTypeMatches(template: JiraIssueTemplate, subject: JiraTemplateSubject): boolean {
  return (
    same(subject.issueType.name, template.issueType) ||
    (subject.issueType.id !== undefined && subject.issueType.id === template.issueType)
  );
}

/** The templates that govern this write: same project and issue type, activated at this point. */
export function matchingJiraIssueTemplates(
  templates: readonly JiraIssueTemplate[],
  subject: JiraTemplateSubject,
): readonly JiraIssueTemplate[] {
  return templates.filter(
    (template) =>
      same(subject.projectKey, template.project) &&
      issueTypeMatches(template, subject) &&
      template.activations.some((activation) => activationMatches(activation, subject)),
  );
}

/** Ids a template reference names: an exact field id first, otherwise every same-named field. */
export function resolveJiraTemplateFieldIds(
  reference: string,
  catalog: readonly JiraFieldCatalogEntry[],
): readonly string[] {
  const exact = catalog.filter((entry) => entry.id === reference);
  if (exact.length > 0) return exact.map((entry) => entry.id);
  return catalog.filter((entry) => same(entry.name, reference)).map((entry) => entry.id);
}

function sectionBodies(description: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  for (const line of description.replace(/\r\n?/gu, "\n").split("\n")) {
    const heading = MARKDOWN_HEADING.exec(line) ?? WIKI_HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      current = normalizeJiraSectionHeading(heading[1]);
      if (!sections.has(current)) sections.set(current, "");
    } else if (current !== undefined) {
      sections.set(current, `${sections.get(current) ?? ""}\n${line}`);
    }
  }
  return sections;
}

function sectionHasContent(body: string): boolean {
  return body
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !PLACEHOLDER.test(line));
}

interface Context {
  readonly template: JiraIssueTemplate;
  readonly subject: JiraTemplateSubject;
  readonly catalog: readonly JiraFieldCatalogEntry[];
  readonly out: JiraTemplateViolation[];
}

function raise(context: Context, ruleId: JiraTemplateViolation["ruleId"], subject: string): void {
  context.out.push({
    ruleId,
    subject: subject.slice(0, 120),
    template: jiraIssueTemplateLabel(context.template),
  });
}

function textOf(context: Context, id: string): string {
  return jiraTemplateValueText(context.subject.fields[id]);
}

function matchesPattern(pattern: string, value: string): boolean {
  // A parsed template's pattern always compiles; a hand-built unsafe one throws, and the
  // executor's correlated diagnostic records it while the write stays unsent.
  return compileJiraTemplatePattern(pattern).test(value.slice(0, MATCH_INPUT_MAX));
}

function checkSummary(context: Context): void {
  const rules = context.template.summary;
  const summary = textOf(context, "summary").trim();
  if (rules.minLength !== undefined && summary.length < rules.minLength)
    raise(context, "summary-too-short", `at least ${String(rules.minLength)} characters`);
  if (rules.maxLength !== undefined && summary.length > rules.maxLength)
    raise(context, "summary-too-long", `at most ${String(rules.maxLength)} characters`);
  if (rules.pattern !== undefined && !matchesPattern(rules.pattern, summary))
    raise(context, "summary-pattern", rules.pattern);
}

function checkSections(context: Context): void {
  const bodies = sectionBodies(textOf(context, "description"));
  for (const section of context.template.requiredSections) {
    const body = bodies.get(normalizeJiraSectionHeading(section));
    if (body === undefined) raise(context, "section-missing", section);
    else if (!sectionHasContent(body)) raise(context, "section-empty", section);
  }
}

function fieldPresent(context: Context, reference: string): boolean | undefined {
  const ids = resolveJiraTemplateFieldIds(reference, context.catalog);
  if (ids.length === 0) return undefined;
  return ids.some((id) => jiraTemplateValuePresent(context.subject.fields[id]));
}

function checkFields(context: Context): void {
  for (const field of context.template.requiredFields) {
    const present = fieldPresent(context, field);
    if (present === undefined) raise(context, "field-unavailable", field);
    else if (!present) raise(context, "field-missing", field);
  }
  const parent = context.template.parent;
  if (parent.field !== undefined) {
    const present = fieldPresent(context, parent.field);
    if (present !== true) raise(context, "parent-missing", parent.field);
  }
  if (parent.link !== undefined) {
    const links = context.subject.linkTypes ?? [];
    if (!links.some((name) => same(name, parent.link ?? ""))) {
      raise(context, "parent-missing", parent.link);
    }
  }
}

function labelsOf(context: Context): readonly string[] {
  const value = context.subject.fields.labels;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function checkLabels(context: Context): void {
  const rules = context.template.labels;
  const labels = labelsOf(context);
  for (const required of rules.required) {
    if (!labels.some((label) => same(label, required))) raise(context, "label-missing", required);
  }
  if (rules.minCount !== undefined && labels.length < rules.minCount)
    raise(context, "label-count", `at least ${String(rules.minCount)} labels`);
  if (rules.pattern === undefined) return;
  for (const label of labels) {
    if (!matchesPattern(rules.pattern, label)) raise(context, "label-pattern", label);
  }
}

/** Every violation of one template, in a stable rule order. */
export function checkJiraIssueTemplate(
  template: JiraIssueTemplate,
  subject: JiraTemplateSubject,
  catalog: readonly JiraFieldCatalogEntry[],
): readonly JiraTemplateViolation[] {
  const context: Context = { template, subject, catalog, out: [] };
  checkSummary(context);
  checkSections(context);
  checkFields(context);
  checkLabels(context);
  return context.out;
}

/** All violations of every governing template; bounded so a refusal stays small. */
export function checkJiraIssueTemplates(
  templates: readonly JiraIssueTemplate[],
  subject: JiraTemplateSubject,
  catalog: readonly JiraFieldCatalogEntry[],
): readonly JiraTemplateViolation[] {
  const seen = new Set<string>();
  const violations: JiraTemplateViolation[] = [];
  for (const template of matchingJiraIssueTemplates(templates, subject)) {
    for (const violation of checkJiraIssueTemplate(template, subject, catalog)) {
      const id = `${violation.template}|${violation.ruleId}|${violation.subject}`;
      if (seen.has(id)) continue;
      seen.add(id);
      violations.push(violation);
    }
  }
  return violations.slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX);
}

export const JIRA_TEMPLATE_FINDING_CODES = [
  "unknown-project",
  "unknown-issue-type",
  "unknown-field",
  "ambiguous-field",
  "unknown-link-type",
  "unknown-transition-target",
] as const;
export type JiraTemplateFindingCode = (typeof JIRA_TEMPLATE_FINDING_CODES)[number];
export interface JiraTemplateFinding {
  readonly code: JiraTemplateFindingCode;
  readonly subject: string;
}

/** Live instance facts a template is validated against. `undefined` means "not read". */
export interface JiraTemplateInstanceMetadata {
  /** Absent when the instance's field list could not be read; field findings are then skipped. */
  readonly fields?: readonly JiraFieldCatalogEntry[];
  readonly linkTypes?: readonly {
    readonly name: string;
    readonly inward?: string;
    readonly outward?: string;
  }[];
  /** The project as the instance reports it; absent when the project key is unknown. */
  readonly project?: {
    readonly key: string;
    readonly issueTypes: readonly { readonly id: string; readonly name: string }[];
  };
  /** Status names of the project's workflows, for transition targets. */
  readonly statuses?: readonly string[];
}

function fieldFindings(
  template: JiraIssueTemplate,
  catalog: readonly JiraFieldCatalogEntry[],
): readonly JiraTemplateFinding[] {
  const references = [
    ...template.requiredFields,
    ...(template.parent.field === undefined ? [] : [template.parent.field]),
  ];
  return references.flatMap((reference): readonly JiraTemplateFinding[] => {
    const ids = resolveJiraTemplateFieldIds(reference, catalog);
    if (ids.length === 0) return [{ code: "unknown-field", subject: reference }];
    const exact = catalog.some((entry) => entry.id === reference);
    return ids.length > 1 && !exact ? [{ code: "ambiguous-field", subject: reference }] : [];
  });
}

function linkFindings(
  template: JiraIssueTemplate,
  instance: JiraTemplateInstanceMetadata,
): readonly JiraTemplateFinding[] {
  const link = template.parent.link;
  if (link === undefined || instance.linkTypes === undefined) return [];
  const known = instance.linkTypes.some(
    (type) => same(type.name, link) || same(type.inward, link) || same(type.outward, link),
  );
  return known ? [] : [{ code: "unknown-link-type", subject: link }];
}

function transitionFindings(
  template: JiraIssueTemplate,
  instance: JiraTemplateInstanceMetadata,
): readonly JiraTemplateFinding[] {
  const statuses = instance.statuses;
  if (statuses === undefined) return [];
  return template.activations.flatMap((activation): readonly JiraTemplateFinding[] => {
    if (activation.kind !== "transition" || activation.target === undefined) return [];
    const { target } = activation;
    return statuses.some((status) => same(status, target))
      ? []
      : [{ code: "unknown-transition-target", subject: target }];
  });
}

function projectFindings(
  template: JiraIssueTemplate,
  instance: JiraTemplateInstanceMetadata,
): readonly JiraTemplateFinding[] {
  const project = instance.project;
  if (project === undefined) return [{ code: "unknown-project", subject: template.project }];
  const known = project.issueTypes.some(
    (type) => same(type.name, template.issueType) || type.id === template.issueType,
  );
  return known ? [] : [{ code: "unknown-issue-type", subject: template.issueType }];
}

/**
 * Validates a template against the live instance: unknown project, issue type, fields, link types
 * and transition targets. A finding does not block saving; an unknown field makes every write it
 * governs fail with `field-unavailable`, so the lead sees it before a model does.
 */
export function validateJiraIssueTemplateAgainstInstance(
  template: JiraIssueTemplate,
  instance: JiraTemplateInstanceMetadata,
): readonly JiraTemplateFinding[] {
  return [
    ...projectFindings(template, instance),
    ...(instance.fields === undefined ? [] : fieldFindings(template, instance.fields)),
    ...linkFindings(template, instance),
    ...transitionFindings(template, instance),
  ];
}
