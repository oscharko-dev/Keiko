import {
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  isSafeAtlassianIdentifier,
  jiraIssueTemplateLabel,
  type AtlassianConnectorWriteFailureReason,
  type JiraFieldMetadata,
  type JiraIssueTemplate,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  checkJiraIssueTemplates,
  jiraTemplatesNeedingTransitionNames,
  matchingJiraIssueTemplates,
  resolveJiraTemplateFieldIds,
  type JiraFieldCatalogEntry,
  type JiraTemplateSubject,
} from "./jira-issue-template-check.js";
import { planJiraIssueLinks, type JiraIssueLinkRequest } from "./jira-issue-links.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { parseJiraFieldMetadata } from "./jira-field-metadata.js";
import { jiraNativeText } from "./jira-native-values.js";
import { bindJiraTemplateParentTypes } from "./jira-template-parent-types.js";

/**
 * Write admission against customer-defined issue templates (#4177). One gate sits between the
 * validated field changes and the Jira POST/PUT of create, edit and transition, and the same
 * pipeline backs the dry run that Chat runs before it asks a human to approve. A write that
 * violates an active template never leaves this function as `ok`, in every autonomy mode.
 */
export interface JiraIssueTemplateSet {
  readonly templates: readonly JiraIssueTemplate[];
  /** Current private-library provenance bound to each exact parsed template, never its body. */
  readonly references?: readonly {
    readonly template: JiraIssueTemplate;
    readonly id: string;
    readonly revision: number;
    readonly digest: string;
  }[];
  /** Template documents in the library that no longer parse. They fail closed. */
  readonly unreadable: number;
  /** Display names of those documents, so the refusal tells the lead which skill to repair. */
  readonly unreadableNames?: readonly string[];
}
export type JiraIssueTemplateSource = () => JiraIssueTemplateSet;

export interface JiraTemplateGateInput {
  readonly request: JiraMutationRequest;
  readonly source: JiraIssueTemplateSource | undefined;
  readonly operation: "create" | "edit" | "transition";
  /** The create, edit or transition field metadata the write was validated against. */
  readonly metadata: readonly JiraFieldMetadata[];
  /** The write's validated Jira values: `fields` to set and label `update` operations. */
  readonly validated: {
    readonly fields: Readonly<Record<string, unknown>>;
    readonly update: Readonly<Record<string, readonly Record<string, string>[]>>;
  };
  /**
   * Links the write asks for. Jira takes one `issuelinks` operation per request, so only the link
   * that rides on the create or edit itself is evidence for a `parentLink` rule; a link written
   * afterwards never is. The result names the order that puts a required link first.
   */
  readonly links?: readonly JiraIssueLinkRequest[];
  /** Complete, independently bound relation after one native link effect; never raw model input. */
  readonly plannedIssueLinks?: readonly unknown[];
  readonly target: {
    readonly projectId?: string;
    readonly issueTypeId?: string;
    readonly issueKey?: string;
  };
  readonly transition?: {
    readonly id: string;
    readonly name?: string;
    readonly targetStatusName?: string;
  };
}
export type JiraTemplateGateResult =
  | {
      readonly ok: true;
      /** The requested links in the order the write must send them, when templates reordered them. */
      readonly links?: readonly JiraIssueLinkRequest[];
    }
  | {
      readonly ok: false;
      readonly reason: AtlassianConnectorWriteFailureReason;
      readonly violations?: readonly JiraTemplateViolation[];
    };

const OK = { ok: true } as const;
const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
const BASE_FIELDS = [
  "project",
  "issuetype",
  "status",
  "summary",
  "description",
  "labels",
  "issuelinks",
] as const;
/** System fields every Jira instance has; the report resolves template references against them too. */
export const JIRA_TEMPLATE_SYSTEM_FIELDS: readonly JiraFieldCatalogEntry[] = [
  { id: "summary", name: "Summary" },
  { id: "description", name: "Description" },
  { id: "labels", name: "Labels" },
  { id: "priority", name: "Priority" },
  { id: "assignee", name: "Assignee" },
  { id: "reporter", name: "Reporter" },
  { id: "components", name: "Component/s" },
  { id: "fixVersions", name: "Fix Version/s" },
  { id: "versions", name: "Affects Version/s" },
  { id: "duedate", name: "Due Date" },
  { id: "environment", name: "Environment" },
  { id: "parent", name: "Parent" },
];
const CATALOG_MAX = 5000;

