import type {
  JiraFieldMetadata,
  JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { matchingJiraIssueTemplates } from "./jira-issue-template-check.js";
import {
  readJiraCreateTemplateIdentity,
  type JiraIssueTemplateSet,
} from "./jira-managed-template-gate.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { requestFor } from "./jira-managed-mutations.js";
import { jiraCreateMutationMetadata } from "./jira-managed-mutation-metadata.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";

const TEMPLATES_MAX = 8;
const TEMPLATE_BYTES_MAX = 16_384;

/** What a template demands of a create, without its library provenance. */
function templateFacts(template: JiraIssueTemplate): CatalogJsonObject {
  return {
    project: template.project,
    issueType: template.issueType,
    operation: "create",
    summary: { ...template.summary },
    requiredFields: [...template.requiredFields],
    requiredSections: [...template.requiredSections],
    labels: { ...template.labels, required: [...template.labels.required] },
    parent: { ...template.parent },
  };
}

function ruleFacts(
  template: JiraIssueTemplate,
  set: JiraIssueTemplateSet,
): CatalogJsonObject | undefined {
  const source = set.references?.find((reference) => reference.template === template);
  if (source === undefined) return undefined;
  return {
    ...templateFacts(template),
    source: { id: source.id, revision: source.revision, digest: source.digest },
  };
}

function boundedRules(
  matching: readonly JiraIssueTemplate[],
  set: JiraIssueTemplateSet,
): CatalogJsonObject {
  const items: CatalogJsonObject[] = [];
  for (const template of matching) {
    const item = ruleFacts(template, set);
    if (item === undefined) continue;
    if (
      items.length === TEMPLATES_MAX ||
      Buffer.byteLength(JSON.stringify([...items, item])) > TEMPLATE_BYTES_MAX
    )
      break;
    items.push(item);
  }
  return {
    items,
    matchedCount: matching.length,
    omittedCount: matching.length - items.length,
    complete: items.length === matching.length,
    unreadableCount: 0,
  };
}

function unreadableRules(
  connection: JiraManagedConnection,
  unreadableCount: number,
): ManagedMcpToolResult {
  connection.templateMetadataActivity?.({
    matchedCount: 0,
    returnedCount: 0,
    omittedCount: 0,
    unreadableCount,
  });
  const result = jiraReadFailure("template-unreadable");
  return {
    ...result,
    data: {
      ...result.data,
      applicableTemplates: {
        items: [],
        matchedCount: 0,
        omittedCount: 0,
        unreadableCount,
        complete: false,
      },
    },
  };
}

function matchedRulesResult(
  result: ManagedMcpToolResult,
  matching: readonly JiraIssueTemplate[],
  set: JiraIssueTemplateSet,
  connection: JiraManagedConnection,
): ManagedMcpToolResult {
  const rules = boundedRules(matching, set);
  const returnedCount = Array.isArray(rules.items) ? rules.items.length : 0;
  connection.templateMetadataActivity?.({
    matchedCount: matching.length,
    returnedCount,
    omittedCount: matching.length - returnedCount,
    unreadableCount: 0,
  });
  return { ...result, data: { ...result.data, applicableTemplates: rules } };
}

function admitted(context: ManagedMcpInvocationContext): boolean {
  return !context.signal.aborted && context.beforeEffect();
}

function readIdentity(
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): ReturnType<typeof readJiraCreateTemplateIdentity> {
  if (typeof args.projectKey !== "string" || typeof args.issueTypeId !== "string")
    return Promise.resolve({ ok: false, reason: "malformed-payload" });
  return readJiraCreateTemplateIdentity(
    requestFor(connection, context),
    args.projectKey,
    args.issueTypeId,
  );
}

function isTemplateMetadataPage(result: ManagedMcpToolResult, args: CatalogJsonObject): boolean {
  return result.data.outcome === "succeeded" && (args.startAt === undefined || args.startAt === 0);
}

/** Read the same rules the create gate will judge, without selecting another instruction skill. */
export async function withCreateTemplateMetadata(
  result: ManagedMcpToolResult,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<ManagedMcpToolResult> {
  // The first page owns rule discovery; later field pages must not repeat identity reads or logs.
  if (!isTemplateMetadataPage(result, args) || connection.issueTemplates === undefined)
    return result;
  if (!admitted(context)) return jiraReadFailure("permission-denied");
  const initial = connection.issueTemplates();
  if (initial.unreadable > 0) return unreadableRules(connection, initial.unreadable);
  if (
    !initial.templates.some((template) =>
      template.activations.some((activation) => activation.kind === "create"),
    )
  )
    return matchedRulesResult(result, [], initial, connection);
  const identity = await readIdentity(args, context, connection);
  if ("ok" in identity) return jiraReadFailure(identity.reason);
  if (!admitted(context)) return jiraReadFailure("permission-denied");
  // The rules and their references come from one current snapshot after the identity reads.
  const set = connection.issueTemplates();
  if (set.unreadable > 0) return unreadableRules(connection, set.unreadable);
  const matching = matchingJiraIssueTemplates(set.templates, {
    ...identity,
    operation: "create",
    fields: {},
  });
  const enriched = matchedRulesResult(result, matching, set, connection);
  if (!admitted(context)) return jiraReadFailure("permission-denied");
  return enriched;
}

/** The create rules of one project and issue type, as a draft batch needs them (#4173). */
export interface JiraCreateTemplateRules {
  /** Compact facts of every matching template, for the model's instructions. */
  readonly facts: readonly CatalogJsonObject[];
  readonly requiredSections: readonly string[];
  readonly requiredFields: readonly string[];
  /** Display names of required fields Jira's create metadata named, keyed by field id. */
  readonly requiredFieldNames: Readonly<Record<string, string>>;
  readonly requiredLabels: readonly string[];
}

export type JiraCreateTemplateRulesResult =
  | ({ readonly ok: true } & JiraCreateTemplateRules)
  | { readonly ok: false; readonly reason: string };

const NO_RULES: JiraCreateTemplateRulesResult = {
  ok: true,
  facts: [],
  requiredSections: [],
  requiredFields: [],
  requiredFieldNames: {},
  requiredLabels: [],
};
/** Fields Keiko writes itself in every drafted issue, so a template naming them asks nothing more. */
const WRITTEN_BY_KEIKO: ReadonlySet<string> = new Set(["summary", "description", "labels"]);

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function rulesOf(matching: readonly JiraIssueTemplate[]): JiraCreateTemplateRulesResult {
  return {
    ok: true,
    facts: matching.map(templateFacts),
    requiredSections: unique(matching.flatMap((template) => template.requiredSections)),
    requiredFields: unique(
      matching
        .flatMap((template) => template.requiredFields)
        .filter((field) => !WRITTEN_BY_KEIKO.has(field.trim().toLowerCase())),
    ),
    requiredFieldNames: {},
    requiredLabels: unique(matching.flatMap((template) => template.labels.required)),
  };
}

/**
 * The stored CREATE rules that govern a project and issue type, read the way the create gate reads
 * them: the same identity reads, the same matching. A connection without a template source has no
 * rules; an unreadable library or identity fails closed.
 */
async function storedTemplateRules(
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  projectId: string,
  issueTypeId: string,
): Promise<JiraCreateTemplateRulesResult> {
  if (connection.issueTemplates === undefined) return NO_RULES;
  const initial = connection.issueTemplates();
  if (initial.unreadable > 0) return { ok: false, reason: "template-unreadable" };
  if (
    !initial.templates.some((template) =>
      template.activations.some((activation) => activation.kind === "create"),
    )
  )
    return NO_RULES;
  const identity = await readJiraCreateTemplateIdentity(
    requestFor(connection, context),
    projectId,
    issueTypeId,
  );
  if ("ok" in identity) return { ok: false, reason: identity.reason };
  if (!admitted(context)) return { ok: false, reason: "permission-denied" };
  const set = connection.issueTemplates();
  if (set.unreadable > 0) return { ok: false, reason: "template-unreadable" };
  return rulesOf(
    matchingJiraIssueTemplates(set.templates, { ...identity, operation: "create", fields: {} }),
  );
}

/** Fields every drafted issue carries from Keiko or Jira, never from the model's text. */
const SET_WITHOUT_THE_MODEL: ReadonlySet<string> = new Set([
  "project",
  "issuetype",
  "summary",
  "description",
  "labels",
  "parent",
  "issuelinks",
  "reporter",
]);

/** A value the model can write as one string: a text field, or a plugin field declared `string`. */
function writableAsText(field: JiraFieldMetadata): boolean {
  return field.kind === "text" || (field.kind === "opaque" && field.schemaType === "string");
}

/**
 * The string fields Jira requires on this create without supplying a value (a Data Center Epic's
 * Epic Name, a plugin field). Nothing else sets them, so the model must write them (#4288).
 */
function modelWrittenRequiredFields(
  fields: readonly JiraFieldMetadata[],
): readonly JiraFieldMetadata[] {
  return fields.filter(
    (field) =>
      field.required &&
      !field.hasDefaultValue &&
      writableAsText(field) &&
      !SET_WITHOUT_THE_MODEL.has(field.id),
  );
}

function withMetadataFields(
  rules: JiraCreateTemplateRules,
  fields: readonly JiraFieldMetadata[],
): JiraCreateTemplateRulesResult {
  // A template may name the same field by its display name; it is asked for once, as the template names it.
  const named = new Set(rules.requiredFields.map((field) => field.trim().toLowerCase()));
  const required = modelWrittenRequiredFields(fields).filter(
    (field) => !named.has(field.id.toLowerCase()) && !named.has(field.name.trim().toLowerCase()),
  );
  return {
    ok: true,
    ...rules,
    requiredFields: unique([...rules.requiredFields, ...required.map((field) => field.id)]),
    requiredFieldNames: Object.fromEntries(required.map((field) => [field.id, field.name])),
  };
}

/**
 * The create rules a draft batch writes against: the stored templates' rules plus the plain-text
 * fields Jira's create metadata requires. Without them every staged page is refused for a field the
 * model was never asked for. A metadata read that fails adds nothing; staging still validates
 * every issue against the current metadata and refuses what is missing.
 */
export async function readJiraCreateTemplateRules(
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  projectId: string,
  issueTypeId: string,
): Promise<JiraCreateTemplateRulesResult> {
  const rules = await storedTemplateRules(context, connection, projectId, issueTypeId);
  if (!rules.ok || !admitted(context)) return rules;
  const metadata = await jiraCreateMutationMetadata(
    requestFor(connection, context),
    projectId,
    issueTypeId,
  );
  return metadata.ok ? withMetadataFields(rules, metadata.fields) : rules;
}
