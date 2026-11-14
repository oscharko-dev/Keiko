import {
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  compileJiraTemplatePattern,
  jiraIssueTemplateLabel,
  normalizeJiraSectionHeading,
  readJiraDescriptionSections,
  projectJiraDescriptionInput,
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
  /** Independently read parent types, keyed by the resolved parent field ID; never input facts. */
  readonly parentIssueTypes?: Readonly<
    Record<string, { readonly id: string; readonly name: string }>
  >;
}

export interface JiraFieldCatalogEntry {
  readonly id: string;
  readonly name: string;
  /** Jira's custom field type (`schema.custom`) when the instance declares one; never an identity. */
  readonly schemaCustom?: string;
}

/** A Jira summary and a label are at most 255 characters; a longer text never reaches a pattern. */
const MATCH_INPUT_MAX = 255;
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

/** Nesting beyond this is a value, not an empty one: Jira's own composite values are shallow. */
const PRESENCE_DEPTH_MAX = 8;
/**
 * Whether a field holds a value, which is not the same as having a displayable identity: a time
 * tracking value (`{ originalEstimate: "1h" }`) or any other composite Jira value has content
 * although it carries no name, key or id. Empty text, null, an empty array and an object with no
 * present member are the empty values.
 */
function presentAt(value: unknown, depth: number): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value !== "object" || value === null) return false;
  if (depth >= PRESENCE_DEPTH_MAX) return true;
  const members: readonly unknown[] = Array.isArray(value)
    ? (value as readonly unknown[])
    : Object.values(value);
  return members.some((member) => presentAt(member, depth + 1));
}
export function jiraTemplateValuePresent(value: unknown): boolean {
  return presentAt(value, 0);
}