function unreadableRefusal(names: readonly string[] | undefined): JiraTemplateGateResult {
  // Model-facing only: the activity log records the closed rule id, never a skill name.
  const subject = names === undefined || names.length === 0 ? "template library" : names.join(", ");
  return {
    ok: false,
    reason: "field-validation",
    violations: [{ ruleId: "template-unreadable", subject: subject.slice(0, 120), template: "*" }],
  };
}
function identityRefusal(
  failure: Extract<JiraTemplateGateResult, { ok: false }>,
  templates: readonly JiraIssueTemplate[],
): JiraTemplateGateResult {
  // Preserve the closed native failure, but also keep the refusal visible to the existing
  // template-only dry run. It must not reinterpret unbound rule selection as a successful check.
  return {
    ...failure,
    violations: templates.slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX).map((template) => ({
      ruleId: "template-unreadable",
      subject: "native project and issue-type identity",
      template: jiraIssueTemplateLabel(template),
    })),
  };
}

/** A template activated by a transition name or status that Jira's metadata does not name. */
function undecidableTransitionRefusal(labels: readonly string[]): JiraTemplateGateResult {
  return {
    ok: false,
    reason: "field-validation",
    violations: labels.map((template) => ({
      ruleId: "template-unreadable" as const,
      subject: "transition name",
      template,
    })),
  };
}

const NUMERIC_ID = /^\d{1,32}$/u;
function numericId(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_ID.test(value);
}

interface Identity {
  readonly issueId?: string;
  readonly projectKey: string;
  readonly issueType: { readonly id: string; readonly name: string };
  readonly prior: Readonly<Record<string, unknown>>;
}

async function createIdentity(
  request: JiraMutationRequest,
  target: JiraTemplateGateInput["target"],
): Promise<Identity | Extract<JiraTemplateGateResult, { ok: false }>> {
  const { projectId, issueTypeId } = target;
  if (!numericId(projectId) || !numericId(issueTypeId)) return MALFORMED;
  return readJiraCreateTemplateIdentity(request, projectId, issueTypeId);
}

/** The gate and create metadata resolve names through the same credential-bound reader. */
export async function readJiraCreateTemplateIdentity(
  request: JiraMutationRequest,
  project: string,
  issueTypeId: string,
): Promise<Identity | Extract<JiraTemplateGateResult, { ok: false }>> {
  const projectRead = await request(`project/${encodeURIComponent(project)}`);
  if (!projectRead.ok) return projectRead;
  const projectKey = boundProjectKey(projectRead, project);
  if (projectKey === undefined) return MALFORMED;
  const type = await request(`issuetype/${issueTypeId}`);
  if (!type.ok) return type;
  const name = type.body?.name;
  if (type.status !== 200 || type.body?.id !== issueTypeId || !nativeTypeName(name)) return MALFORMED;
  return { projectKey, issueType: { id: issueTypeId, name }, prior: {} };
}

function nativeTypeName(value: unknown): value is string {
  return jiraNativeText(value, 255);
}
function boundProjectKey(
  response: Extract<Awaited<ReturnType<JiraMutationRequest>>, { ok: true }>,
  selected: string,
): string | undefined {
  if (response.status !== 200 || !numericId(response.body?.id)) return undefined;
  const key = response.body.key;
  if (!isSafeAtlassianIdentifier(key)) return undefined;
  // A string predicate would narrow an already-string project key to never on its false arm.
  const matches = NUMERIC_ID.test(selected)
    ? response.body.id === selected
    : key.toUpperCase() === selected.toUpperCase();
  return matches ? key : undefined;
}

async function issueIdentity(
  request: JiraMutationRequest,
  issueKey: string | undefined,
  extra: readonly string[] = [],
): Promise<Identity | Extract<JiraTemplateGateResult, { ok: false }>> {
  if (issueKey === undefined) return MALFORMED;
  const issue = await readJiraMutationIssue(request, issueKey, [...BASE_FIELDS, ...extra]);
  if (!issue.ok) return issue;
  const project = asRecord(issue.fields.project)?.key;
  const type = asRecord(issue.fields.issuetype);
  const name = type?.name;
  const id = type?.id;
  if (!isSafeAtlassianIdentifier(project) || !nativeTypeName(name) || !numericId(id)) return MALFORMED;
  return {
    issueId: issue.id,
    projectKey: project,
    issueType: { id, name },
    prior: issue.fields,
  };
}

