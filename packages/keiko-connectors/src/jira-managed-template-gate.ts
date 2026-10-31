import {
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
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";

/**
 * Write admission against customer-defined issue templates (#4177). One gate sits between the
 * validated field changes and the Jira POST/PUT of create, edit and transition, and the same
 * pipeline backs the dry run that Chat runs before it asks a human to approve. A write that
 * violates an active template never leaves this function as `ok`, in every autonomy mode.
 */
export interface JiraIssueTemplateSet {
  readonly templates: readonly JiraIssueTemplate[];
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
  /** Links the write adds; their type names count toward a `parentLink` rule. */
  readonly links?: readonly { readonly type: string }[];
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
  | { readonly ok: true }
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

function numericId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,32}$/u.test(value);
}

interface Identity {
  readonly projectKey: string;
  readonly issueType: { readonly id?: string; readonly name: string };
  readonly prior: Readonly<Record<string, unknown>>;
}

async function createIdentity(
  request: JiraMutationRequest,
  target: JiraTemplateGateInput["target"],
): Promise<Identity | Extract<JiraTemplateGateResult, { ok: false }>> {
  const { projectId, issueTypeId } = target;
  if (!numericId(projectId) || !numericId(issueTypeId)) return MALFORMED;
  const project = await request(`project/${projectId}`);
  if (!project.ok) return project;
  const type = await request(`issuetype/${issueTypeId}`);
  if (!type.ok) return type;
  const key = project.body?.key;
  const name = type.body?.name;
  if (typeof key !== "string" || typeof name !== "string" || key.length === 0) return MALFORMED;
  return { projectKey: key, issueType: { id: issueTypeId, name }, prior: {} };
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
  if (typeof project !== "string" || typeof name !== "string") return MALFORMED;
  const id = type?.id;
  return {
    projectKey: project,
    issueType: { ...(typeof id === "string" ? { id } : {}), name },
    prior: issue.fields,
  };
}

function appliedLabels(
  prior: unknown,
  update: JiraTemplateGateInput["validated"]["update"],
): readonly string[] {
  const labels = new Set(
    (asArray(prior) ?? []).filter((item): item is string => typeof item === "string"),
  );
  for (const operation of update.labels ?? []) {
    if (operation.add !== undefined) labels.add(operation.add);
    if (operation.remove !== undefined) labels.delete(operation.remove);
  }
  return [...labels];
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

function subjectOf(input: JiraTemplateGateInput, identity: Identity): JiraTemplateSubject {
  const fields: Record<string, unknown> = { ...identity.prior, ...input.validated.fields };
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
      ...(input.operation === "create" ? [] : jiraIssueLinkTypeNames(identity.prior)),
      ...(input.links ?? []).map((link) => link.type),
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
  const response = await request("field", "GET", undefined, "json-array");
  const items = response.ok ? response.items : undefined;
  if (items === undefined || items.length > CATALOG_MAX) return undefined;
  return items.flatMap((item): readonly JiraFieldCatalogEntry[] => {
    const record = asRecord(item);
    return typeof record?.id === "string" && typeof record.name === "string"
      ? [{ id: record.id, name: record.name }]
      : [];
  });
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
  return extra.length === 0 ? identity : issueIdentity(input.request, input.target.issueKey, extra);
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
  return "ok" in first ? first : checkCandidates(input, candidates, first);
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
  if ("ok" in identity) return identity;
  const violations = checkJiraIssueTemplates(matching, subjectOf(input, identity), catalog);
  return violations.length === 0 ? OK : { ok: false, reason: "field-validation", violations };
}