function activationMatches(
  activation: JiraTemplateActivation,
  subject: JiraTemplateSubject,
): boolean {
  // A plain activation governs creating and editing; it never governs a transition (#4354).
  if (activation.kind !== "transition") return subject.operation !== "transition";
  if (subject.operation !== "transition" || activation.target === undefined)
    return subject.operation === "transition";
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

/**
 * Templates of this project and issue type that name a transition (or its target status) the
 * write's metadata cannot be compared with: Jira reported no transition or status name. Such a
 * template could govern the write, so the gate refuses instead of passing it unchecked.
 */
export function jiraTemplatesNeedingTransitionNames(
  templates: readonly JiraIssueTemplate[],
  subject: JiraTemplateSubject,
): readonly JiraIssueTemplate[] {
  const { transition } = subject;
  if (subject.operation !== "transition" || transition === undefined) return [];
  if (transition.name !== undefined && transition.targetStatusName !== undefined) return [];
  return templates.filter(
    (template) =>
      same(subject.projectKey, template.project) &&
      issueTypeMatches(template, subject) &&
      template.activations.some(
        (activation) =>
          activation.kind === "transition" &&
          activation.target !== undefined &&
          !activationMatches(activation, subject),
      ),
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

/**
 * Section content of the projected Jira wire text. A native numbered list is not a heading;
 * explicitly tagged Markdown has already been serialized to native wiki headings.
 */
function sectionContent(description: string): ReadonlyMap<string, boolean> {
  const sections = new Map<string, boolean>();
  for (const section of readJiraDescriptionSections(description, "jira-wiki")) {
    const key = normalizeJiraSectionHeading(section.title);
    sections.set(key, (sections.get(key) ?? false) || section.hasContent);
  }
  return sections;
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
  return jiraTemplateValueText(fieldValue(context, id));
}
function fieldValue(context: Context, id: string): unknown {
  const value = context.subject.fields[id];
  return id === "description" ? (projectJiraDescriptionInput(value)?.text ?? value) : value;
}

function matchesPattern(pattern: string, value: string): boolean {
  // A parsed template's pattern is always matchable; a hand-built unsafe one throws, and the
  // executor's correlated diagnostic records it while the write stays unsent. The matcher is
  // an automaton simulation, so no pattern or text makes it slow.
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
  const sections = sectionContent(textOf(context, "description"));
  for (const section of context.template.requiredSections) {
    const hasContent = sections.get(normalizeJiraSectionHeading(section));
    if (hasContent === undefined) raise(context, "section-missing", section);
    else if (!hasContent) raise(context, "section-empty", section);
  }
}

function fieldPresent(context: Context, reference: string): boolean | undefined {
  const ids = resolveJiraTemplateFieldIds(reference, context.catalog);
  if (ids.length === 0) return undefined;
  return ids.some((id) => jiraTemplateValuePresent(fieldValue(context, id)));
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

function checkParentType(context: Context): void {
  const { field, issueTypes } = context.template.parent;
  if (issueTypes === undefined) return;
  if (field === undefined || issueTypes.length === 0) {
    raise(context, "template-unreadable", "parentIssueTypes");
    return;
  }
  // Ordinary presence errors remain distinct; a supplied parent requires independent type proof.
  if (fieldPresent(context, field) !== true) return;
  const observed = observedParentType(context, field);
  if (observed === undefined) raise(context, "template-unreadable", field);
  else if (!issueTypes.some((type) => type === observed.id || same(observed.name, type)))
    raise(
      context,
      "parent-type-mismatch",
      `${field}: ${issueTypes.join(", ")} (found: ${observed.name.slice(0, 60)})`,
    );
}

function observedParentType(
  context: Context,
  field: string,
): { readonly id: string; readonly name: string } | undefined {
  const ids = resolveJiraTemplateFieldIds(field, context.catalog);
  const id = ids.length === 1 ? ids[0] : undefined;
  const evidence = context.subject.parentIssueTypes;
  return id !== undefined && evidence !== undefined && Object.hasOwn(evidence, id)
    ? evidence[id]
    : undefined;
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
  checkParentType(context);
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

/** The one wire field a rule is about, when the rule id alone names it. */
const FIXED_RULE_FIELD: Readonly<Partial<Record<JiraTemplateViolation["ruleId"], string>>> = {
  "summary-too-short": "summary",
  "summary-too-long": "summary",
  "summary-pattern": "summary",
  "section-missing": "description",
  "section-empty": "description",
  "label-missing": "labels",
  "label-pattern": "labels",
  "label-count": "labels",
};
function parentFieldIds(
  violation: JiraTemplateViolation,
  catalog: readonly JiraFieldCatalogEntry[],
): ReadonlySet<string> {
  const field = violation.subject.split(":")[0]?.trim() ?? "";
  return new Set(["parent", "issuelinks", field, ...resolveJiraTemplateFieldIds(field, catalog)]);
}
/** The wire field ids a violation is about; an empty result means it is not about one field. */
function violationFieldIds(
  violation: JiraTemplateViolation,
  catalog: readonly JiraFieldCatalogEntry[],
): ReadonlySet<string> {
  const fixed = FIXED_RULE_FIELD[violation.ruleId];
  if (fixed !== undefined) return new Set([fixed]);
  if (violation.ruleId === "parent-missing" || violation.ruleId === "parent-type-mismatch")
    return parentFieldIds(violation, catalog);
  return new Set([violation.subject, ...resolveJiraTemplateFieldIds(violation.subject, catalog)]);
}

const violationId = (violation: JiraTemplateViolation): string =>
  `${violation.template}|${violation.ruleId}|${violation.subject}`;

/**
 * What a write may leave behind, judged on one before-state and one after-state (#4354).
 * Creation and transitions are judged on the after-state alone: everything must conform. An edit must
 * not make things worse: a violation that is new, or that lies in a field the edit touches, blocks it;
 * a violation that already existed in an untouched field does not block and is returned as a notice.
 */
export function evaluateJiraTemplateChange(input: {
  readonly templates: readonly JiraIssueTemplate[];
  readonly after: JiraTemplateSubject;
  /** The state before an edit; absent for creation and transition, where the after-state decides. */
  readonly before: JiraTemplateSubject | undefined;
  /** Wire field ids the write sets; labels and links count as `labels` and `issuelinks`. */
  readonly touched: ReadonlySet<string>;
  readonly catalog: readonly JiraFieldCatalogEntry[];
}): {
  readonly blocking: readonly JiraTemplateViolation[];
  readonly notices: readonly JiraTemplateViolation[];
} {
  const after = checkJiraIssueTemplates(input.templates, input.after, input.catalog);
  if (input.before === undefined || after.length === 0) return { blocking: after, notices: [] };
  const existing = new Set(
    checkJiraIssueTemplates(input.templates, input.before, input.catalog).map(violationId),
  );
  const blocking: JiraTemplateViolation[] = [];
  const notices: JiraTemplateViolation[] = [];
  for (const violation of after) {
    const about = violationFieldIds(violation, input.catalog);
    const touches =
      violation.ruleId === "template-unreadable" || [...about].some((id) => input.touched.has(id));
    (existing.has(violationId(violation)) && !touches ? notices : blocking).push(violation);
  }
  return { blocking, notices };
}

export const JIRA_TEMPLATE_FINDING_CODES = [
  "unknown-project",
  "unknown-issue-type",
  "unknown-field",
  "ambiguous-field",
  "unknown-link-type",
  "unknown-transition-target",
  "wrong-parent-field",
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
    readonly issueTypes: readonly {
      readonly id: string;
      readonly name: string;
      /** Jira's own flag for a sub-task type; absent when the instance did not state it. */
      readonly subtask?: boolean;
    }[];
  };
  /** Status names of the project's workflows, for transition targets. */
  readonly statuses?: readonly string[];
  /** Global native type names/IDs, read only when a parent-type clause needs validation. */
  readonly parentIssueTypes?: readonly { readonly id: string; readonly name: string }[];
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
    ...parentTypeFindings(template, instance),
    ...parentRelationFindings(template, instance),
  ];
}

const EPIC_LINK_TYPE = "com.pyxis.greenhopper.jira:gh-epic-link";
const PARENT_LINK_TYPE = "com.atlassian.jpo:jpo-custom-field-parent";
const SYSTEM_PARENT = "parent";

function declaredIssueType(
  template: JiraIssueTemplate,
  instance: JiraTemplateInstanceMetadata,
): { readonly name: string; readonly subtask: boolean } | undefined {
  const found = instance.project?.issueTypes.find(
    (type) => type.id === template.issueType || same(type.name, template.issueType),
  );
  return found?.subtask === undefined ? undefined : { name: found.name, subtask: found.subtask };
}

/**
 * What the instance says about the parent relation of the template's own issue type: a sub-task is
 * linked to its parent by the system `parent` field, a task or story to its epic by the Epic Link,
 * and only an Epic is linked to an initiative by the Parent Link. A template whose parent field is
 * a relation field known to belong to another kind of issue can never be satisfied: it matched
 * "Jira" while every write it governs would be refused (#4354). Only a field whose kind the
 * instance states is judged; an unknown project, type or field kind says nothing.
 */
function parentRelationFindings(
  template: JiraIssueTemplate,
  instance: JiraTemplateInstanceMetadata,
): readonly JiraTemplateFinding[] {
  const reference = template.parent.field;
  const type = declaredIssueType(template, instance);
  if (reference === undefined || type === undefined || instance.fields === undefined) return [];
  const ids = resolveJiraTemplateFieldIds(reference, instance.fields);
  const named = ids.length === 1 ? instance.fields.find((entry) => entry.id === ids[0]) : undefined;
  if (named === undefined) return [];
  const actual = actualParentField(type, instance.fields);
  if (actual === undefined || named.id === actual.id) return [];
  return isForeignRelationField(type, named)
    ? [
        {
          code: "wrong-parent-field",
          subject: `${reference} instead of ${actual.name} (${actual.id})`,
        },
      ]
    : [];
}
/** A relation field the instance declares to belong to another kind of issue than this type. */
function isForeignRelationField(
  type: { readonly subtask: boolean },
  named: JiraFieldCatalogEntry,
): boolean {
  if (named.schemaCustom === PARENT_LINK_TYPE) return true;
  return named.schemaCustom === EPIC_LINK_TYPE && type.subtask;
}

function actualParentField(
  type: { readonly name: string; readonly subtask: boolean },
  fields: readonly JiraFieldCatalogEntry[],
): JiraFieldCatalogEntry | undefined {
  if (type.subtask) return fields.find((entry) => entry.id === SYSTEM_PARENT);
  if (same(type.name, "epic")) return undefined;
  return fields.find((entry) => entry.schemaCustom === EPIC_LINK_TYPE);
}

function parentTypeFindings(
  template: JiraIssueTemplate,
  instance: JiraTemplateInstanceMetadata,
): readonly JiraTemplateFinding[] {
  return (template.parent.issueTypes ?? []).flatMap((reference): readonly JiraTemplateFinding[] =>
    instance.parentIssueTypes?.some((type) => type.id === reference || same(type.name, reference))
      ? []
      : [{ code: "unknown-issue-type", subject: `parentIssueTypes: ${reference}` }],
  );
}

/**
 * A write no template governs is not fixed by correcting it: the person needs a template first.
 * The words name the way out the product already has (propose a template from an existing project)
 * and forbid a retry that cannot succeed.
 */
export function jiraNoGoverningTemplateGuidance(
  violation: Pick<JiraTemplateViolation, "ruleId">,
  /** One further fixed sentence, for a case the caller has observed and this owner cannot (for example that stored templates name another project). */
  observed?: string,
): string {
  const only =
    violation.ruleId === "template-not-activated"
      ? " Templates exist for it, but only for entering a status, which does not govern creating an issue."
      : "";
  const further = observed === undefined ? "" : ` ${observed}`;
  return (
    `Nothing was changed: no saved issue template governs this project and issue type; the violation names them.${only}${further} ` +
    "Keiko creates an issue only when a template for its project and issue type exists. Do not retry or change the request. " +
    "Tell the person that a template for this project and issue type has to be created first, and where: " +
    "Skills, Jira template, propose templates from an existing project, review and save. Offer to write the same issue once it exists."
  );
}

const PARENT_RULES: ReadonlySet<JiraTemplateViolation["ruleId"]> = new Set([
  "parent-missing",
  "parent-type-mismatch",
]);
const SECTION_RULES: ReadonlySet<JiraTemplateViolation["ruleId"]> = new Set([
  "section-missing",
  "section-empty",
]);
/**
 * A bulk or schema change that touches a field a formal rule refers to is not "evidence we could not
 * read": the rule exists, and the issues it would change cannot be checked one by one (#4357 AC3).
 */
const IMPACT_SUBJECT =
  /^(?:Bulk issue-field impact: |Schema changes require complete governed issue migration)/u;
function isImpactViolation(violation: JiraTemplateViolation): boolean {
  return violation.ruleId === "template-unreadable" && IMPACT_SUBJECT.test(violation.subject);
}
const IMPACT_GUIDANCE =
  "Nothing was changed: a formal template rule of this project refers to a field this change would alter on issues that Keiko cannot check one by one. Do not retry it. Change the affected issues one at a time with the edit tool, or tell the person it has to be done in Jira.";
/**
 * What a rule's subject alone does not say (#4357 AC3), one short fixed sentence for the rules whose
 * violation the model cannot correct from the subject. A placeholder is exactly what the section
 * reader treats as no content.
 */
const RULE_HINTS: readonly (readonly [JiraTemplateViolation["ruleId"], string])[] = [
  [
    "section-empty",
    " A section that holds only a placeholder (TBD, TODO, ..., -, or <text>) counts as empty: write real content.",
  ],
  [
    "label-pattern",
    " A label rule has a pattern: the subject is the label that does not match it; use a label the template's labels rule allows.",
  ],
  [
    "field-unavailable",
    " A field-unavailable subject is a field this project's screen does not offer, so it cannot be set: do not retry with it, tell the person.",
  ],
];
function ruleHints(violations: readonly JiraTemplateViolation[]): string {
  return RULE_HINTS.filter(([ruleId]) =>
    violations.some((violation) => violation.ruleId === ruleId),
  )
    .map(([, hint]) => hint)
    .join("");
}
/**
 * Fixed words for a refusal that names template rules, never derived from remote text. The rule ids
 * alone do not say how a section is written, so a model would otherwise guess at its heading form.
 */
export function jiraTemplateViolationGuidance(
  violations: readonly JiraTemplateViolation[],
): string | undefined {
  if (violations.length === 0) return undefined;
  const missing = violations.find(
    (violation) =>
      violation.ruleId === "template-missing" || violation.ruleId === "template-not-activated",
  );
  if (missing !== undefined) return jiraNoGoverningTemplateGuidance(missing);
  if (violations.some(isImpactViolation)) return IMPACT_GUIDANCE;
  if (violations.some((violation) => violation.ruleId === "template-unreadable")) {
    return (
      "Nothing was changed: the formal rule or its current Jira evidence could not be read completely and bound to this issue. " +
      "Refresh the named native fields and project/issue-type metadata, or repair an unreadable formal skill, then check the corrected request again. " +
      "Missing evidence does not establish a rule violation or permission to write."
    );
  }
  const parents = violations.some((violation) => PARENT_RULES.has(violation.ruleId))
    ? " A parent rule is about the issue this one hangs under: say in plain words which parent types this" +
      " kind of issue may have, as allowed in the subject, and what type the named parent actually is," +
      " or that it needs a parent; then ask for or choose a fitting parent."
    : "";
  const sections = violations.some((violation) => SECTION_RULES.has(violation.ruleId))
    ? " A section is a line of its own, h2. Title, with its text below; subject is its title." +
      " Write the section text yourself from the request, the issue and the Chat's sources;" +
      " ask the user only for a fact neither provides."
    : "";
  return (
    "Nothing was changed: this breaks the issue template of the project. " +
    `Correct what violations name (ruleId, subject), then send it again.${parents}${sections}${ruleHints(violations)}` +
    " When you explain a refusal to the person, say in plain words what is wrong and what to change; never quote the rule id or a field id as the explanation."
  );
}