function appliedLabels(
  prior: unknown,
  update: JiraTemplateGateInput["validated"]["update"],
): unknown {
  // A partial label update cannot reconstruct a collection Jira did not supply completely.
  if (!readableLabels(prior)) return prior;
  const labels = new Set(prior);
  for (const operation of update.labels ?? []) {
    if (operation.add !== undefined) labels.add(operation.add);
    if (operation.remove !== undefined) labels.delete(operation.remove);
  }
  return [...labels];
}
function readableLabels(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((label: unknown) => typeof label === "string");
}

/** Names of the link types an issue carries, from its `issuelinks` field. */
export function jiraIssueLinkTypeNames(
  prior: Readonly<Record<string, unknown>>,
): readonly string[] {
  const names: string[] = [];
  for (const link of asArray(prior.issuelinks) ?? []) {
    const type = asRecord(asRecord(link)?.type);
    for (const key of ["name", "inward", "outward"] as const) {
      const value = type?.[key];
      if (typeof value === "string") names.push(value);
    }
  }
  return names;
}

function subjectOf(
  input: JiraTemplateGateInput,
  identity: Identity,
  primaryLinks: readonly JiraIssueLinkRequest[] = [],
): JiraTemplateSubject {
  const fields: Record<string, unknown> = { ...identity.prior, ...input.validated.fields };
  if (input.plannedIssueLinks !== undefined) fields.issuelinks = input.plannedIssueLinks;
  if (input.operation !== "create" || input.validated.update.labels !== undefined) {
    fields.labels = appliedLabels(fields.labels, input.validated.update);
  }
  return {
    operation: input.operation,
    projectKey: identity.projectKey,
    issueType: identity.issueType,
    ...(input.transition === undefined ? {} : { transition: input.transition }),
    fields,
    linkTypes: [
      ...(input.operation === "create" ? [] : jiraIssueLinkTypeNames(
        input.plannedIssueLinks === undefined ? identity.prior : fields,
      )),
      ...primaryLinks.map((link) => link.type),
    ],
  };
}

function metadataCatalog(metadata: readonly JiraFieldMetadata[]): readonly JiraFieldCatalogEntry[] {
  const known = new Map<string, JiraFieldCatalogEntry>();
  for (const entry of JIRA_TEMPLATE_SYSTEM_FIELDS) known.set(entry.id, entry);
  for (const field of metadata) known.set(field.id, { id: field.id, name: field.name });
  return [...known.values()];
}

function references(templates: readonly JiraIssueTemplate[]): readonly string[] {
  return templates.flatMap((template) => [
    ...template.requiredFields,
    ...(template.parent.field === undefined ? [] : [template.parent.field]),
  ]);
}

/** The instance field list (`GET field`), or nothing when it is unreadable or over its bound. */
export async function readJiraFieldCatalog(
  request: JiraMutationRequest,
): Promise<readonly JiraFieldCatalogEntry[] | undefined> {
  const items = await readFieldCatalogValues(request);
  return items === undefined ? undefined : fieldCatalogValues(items);
}
async function readFieldCatalogValues(request: JiraMutationRequest): Promise<readonly unknown[] | undefined> {
  const response = await request("field", "GET", undefined, "json-array");
  const items = response.ok && response.status === 200 ? response.items : undefined;
  if (items === undefined || items.length > CATALOG_MAX) return undefined;
  return items;
}
function fieldCatalogValues(items: readonly unknown[]): readonly JiraFieldCatalogEntry[] {
  return items.flatMap((item): readonly JiraFieldCatalogEntry[] => {
    const record = asRecord(item);
    return typeof record?.id === "string" && typeof record.name === "string"
      ? [{ id: record.id, name: record.name }]
      : [];
  });
}

interface BulkReferenceRule { readonly template: JiraIssueTemplate; readonly reference: string }
type BulkReferenceKind = "component" | "version" | "sprint";
function bulkReferenceRules(templates: readonly JiraIssueTemplate[], projectKey: string | undefined): readonly BulkReferenceRule[] {
  return templates.filter((template) => (projectKey === undefined || template.project.trim().toLowerCase() === projectKey.trim().toLowerCase()) &&
    template.activations.some((activation) => activation.kind === "edit"))
    .flatMap((template) => [...template.requiredFields, ...(template.parent.field === undefined ? [] : [template.parent.field])]
      .map((reference) => ({ template, reference })));
}
/** A known non-version custom field stays outside version impact. Opaque/plugin or malformed
 * metadata cannot establish that boundary, so it stays potentially affected. The existing metadata
 * parser classifies shapes only; these synthetic neutral flags grant no editing permission. */
function mayHoldVersion(id: string, values: readonly unknown[]): boolean {
  const matches = values.map(asRecord).filter((value) => value?.id === id);
  if (matches.length !== 1) return true;
  const raw = matches[0];
  const parsed = parseJiraFieldMetadata([{ fieldId: id, name: raw?.name, schema: raw?.schema, required: false, operations: [] }]);
  if (!parsed.ok) return true;
  const kind = parsed.fields[0]?.kind;
  return kind === undefined || kind === "opaque" || kind === "unsupported";
}
function mayHoldSprint(id: string, values: readonly unknown[]): boolean {
  const matches = values.map(asRecord).filter((value) => value?.id === id);
  if (matches.length !== 1) return true;
  if (asRecord(matches[0]?.schema)?.custom === "com.pyxis.greenhopper.jira:gh-sprint") return true;
  // As with version references, opaque/malformed custom fields cannot prove disjoint impact.
  return mayHoldVersion(id, values);
}
function bulkFieldAffected(id: string, kind: BulkReferenceKind, values: readonly unknown[]): boolean {
  if (kind === "component") return id === "components";
  if (kind === "sprint") return sprintFieldAffected(id, values);
  if (id === "fixVersions" || id === "versions") return true;
  return id.startsWith("customfield_") && mayHoldVersion(id, values);
}
function sprintFieldAffected(id: string, values: readonly unknown[]): boolean {
  if (id === "sprint" || id === "closedSprints") return true;
  return id.startsWith("customfield_") && mayHoldSprint(id, values);
}
function bulkReferenceViolation(rule: BulkReferenceRule): JiraTemplateViolation {
  return { ruleId: "template-unreadable", template: jiraIssueTemplateLabel(rule.template), subject: `Bulk issue-field impact: ${rule.reference}`.slice(0, 120) };
}
function bulkReferenceViolations(rules: readonly BulkReferenceRule[], kind: BulkReferenceKind, values: readonly unknown[] | undefined): readonly JiraTemplateViolation[] {
  const catalog = values === undefined ? JIRA_TEMPLATE_SYSTEM_FIELDS : [...JIRA_TEMPLATE_SYSTEM_FIELDS, ...fieldCatalogValues(values)];
  const violations: JiraTemplateViolation[] = [];
  for (const rule of rules) {
    const ids = resolveJiraTemplateFieldIds(rule.reference, catalog);
    if (ids.length === 0 || ids.some((id) => bulkFieldAffected(id, kind, values ?? [])))
      violations.push(bulkReferenceViolation(rule));
  }
  return violations.slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX);
}
/** Native project-wide reference rewrites have no complete, actor-independent affected-issue
 * collection or atomic per-issue post-state contract. A visible JQL result or entity count cannot
 * prove that coverage. Reuse the formal template source and field resolver to refuse only impacted
 * rules before the bulk effect; callers can correct individual issues through governed jira.edit.
 * A sprint's visible board/issues do not establish its full project population: omit projectKey
 * for that impact and consider all edit-active formal rules. This gate never interprets prose
 * skills or treats version ordering/sprint synchronization flags as issue-field mutations. */
export async function gateJiraBulkReferenceChange(input: {
  readonly request: JiraMutationRequest;
  readonly source: JiraIssueTemplateSource | undefined;
  readonly projectKey?: string;
  readonly kind: BulkReferenceKind;
}): Promise<JiraTemplateGateResult> {
  const set = input.source?.();
  if (set === undefined) return OK;
  if (set.unreadable > 0) return unreadableRefusal(set.unreadableNames);
  const rules = bulkReferenceRules(set.templates, input.projectKey);
  if (rules.length === 0) return OK;
  const unresolved = rules.some(({ reference }) => resolveJiraTemplateFieldIds(reference, JIRA_TEMPLATE_SYSTEM_FIELDS).length === 0);
  const values = unresolved ? await readFieldCatalogValues(input.request) : [];
  const violations = bulkReferenceViolations(rules, input.kind, values);
  return violations.length === 0 ? OK : { ok: false, reason: "field-validation", violations };
}

export type JiraSchemaRuleImpact =
  | { readonly kind: "issue-deletion" }
  | { readonly kind: "issue-type"; readonly types: readonly { readonly id: string; readonly name: string }[] }
  | { readonly kind: "custom-fields"; readonly fields: readonly JiraFieldCatalogEntry[] }
  | { readonly kind: "link-type"; readonly names: readonly string[] };
function schemaRuleAffected(template: JiraIssueTemplate, impact: Exclude<JiraSchemaRuleImpact, { readonly kind: "issue-deletion" }>, catalog: readonly JiraFieldCatalogEntry[]): boolean {
  if (impact.kind === "issue-type") return typeSchemaRuleAffected(template, impact.types);
  if (impact.kind === "link-type") return linkSchemaRuleAffected(template, impact.names);
  return references([template]).some((reference) => {
    const ids = resolveJiraTemplateFieldIds(reference, catalog);
    return ids.length === 0 || ids.some((id) => impact.fields.some((field) => field.id === id));
  });
}
function typeSchemaRuleAffected(template: JiraIssueTemplate, types: readonly { readonly id: string; readonly name: string }[]): boolean {
  return [template.issueType, ...(template.parent.issueTypes ?? [])].some((reference) =>
    types.some((type) => sameType(reference, type.id) || sameType(reference, type.name)));
}
function linkSchemaRuleAffected(template: JiraIssueTemplate, names: readonly string[]): boolean {
  if (template.parent.link !== undefined && names.some((name) => sameType(template.parent.link ?? "", name))) return true;
  return references([template]).some((reference) => sameType(reference, "issuelinks") || sameType(reference, "Issue Links"));
}
function mayReferenceDeletedIssue(id: string, values: readonly unknown[]): boolean {
  if (id === "parent" || id === "issuelinks" || id === "subtasks") return true;
  if (JIRA_TEMPLATE_SYSTEM_FIELDS.some((field) => field.id === id)) return false;
  const matches = values.map(asRecord).filter((value) => value?.id === id);
  if (matches.length !== 1) return true;
  const raw = matches[0];
  const parsed = parseJiraFieldMetadata([{ fieldId: id, name: raw?.name, schema: raw?.schema, required: false, operations: [] }]);
  if (!parsed.ok) return true;
  const kind = parsed.fields[0]?.kind;
  return kind === undefined || kind === "issue" || kind === "links" || kind === "opaque" || kind === "unsupported";
}
function deletionRuleAffected(template: JiraIssueTemplate, values: readonly unknown[]): boolean {
  if (template.parent.link !== undefined) return true;
  const catalog = [...JIRA_TEMPLATE_SYSTEM_FIELDS, ...fieldCatalogValues(values)];
  return references([template]).some((reference) => {
    const ids = resolveJiraTemplateFieldIds(reference, catalog);
    return ids.length === 0 || ids.some((id) => mayReferenceDeletedIssue(id, values));
  });
}
function schemaImpactResult(affected: readonly JiraIssueTemplate[], subject = "Schema changes require complete governed issue migration"): JiraTemplateGateResult {
  return affected.length === 0 ? OK : {
    ok: false, reason: "field-validation",
    violations: affected.slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX).map((template) => ({
      ruleId: "template-unreadable", template: jiraIssueTemplateLabel(template),
      subject,
    })),
  };
}
/** Deletion can remove inbound references from other, permission-hidden issues. The deleted
 * object's own content is not a surviving post-state. Native scalar metadata can prove that a
 * required field is unrelated; unknown/plugin issue references cannot prove population coverage. */
async function issueDeletionImpact(request: JiraMutationRequest, templates: readonly JiraIssueTemplate[]): Promise<JiraTemplateGateResult> {
  const unresolved = references(templates).some((reference) =>
    resolveJiraTemplateFieldIds(reference, JIRA_TEMPLATE_SYSTEM_FIELDS).length === 0);
  const values = unresolved ? await readFieldCatalogValues(request) : [];
  return schemaImpactResult(templates.filter((template) => deletionRuleAffected(template, values ?? [])),
    "Issue deletion requires complete evidence for surviving issue references");
}
/** Schema deletion and type renaming can change values or the selection of saved formal rules
 * for a population Jira does not expose completely. Consider every declared activation and all
 * rules of an affected type, including summary, labels, sections and parent rules. No JQL prefix,
 * visible count or compatible migration alternative proves the hidden population's post-state.
 * Only parsed formal records enter this owner; prose skills and layout/terminology do not. */
export async function gateJiraSchemaRuleImpact(input: {
  readonly request: JiraMutationRequest;
  readonly source: JiraIssueTemplateSource | undefined;
  readonly impact: JiraSchemaRuleImpact;
}): Promise<JiraTemplateGateResult> {
  const set = input.source?.();
  if (set === undefined) return OK;
  if (set.unreadable > 0) return unreadableRefusal(set.unreadableNames);
  if (set.templates.length === 0) return OK;
  const impact = input.impact;
  if (impact.kind === "issue-deletion") return issueDeletionImpact(input.request, set.templates);
  const catalog = impact.kind === "custom-fields"
    ? await readJiraFieldCatalog(input.request) : JIRA_TEMPLATE_SYSTEM_FIELDS;
  if (catalog === undefined) return unreadableRefusal(["native field catalog for schema impact"]);
  const affected = set.templates.filter((template) => schemaRuleAffected(template, impact, catalog));
  return schemaImpactResult(affected);
}

/** Operation metadata first; the instance field list only when a reference stays unresolved. */
async function completeCatalog(
  input: JiraTemplateGateInput,
  templates: readonly JiraIssueTemplate[],
): Promise<readonly JiraFieldCatalogEntry[]> {
  const local = metadataCatalog(input.metadata);
  const unresolved = references(templates).some(
    (reference) => resolveJiraTemplateFieldIds(reference, local).length === 0,
  );
  if (!unresolved) return local;
  const remote = await readJiraFieldCatalog(input.request);
  return remote === undefined ? local : [...local, ...remote];
}

async function completeIdentity(
  input: JiraTemplateGateInput,
  identity: Identity,
  catalog: readonly JiraFieldCatalogEntry[],
  templates: readonly JiraIssueTemplate[],
): Promise<Identity | Extract<JiraTemplateGateResult, { ok: false }>> {
  if (input.operation === "create") return identity;
  const base = new Set<string>(BASE_FIELDS);
  const extra = references(templates)
    .flatMap((reference) => resolveJiraTemplateFieldIds(reference, catalog))
    .filter((id) => !base.has(id));
  if (extra.length === 0) return identity;
  const current = await issueIdentity(input.request, input.target.issueKey, extra);
  if ("ok" in current) return current;
  // Never let a second read select a different issue/project/type and silently remove the
  // templates already matched against the first read. Nothing has been dispatched here.
  return sameIdentity(identity, current) ? current : { ok: false, reason: "conflict" };
}
function sameIdentity(first: Identity, current: Identity): boolean {
  return (
    first.issueId === current.issueId &&
    first.projectKey === current.projectKey &&
    first.issueType.id === current.issueType.id &&
    first.issueType.name === current.issueType.name
  );
}

function evidenceFields(
  template: JiraIssueTemplate,
  catalog: readonly JiraFieldCatalogEntry[],
): readonly string[] {
  const labels = template.labels;
  const checksLabels = labels.required.length > 0 || labels.minCount !== undefined || labels.pattern !== undefined;
  return [
    ...(Object.keys(template.summary).length === 0 ? [] : ["summary"]),
    ...(template.requiredSections.length === 0 ? [] : ["description"]),
    ...(checksLabels ? ["labels"] : []),
    ...references([template]).flatMap((reference) => resolveJiraTemplateFieldIds(reference, catalog)),
  ];
}
function readableParent(value: unknown): boolean {
  if (value === null) return true;
  const parent = asRecord(value);
  if (parent === undefined) return false;
  if (Object.hasOwn(parent, "key") && !isSafeAtlassianIdentifier(parent.key)) return false;
  if (Object.hasOwn(parent, "id") && !numericId(parent.id)) return false;
  return Object.hasOwn(parent, "key") || Object.hasOwn(parent, "id");
}
function readableEvidence(fields: Readonly<Record<string, unknown>>, id: string): boolean {
  if (id === "labels") return readableLabels(fields[id]);
  if (id === "summary") return typeof fields[id] === "string";
  if (id === "description") return fields[id] === null || typeof fields[id] === "string";
  if (id === "parent") return readableParent(fields[id]);
  // Other field kinds keep the existing pure presence check: an omitted required value already
  // refuses the write. Do not invent a schema for arbitrary native/plugin composite values.
  return true;
}
function evidenceViolations(
  subject: JiraTemplateSubject,
  templates: readonly JiraIssueTemplate[],
  catalog: readonly JiraFieldCatalogEntry[],
): readonly JiraTemplateViolation[] {
  // Creation has no prior issue; absent submitted fields are judged by the ordinary missing-value
  // rules. For existing issues, absence is unreadable evidence, never a fabricated empty value.
  if (subject.operation === "create") return [];
  return templates.flatMap((template) => [...new Set(evidenceFields(template, catalog))]
    .filter((id) => !readableEvidence(subject.fields, id))
    .map((id): JiraTemplateViolation => ({ ruleId: "template-unreadable", subject: id, template: jiraIssueTemplateLabel(template) })))
    .slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX);
}

/** Fail-closed admission. No templates, or none governing this write, is the unchanged path. */
export async function gateJiraMutationByTemplates(
  input: JiraTemplateGateInput,
): Promise<JiraTemplateGateResult> {
  // A source that throws propagates: the owner's executor turns it into a correlated, redacted
  // diagnostic and an unavailable outcome, so the write still never reaches Jira.
  const set = input.source?.();
  if (set === undefined) return OK;
  if (set.unreadable > 0) return unreadableRefusal(set.unreadableNames);
  const candidates = set.templates.filter((template) =>
    template.activations.some((activation) => activation.kind === input.operation),
  );
  if (candidates.length === 0) return OK;
  const first =
    input.operation === "create"
      ? await createIdentity(input.request, input.target)
      : await issueIdentity(input.request, input.target.issueKey);
  return "ok" in first ? identityRefusal(first, candidates) : checkCandidates(input, candidates, first);
}

function sameType(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
/** Links of a type a governing template requires go first, so they ride on the primary write. */
function requiredLinksFirst(
  links: readonly JiraIssueLinkRequest[],
  templates: readonly JiraIssueTemplate[],
): readonly JiraIssueLinkRequest[] {
  const required = templates.flatMap((template) =>
    template.parent.link === undefined ? [] : [template.parent.link],
  );
  const wanted = (link: JiraIssueLinkRequest): boolean =>
    required.some((type) => sameType(type, link.type));
  return [...links.filter(wanted), ...links.filter((link) => !wanted(link))];
}

/** The templates that activate on this operation, judged against the write's state. */
async function checkCandidates(
  input: JiraTemplateGateInput,
  candidates: readonly JiraIssueTemplate[],
  first: Identity,
): Promise<JiraTemplateGateResult> {
  const undecidable = jiraTemplatesNeedingTransitionNames(candidates, subjectOf(input, first));
  if (undecidable.length > 0)
    return undecidableTransitionRefusal(
      undecidable.map((template) => jiraIssueTemplateLabel(template)),
    );
  const matching = matchingJiraIssueTemplates(candidates, subjectOf(input, first));
  if (matching.length === 0) return OK;
  const catalog = await completeCatalog(input, matching);
  const identity = await completeIdentity(input, first, catalog, matching);
  if ("ok" in identity) return identityRefusal(identity, matching);
  const ordered = requiredLinksFirst(input.links ?? [], matching);
  // Only the link that rides on the request itself exists in the state this write leaves.
  const primary = planJiraIssueLinks(ordered, identity.prior.issuelinks).inline;
  const subject = await bindJiraTemplateParentTypes(
    input.request, subjectOf(input, identity, primary), matching, catalog,
  );
  const unreadable = evidenceViolations(subject, matching, catalog);
  if (unreadable.length > 0) return { ok: false, reason: "field-validation", violations: unreadable };
  const violations = checkJiraIssueTemplates(
    matching,
    subject,
    catalog,
  );
  if (violations.length > 0) return { ok: false, reason: "field-validation", violations };
  return ordered.length === 0 ? OK : { ok: true, links: ordered };
}
