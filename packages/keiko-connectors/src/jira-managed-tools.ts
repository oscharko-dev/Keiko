import { isJiraProjectLifecycleMutation } from "./jira-project-lifecycle-values.js";
import {
  isJiraPrivateAccountRead,
  executeJiraPrivateAccountRead,
} from "./jira-managed-private-account.js";
import { executeJiraSearchPostRead, isJiraSearchPostRead } from "./jira-managed-search-post.js";
import {
  executeJiraWorklogsByIdRead,
  isJiraWorklogsByIdRead,
} from "./jira-managed-worklogs-by-id.js";
import {
  executeJiraAnonymizationRead,
  isJiraAnonymizationRead,
} from "./jira-managed-anonymization-reads.js";
import { executeJiraSessionRead, isJiraSessionRead } from "./jira-managed-session-read.js";
import { executeJiraEmailTemplateRead } from "./jira-managed-email-templates.js";
import { jiraManagedEmailTemplatePorts } from "./jira-managed-email-template-ports.js";
import {
  executeJiraIssueTypeSchemeRead,
  isJiraIssueTypeSchemeRead,
} from "./jira-managed-issue-type-schemes.js";
import {
  executeJiraWorkflowSchemeRead,
  isJiraWorkflowSchemeRead,
} from "./jira-managed-workflow-schemes.js";
import { executeJiraScreenRead, isJiraScreenRead } from "./jira-managed-screen-reads.js";
import { executeJiraUserRead, isJiraUserRead } from "./jira-managed-user-reads.js";
import { executeJiraDirectoryRead, isJiraDirectoryRead } from "./jira-managed-directory-reads.js";
import {
  executeJiraAccessSchemeRead,
  isJiraAccessSchemeRead,
} from "./jira-managed-access-schemes.js";
import {
  executeJiraNotificationSchemeRead,
  isJiraNotificationSchemeRead,
} from "./jira-managed-notification-schemes.js";
import {
  executeJiraProjectAssociationRead,
  isJiraProjectAssociationRead,
} from "./jira-managed-project-associations.js";
import { jiraProjectLifecycleRequests } from "./jira-project-lifecycle-request.js";
import {
  executeJiraCoreMetadataRead,
  isJiraCoreMetadataRead,
} from "./jira-managed-core-metadata.js";
import { executeJiraInstanceRead, isJiraInstanceRead } from "./jira-managed-instance-reads.js";
import {
  executeJiraConfigurationRead,
  isJiraConfigurationRead,
} from "./jira-managed-configuration-reads.js";
import {
  executeJiraRuntimeSettingsRead,
  isJiraRuntimeSettingsRead,
} from "./jira-managed-runtime-settings.js";
import {
  executeJiraMaintenanceRead,
  isJiraMaintenanceRead,
} from "./jira-managed-maintenance-reads.js";
import {
  executeJiraJobObservationRead,
  isJiraJobObservationRead,
} from "./jira-managed-job-observations.js";
import {
  executeJiraAccountDiagnosticRead,
  isJiraAccountDiagnosticRead,
} from "./jira-managed-account-diagnostics.js";
import {
  executeJiraApplicationSettingsRead,
  isJiraApplicationSettingsRead,
} from "./jira-managed-application-settings.js";
import {
  executeJiraAdministrativeObservationRead,
  isJiraAdministrativeObservationRead,
} from "./jira-managed-administrative-observations.js";
import {
  executeJiraRemoteVersionLinkRead,
  isJiraRemoteVersionLinkRead,
} from "./jira-managed-remote-version-links.js";
import { executeJiraWorklogFeedRead, isJiraWorklogFeedRead } from "./jira-managed-worklog-feeds.js";
import {
  executeJiraEntityPropertyRead,
  isJiraEntityPropertyRead,
} from "./jira-managed-entity-properties.js";
import {
  executeJiraIssueContextRead,
  isJiraIssueContextRead,
} from "./jira-managed-issue-context-reads.js";
import {
  executeJiraResourceLookupRead,
  isJiraResourceLookupRead,
} from "./jira-managed-resource-lookups.js";
import { executeJiraColumnRead, isJiraColumnRead } from "./jira-managed-column-reads.js";
import { executeJiraRoleRead, isJiraRoleRead } from "./jira-managed-role-reads.js";
import {
  executeJiraPrioritySchemeRead,
  isJiraPrioritySchemeRead,
} from "./jira-managed-priority-schemes.js";
import { executeJiraReleaseRead, isJiraReleaseRead } from "./jira-managed-release-reads.js";
import {
  executeJiraScopedDirectoryRead,
  isJiraScopedDirectoryRead,
} from "./jira-managed-scoped-directory.js";
import {
  executeJiraFieldDirectoryRead,
  isJiraFieldDirectoryRead,
} from "./jira-managed-field-directory.js";
import { executeJiraJqlMetadataRead, isJiraJqlMetadataRead } from "./jira-managed-jql-metadata.js";
import {
  executeJiraParticipationRead,
  isJiraParticipationRead,
} from "./jira-managed-participation.js";
import { jiraBrowseUrl } from "./jira-browse-url.js";
import { JIRA_AGILE_READ_OPERATIONS, executeJiraAgileRead } from "./jira-agile-reads.js";
import { executeJiraAgileContextRead, isJiraAgileContextRead } from "./jira-agile-context-reads.js";
import { jiraAgileRequest } from "./jira-agile-request.js";
import { JIRA_FILTER_READ_OPERATIONS, executeJiraFilterRead } from "./jira-filter-reads.js";
import { jiraProjectBrowseUrl } from "./jira-project-browse-url.js";
import { executeJiraComponentRead, isJiraComponentRead } from "./jira-managed-components.js";
import { executeJiraVersionRead, isJiraVersionRead } from "./jira-managed-versions.js";
import { executeJiraIssueDetailRead, isJiraIssueDetailRead } from "./jira-managed-issue-details.js";
import { executeJiraCommentRead, isJiraCommentRead } from "./jira-managed-comments.js";
import { executeJiraSavedViewRead, isJiraSavedViewRead } from "./jira-managed-saved-views.js";
import {
  executeJiraAttachmentRead,
  isJiraAttachmentRead,
} from "./jira-managed-attachment-reads.js";
import { executeJiraAvatarRead, isJiraAvatarRead } from "./jira-managed-avatar-reads.js";
import {
  executeJiraProjectRead,
  isJiraProjectRead,
  isJiraProjectMutation,
} from "./jira-managed-projects.js";
import { jiraIssueFieldsQuery, selectedJiraReadFields } from "./jira-managed-field-reads.js";
import {
  jiraAssignableUsersPath,
  jiraAssignableUsersResult,
  jiraTransitionsResult,
} from "./jira-managed-workflow-reads.js";
import {
  jiraIssueReadResult,
  boundJiraReadResult,
  JIRA_MANAGED_ISSUE_FIELDS,
  JIRA_MANAGED_SEARCH_FIELDS,
} from "./jira-managed-issue-reads.js";
import {
  ATLASSIAN_JQL_MAX_CHARS,
  isSafeAtlassianIdentifier,
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
  JIRA_DESCRIPTION_INPUT_SCHEMA,
  type JiraManagedReadToolName,
  type JiraMutationOperation,
  type JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  editMetadataItems,
  issueTypeItems,
  jiraReadFailure as failure,
  localJiraPage,
  metadataItems,
  remoteJiraPage,
} from "./jira-managed-metadata.js";
import { JIRA_CREATE_ASSIGNED_FIELDS } from "./jira-field-metadata.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
  ManagedMcpTool,
  ManagedMcpToolResult,
  ManagedMcpToolDeclaration,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
export type { JiraManagedConnection } from "./jira-managed-connection.js";
import { asRecord, atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeJiraManagedMutation, requestFor } from "./jira-managed-mutations.js";
import { createJiraDraftStore } from "./jira-draft-store.js";
import { executeJiraDraftStageTool, type JiraDraftToolDeps } from "./jira-draft-stage-tool.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool, type JiraReportToolDeps } from "./jira-report-tool.js";
import type { JiraTraceRequest } from "./jira-requirement-trace.js";
import { withCreateTemplateMetadata } from "./jira-create-template-metadata.js";

const ARRAY_READ_NAMES: ReadonlySet<string> = new Set(["jira.projects", "jira.assignable-users"]);
const ISSUE_READ_NAMES: ReadonlySet<string> = new Set([
  "jira.search",
  "jira.issue",
  "jira.comments",
]);

/**
 * `jira.draft-batch` (#4173): the composing server runs the batch with the connection the provider
 * selected for the call. The connector owns no model and no Knowledge access, so it owns no batch.
 */
export type JiraDraftBatchExecutor<Context extends ManagedMcpInvocationContext> = (
  args: CatalogJsonObject,
  context: Context,
  connection: JiraManagedConnection,
) => Promise<ManagedMcpToolResult>;

export interface JiraManagedProviderDeps<Context extends ManagedMcpInvocationContext> {
  readonly connection: (context: Context) => JiraManagedConnection | Promise<JiraManagedConnection>;
  readonly declarations: readonly ManagedMcpToolDeclaration[];
  readonly executeMutation?: JiraManagedMutationExecutor<Context>;
  /** Owner binding, store, checker and log for `jira.report`; defaults to a private in-memory store. */
  readonly report?: JiraReportToolDeps<Context>;
  /** Owner binding, store and log for `jira.draft-stage`; defaults to a private in-memory store. */
  readonly draft?: JiraDraftToolDeps<Context>;
  /** Runs `jira.draft-batch`; without it the tool refuses as unavailable. */
  readonly batch?: JiraDraftBatchExecutor<Context>;
}
/** The server owns durable intent, current authority and the final credential-bearing transport. */
export type JiraManagedMutationExecutor<Context extends ManagedMcpInvocationContext> = (
  operation: JiraMutationOperation,
  args: CatalogJsonObject,
  context: Context,
  execute: (
    http: AtlassianHttpBodyPort,
    trace?: JiraTraceRequest,
    privatePorts?: Pick<JiraManagedConnection, "privateIdentity" | "avatars">,
  ) => Promise<JiraMutationAttempt>,
) => Promise<ManagedMcpToolResult>;

interface Project extends CatalogJsonObject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}
function project(value: unknown): Project | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !text(raw.id, 64) || !text(raw.key, 64) || !text(raw.name, 255))
    return undefined;
  return { id: raw.id, key: raw.key, name: raw.name };
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function pageNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}
function projectPage(
  values: readonly unknown[],
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  if (values.length > 1000) return failure("bounds-exceeded");
  const projects = values.map(project);
  if (projects.includes(undefined)) return failure("malformed-payload");
  const valid = projects.filter((item) => item !== undefined);
  if (new Set(valid.map((item) => item.id)).size !== valid.length)
    return failure("malformed-payload");
  // The DC endpoint is an unpaginated collection. Sort and slice only after complete validation.
  valid.sort((left, right) => left.key.localeCompare(right.key, "en"));
  return localJiraPage(valid, startAt, maxResults);
}
interface ReadSelection {
  readonly path: string;
  readonly fields: readonly string[];
  readonly startAt: number;
  readonly maxResults: number;
}
function selection(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
): ReadSelection | undefined {
  const fields =
    name === "jira.issue" || name === "jira.search" ? selectedJiraReadFields(args.fields) : [];
  if (fields === undefined) return undefined;
  const startAt = pageNumber(args.startAt, 0, 0, 1000000);
  const maxResults = pageNumber(args.maxResults, 25, 1, 100);
  if (startAt === undefined || maxResults === undefined) return undefined;
  const allowed = new Set(name === "jira.issue" ? [] : ["startAt", "maxResults"]);
  const paging = `startAt=${String(startAt)}&maxResults=${String(maxResults)}`;
  const path = readPath(name, args, allowed, paging);
  return path !== undefined && Object.keys(args).every((key) => allowed.has(key))
    ? { path, startAt, maxResults, fields }
    : undefined;
}
function readPath(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  allowed: Set<string>,
  paging: string,
): string | undefined {
  if (name === "jira.projects") return "project";
  if (name === "jira.assignable-users") return jiraAssignableUsersPath(args, allowed, paging);
  if (name === "jira.search") return searchPath(args, allowed, paging);
  if (name === "jira.issue-types" || name === "jira.create-fields") {
    const path = metadataPath(name, args, allowed);
    return path === undefined ? undefined : `${path}?${paging}`;
  }
  return issueReadPath(name, args, allowed, paging);
}
function issueReadPath(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  allowed: Set<string>,
  paging: string,
): string | undefined {
  if (!isSafeAtlassianIdentifier(args.issueKey)) return undefined;
  allowed.add("issueKey");
  const path = `issue/${encodeURIComponent(args.issueKey)}`;
  switch (name) {
    case "jira.edit-fields":
      return `${path}/editmeta`;
    case "jira.issue": {
      allowed.add("fields");
      const query = jiraIssueFieldsQuery(JIRA_MANAGED_ISSUE_FIELDS, args.fields);
      return query === undefined ? undefined : `${path}?${query}`;
    }
    case "jira.comments":
      return `${path}/comment?${paging}`;
    case "jira.transitions":
      return `${path}/transitions?expand=transitions.fields`;
    default:
      return undefined;
  }
}
function searchPath(
  args: CatalogJsonObject,
  allowed: Set<string>,
  paging: string,
): string | undefined {
  if (!text(args.jql, ATLASSIAN_JQL_MAX_CHARS)) return undefined;
  allowed.add("jql");
  allowed.add("fields");
  // Requested fields join the standard summary set; the instance names and types them in its reply.
  const fields = jiraIssueFieldsQuery(JIRA_MANAGED_SEARCH_FIELDS, args.fields);
  if (fields === undefined) return undefined;
  const query = new URLSearchParams({ jql: args.jql });
  for (const [key, value] of new URLSearchParams(paging)) query.set(key, value);
  for (const [key, value] of new URLSearchParams(fields)) query.set(key, value);
  return `search?${query.toString()}`;
}

function metadataPath(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  allowed: Set<string>,
): string | undefined {
  if (!isSafeAtlassianIdentifier(args.projectKey)) return undefined;
  allowed.add("projectKey");
  const path = `issue/createmeta/${encodeURIComponent(args.projectKey)}/issuetypes`;
  if (name !== "jira.create-fields") return path;
  if (typeof args.issueTypeId !== "string" || !/^\d{1,32}$/u.test(args.issueTypeId))
    return undefined;
  allowed.add("issueTypeId");
  return `${path}/${args.issueTypeId}`;
}
function objectReadResult(
  name: JiraManagedReadToolName,
  body: Record<string, unknown>,
  selected: ReadSelection,
  baseUrl: string,
): ManagedMcpToolResult {
  const { startAt, maxResults } = selected;
  if (ISSUE_READ_NAMES.has(name))
    return jiraIssueReadResult(name, baseUrl, body, startAt, maxResults, selected.fields);
  if (name === "jira.transitions") return jiraTransitionsResult(body, startAt, maxResults);
  if (name === "jira.edit-fields") {
    const items = editMetadataItems(body.fields);
    return items === undefined
      ? failure("malformed-payload")
      : localJiraPage(descriptionMetadataItems(items), startAt, maxResults);
  }
  if (name === "jira.issue-types")
    return remoteJiraPage(body, issueTypeItems(body.values), startAt, maxResults);
  return withDraftPointer(
    remoteJiraPage(body, createMetadataItems(body.values), startAt, maxResults),
  );
}

/** Machine-readable provenance for new Markdown; native wiki strings remain verbatim (ADR-0128). */
function createMetadataItems(value: unknown): readonly CatalogJsonObject[] | undefined {
  const items = metadataItems(value);
  return items === undefined ? undefined : descriptionMetadataItems(items).map(assignedOnCreate);
}
/**
 * Jira's create metadata marks the reporter required without a default, yet Jira sets it to the
 * calling user when a create omits it, and create admission already treats it so. Shown raw, the
 * field told the model to invent a reporter, which Jira then refused as unknown user.
 */
function assignedOnCreate(item: CatalogJsonObject): CatalogJsonObject {
  return typeof item.id === "string" && JIRA_CREATE_ASSIGNED_FIELDS.has(item.id)
    ? { ...item, hasDefaultValue: true }
    : item;
}
function descriptionMetadataItems(
  items: readonly CatalogJsonObject[],
): readonly CatalogJsonObject[] {
  return items.map((item) =>
    item.id === "description"
      ? {
          ...item,
          inputSchema: structuredClone(JIRA_DESCRIPTION_INPUT_SCHEMA),
          nativeFormat: "jira-wiki",
          markdownSerialization: "supported-markdown",
        }
      : item,
  );
}
// A model reads create fields right before it creates. Several issues created one by one ask the
// human once each; one jira.draft asks once (S05 of epic #4173: three epics, three approvals). A
// field left out of the draft costs one more approval per issue to add later (S05, Qwen: labels
// added by three edits), and a description written as a JSON object loses its sections (S05, Gemma).
const DRAFT_POINTER = Object.freeze({
  tool: "jira.draft",
  use: "Put several new issues in one jira.draft, each with every field it needs, labels included: the human approves it once, while each jira.create or jira.edit asks again. Use the description field's inputSchema; native text uses h2. Title for section headings.",
});
function withDraftPointer(result: ManagedMcpToolResult): ManagedMcpToolResult {
  return result.data.outcome === "succeeded"
    ? { ...result, data: { ...result.data, draft: { ...DRAFT_POINTER } } }
    : result;
}
function arrayResult(
  name: JiraManagedReadToolName,
  values: readonly unknown[] | undefined,
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  if (values === undefined) return failure("malformed-payload");
  return name === "jira.projects"
    ? projectPage(values, startAt, maxResults)
    : jiraAssignableUsersResult(values, startAt, maxResults);
}
async function agileOrFilterRead<Context extends ManagedMcpInvocationContext>(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  context: Context,
  connection: JiraManagedProviderDeps<Context>["connection"],
): Promise<ManagedMcpToolResult | undefined> {
  const agile = JIRA_AGILE_READ_OPERATIONS.find((operation) => operation === name);
  const agileContext = isJiraAgileContextRead(name) ? name : undefined;
  const filter = JIRA_FILTER_READ_OPERATIONS.find((operation) => operation === name);
  if (agile === undefined && agileContext === undefined && filter === undefined) return undefined;
  const connected = await connection(context);
  if (connected.deployment !== "data-center") return failure("unsupported-deployment");
  if (agileContext !== undefined)
    return executeJiraAgileContextRead(agileContext, args, context, connected);
  return agile !== undefined
    ? executeJiraAgileRead(agile, args, context, connected)
    : executeJiraFilterRead(name, args, context, connected);
}
async function read<Context extends ManagedMcpInvocationContext>(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  context: Context,
  connection: JiraManagedProviderDeps<Context>["connection"],
): Promise<ManagedMcpToolResult> {
  const connected = await agileOrFilterRead(name, args, context, connection);
  if (connected !== undefined) return connected;
  if (isJiraComponentRead(name) || isJiraVersionRead(name))
    return projectMetadataRead(name, args, context, connection);
  if (isNativeDetailRead(name)) return nativeDetailRead(name, args, context, connection);
  return isJiraProjectRead(name)
    ? projectRead(name, args, context, connection)
    : readIssueOrMetadata(name, args, context, connection);
}

type NativeDetailRead =
  | Parameters<typeof executeJiraPrivateAccountRead>[0]
  | "jira.email-template-pack"
  | "jira.search-post"
  | "jira.worklogs-by-id"
  | "jira.current-session"
  | Parameters<typeof executeJiraAnonymizationRead>[0]
  | Parameters<typeof executeJiraRemoteVersionLinkRead>[0]
  | Parameters<typeof executeJiraWorklogFeedRead>[0]
  | Parameters<typeof executeJiraAdministrativeObservationRead>[0]
  | Parameters<typeof executeJiraApplicationSettingsRead>[0]
  | Parameters<typeof executeJiraAccountDiagnosticRead>[0]
  | Parameters<typeof executeJiraIssueContextRead>[0]
  | Parameters<typeof executeJiraEntityPropertyRead>[0]
  | Parameters<typeof executeJiraJobObservationRead>[0]
  | Parameters<typeof executeJiraResourceLookupRead>[0]
  | Parameters<typeof executeJiraColumnRead>[0]
  | Parameters<typeof executeJiraMaintenanceRead>[0]
  | Parameters<typeof executeJiraRuntimeSettingsRead>[0]
  | Parameters<typeof executeJiraConfigurationRead>[0]
  | Parameters<typeof executeJiraIssueDetailRead>[0]
  | "jira.get-comment"
  | Parameters<typeof executeJiraSavedViewRead>[0]
  | Parameters<typeof executeJiraAttachmentRead>[0]
  | Parameters<typeof executeJiraAvatarRead>[0]
  | Parameters<typeof executeJiraParticipationRead>[0]
  | Parameters<typeof executeJiraIssueTypeSchemeRead>[0]
  | Parameters<typeof executeJiraWorkflowSchemeRead>[0]
  | Parameters<typeof executeJiraScreenRead>[0]
  | Parameters<typeof executeJiraUserRead>[0]
  | Parameters<typeof executeJiraDirectoryRead>[0]
  | Parameters<typeof executeJiraAccessSchemeRead>[0]
  | Parameters<typeof executeJiraNotificationSchemeRead>[0]
  | Parameters<typeof executeJiraProjectAssociationRead>[0]
  | Parameters<typeof executeJiraCoreMetadataRead>[0]
  | Parameters<typeof executeJiraInstanceRead>[0]
  | Parameters<typeof executeJiraRoleRead>[0]
  | Parameters<typeof executeJiraPrioritySchemeRead>[0]
  | Parameters<typeof executeJiraReleaseRead>[0]
  | Parameters<typeof executeJiraScopedDirectoryRead>[0]
  | Parameters<typeof executeJiraFieldDirectoryRead>[0]
  | Parameters<typeof executeJiraJqlMetadataRead>[0];
function isNativeDetailRead(name: string): name is NativeDetailRead {
  if (name === "jira.email-template-pack") return true;
  return [
    isJiraPrivateAccountRead,
    isJiraSearchPostRead,
    isJiraWorklogsByIdRead,
    isJiraAnonymizationRead,
    isJiraSessionRead,
    isJiraRemoteVersionLinkRead,
    isJiraWorklogFeedRead,
    isJiraAdministrativeObservationRead,
    isJiraApplicationSettingsRead,
    isJiraAccountDiagnosticRead,
    isJiraIssueContextRead,
    isJiraEntityPropertyRead,
    isJiraJobObservationRead,
    isJiraResourceLookupRead,
    isJiraColumnRead,
    isJiraMaintenanceRead,
    isJiraRuntimeSettingsRead,
    isJiraConfigurationRead,
    isJiraIssueDetailRead,
    isJiraCommentRead,
    isJiraSavedViewRead,
    isJiraAttachmentRead,
    isJiraAvatarRead,
    isJiraParticipationRead,
    isJiraIssueTypeSchemeRead,
    isJiraWorkflowSchemeRead,
    isJiraScreenRead,
    isJiraUserRead,
    isJiraDirectoryRead,
    isJiraAccessSchemeRead,
    isJiraNotificationSchemeRead,
    isJiraProjectAssociationRead,
    isJiraCoreMetadataRead,
    isJiraInstanceRead,
    isJiraRoleRead,
    isJiraPrioritySchemeRead,
    isJiraReleaseRead,
    isJiraScopedDirectoryRead,
    isJiraFieldDirectoryRead,
    isJiraJqlMetadataRead,
  ].some((accepts) => accepts(name));
}
type NativeReadHandler = (
  name: NativeDetailRead,
  args: CatalogJsonObject,
  request: ReturnType<typeof requestFor>,
) => Promise<ManagedMcpToolResult> | undefined;
/** Keep family narrowing at the call site without duplicating the dispatch chain. */
function nativeReadHandler<Name extends NativeDetailRead>(
  accepts: (name: string) => name is Name,
  execute: (
    name: Name,
    args: CatalogJsonObject,
    request: ReturnType<typeof requestFor>,
  ) => Promise<ManagedMcpToolResult>,
): NativeReadHandler {
  return (name, args, request) => (accepts(name) ? execute(name, args, request) : undefined);
}
const ADMINISTRATION_READS: readonly NativeReadHandler[] = [
  nativeReadHandler(isJiraAdministrativeObservationRead, executeJiraAdministrativeObservationRead),
  nativeReadHandler(isJiraResourceLookupRead, executeJiraResourceLookupRead),
  nativeReadHandler(isJiraColumnRead, executeJiraColumnRead),
  nativeReadHandler(isJiraScreenRead, executeJiraScreenRead),
  nativeReadHandler(isJiraIssueTypeSchemeRead, executeJiraIssueTypeSchemeRead),
  nativeReadHandler(isJiraWorkflowSchemeRead, executeJiraWorkflowSchemeRead),
  nativeReadHandler(isJiraAccessSchemeRead, executeJiraAccessSchemeRead),
  nativeReadHandler(isJiraNotificationSchemeRead, executeJiraNotificationSchemeRead),
  nativeReadHandler(isJiraProjectAssociationRead, executeJiraProjectAssociationRead),
  nativeReadHandler(isJiraRoleRead, executeJiraRoleRead),
  nativeReadHandler(isJiraPrioritySchemeRead, executeJiraPrioritySchemeRead),
  nativeReadHandler(isJiraApplicationSettingsRead, executeJiraApplicationSettingsRead),
  nativeReadHandler(isJiraConfigurationRead, executeJiraConfigurationRead),
  nativeReadHandler(isJiraRuntimeSettingsRead, executeJiraRuntimeSettingsRead),
  nativeReadHandler(isJiraMaintenanceRead, executeJiraMaintenanceRead),
  nativeReadHandler(isJiraJobObservationRead, executeJiraJobObservationRead),
  nativeReadHandler(isJiraAccountDiagnosticRead, executeJiraAccountDiagnosticRead),
  nativeReadHandler(isJiraUserRead, executeJiraUserRead),
  nativeReadHandler(isJiraDirectoryRead, executeJiraDirectoryRead),
  nativeReadHandler(isJiraCoreMetadataRead, executeJiraCoreMetadataRead),
  nativeReadHandler(isJiraInstanceRead, executeJiraInstanceRead),
  nativeReadHandler(isJiraReleaseRead, executeJiraReleaseRead),
  nativeReadHandler(isJiraScopedDirectoryRead, executeJiraScopedDirectoryRead),
  nativeReadHandler(isJiraFieldDirectoryRead, executeJiraFieldDirectoryRead),
  nativeReadHandler(isJiraJqlMetadataRead, executeJiraJqlMetadataRead),
  nativeReadHandler(isJiraRemoteVersionLinkRead, executeJiraRemoteVersionLinkRead),
  nativeReadHandler(isJiraWorklogFeedRead, executeJiraWorklogFeedRead),
];
function administrationRead(
  name: NativeDetailRead,
  args: CatalogJsonObject,
  request: ReturnType<typeof requestFor>,
): Promise<ManagedMcpToolResult> | undefined {
  for (const read of ADMINISTRATION_READS) {
    const result = read(name, args, request);
    if (result !== undefined) return result;
  }
  return undefined;
}
function linkedIssueDetailRead(
  name: NativeDetailRead,
  args: CatalogJsonObject,
  request: ReturnType<typeof requestFor>,
  baseUrl: string,
): Promise<ManagedMcpToolResult> {
  if (isJiraIssueContextRead(name))
    return executeJiraIssueContextRead(name, args, request, baseUrl);
  if (isJiraCommentRead(name)) return executeJiraCommentRead(name, args, request, baseUrl);
  if (isJiraIssueDetailRead(name)) return executeJiraIssueDetailRead(name, args, request);
  throw new TypeError("Unsupported Jira detail read");
}
function selectedObservationRead(
  name: NativeDetailRead,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  request: ReturnType<typeof requestFor>,
): Promise<ManagedMcpToolResult> | undefined {
  if (name === "jira.project-priority-scheme")
    return executeJiraProjectAssociationRead(
      name,
      args,
      request,
      jiraProjectLifecycleRequests(connection, context).priority.read,
    );
  if (name === "jira.email-template-pack") {
    const ports = jiraManagedEmailTemplatePorts(connection, context, request, true);
    return ports === undefined
      ? Promise.resolve(failure("unavailable"))
      : executeJiraEmailTemplateRead(args, ports);
  }
  if (isJiraPrivateAccountRead(name))
    return executeJiraPrivateAccountRead(name, args, request, connection.privateIdentity);
  if (isJiraSearchPostRead(name))
    return executeJiraSearchPostRead(args, request, connection.baseUrl);
  if (isJiraWorklogsByIdRead(name)) return executeJiraWorklogsByIdRead(args, request);
  if (isJiraAnonymizationRead(name)) return executeJiraAnonymizationRead(name, args, request);
  if (isJiraSessionRead(name)) return executeJiraSessionRead(args, context, connection);
  return undefined;
}
async function nativeDetailRead<Context extends ManagedMcpInvocationContext>(
  name: NativeDetailRead,
  args: CatalogJsonObject,
  context: Context,
  connection: JiraManagedProviderDeps<Context>["connection"],
): Promise<ManagedMcpToolResult> {
  const connected = await connection(context);
  if (connected.deployment !== "data-center") return failure("unsupported-deployment");
  const request = requestFor(connected, context);
  const selectedObservation = selectedObservationRead(name, args, context, connected, request);
  if (selectedObservation !== undefined) return selectedObservation;
  if (isJiraEntityPropertyRead(name))
    return executeJiraEntityPropertyRead(name, args, {
      platform: request,
      agile: jiraAgileRequest(connected, context),
      baseUrl: connected.baseUrl,
    });
  const administration = administrationRead(name, args, request);
  if (administration !== undefined) return administration;
  if (isJiraParticipationRead(name))
    return executeJiraParticipationRead(name, args, request, connected.baseUrl);
  if (isJiraSavedViewRead(name)) return executeJiraSavedViewRead(name, args, request);
  if (isJiraAttachmentRead(name)) return executeJiraAttachmentRead(name, args, request);
  if (isJiraAvatarRead(name)) return executeJiraAvatarRead(name, args, request);
  const result = await linkedIssueDetailRead(name, args, request, connected.baseUrl);
  return boundJiraReadResult(withIssueLink(result, connected.baseUrl, args.issueKey));
}

async function projectMetadataRead<Context extends ManagedMcpInvocationContext>(
  name:
    Parameters<typeof executeJiraComponentRead>[0] | Parameters<typeof executeJiraVersionRead>[0],
  args: CatalogJsonObject,
  context: Context,
  connection: JiraManagedProviderDeps<Context>["connection"],
): Promise<ManagedMcpToolResult> {
  const connected = await connection(context);
  if (connected.deployment !== "data-center") return failure("unsupported-deployment");
  const request = requestFor(connected, context);
  const result = isJiraComponentRead(name)
    ? await executeJiraComponentRead(name, args, request)
    : await executeJiraVersionRead(name, args, request);
  return boundJiraReadResult(result);
}
async function readIssueOrMetadata<Context extends ManagedMcpInvocationContext>(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  context: Context,
  connection: JiraManagedProviderDeps<Context>["connection"],
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return failure("invalid-input");
  const connected = await connection(context);
  const { deployment, baseUrl } = connected;
  if (deployment !== "data-center") return failure("unsupported-deployment");
  const url = atlassianApiUrl(atlassianApiEndpointsFor(baseUrl, "/rest/api/2/"), selected.path);
  const outcome = await executeAdmittedJiraRequest(connected, context, context.signal, {
    method: "GET",
    url,
    expect: ARRAY_READ_NAMES.has(name) ? "json-array" : "json",
  });
  if (!outcome.ok) return failure(outcome.reason, outcome.remote);
  const { startAt, maxResults } = selected;
  if (ARRAY_READ_NAMES.has(name))
    return boundJiraReadResult(
      withIssueLink(arrayResult(name, outcome.items, startAt, maxResults), baseUrl, args.issueKey),
    );
  if (outcome.body === undefined) return failure("malformed-payload");
  const projected = objectReadResult(name, outcome.body, selected, baseUrl);
  const result =
    name === "jira.create-fields"
      ? await withCreateTemplateMetadata(projected, args, context, connected)
      : projected;
  return boundJiraReadResult(
    name === "jira.issue" || name === "jira.search"
      ? result
      : withIssueLink(result, baseUrl, args.issueKey),
  );
}

async function projectRead<Context extends ManagedMcpInvocationContext>(
  name: Parameters<typeof executeJiraProjectRead>[0],
  args: CatalogJsonObject,
  context: Context,
  connection: JiraManagedProviderDeps<Context>["connection"],
): Promise<ManagedMcpToolResult> {
  const connected = await connection(context);
  if (connected.deployment !== "data-center") return failure("unsupported-deployment");
  const result = await executeJiraProjectRead(name, args, requestFor(connected, context));
  return boundJiraReadResult(withProjectLink(result, connected.baseUrl));
}

function withProjectLink(result: ManagedMcpToolResult, baseUrl: string): ManagedMcpToolResult {
  const data = { ...result.data };
  delete data.browseUrl;
  const url = jiraProjectBrowseUrl(baseUrl, data.projectKey);
  if (url !== undefined) data.browseUrl = url;
  return { ...result, data };
}

function withIssueLink(
  result: ManagedMcpToolResult,
  baseUrl: string,
  issueKey: unknown,
): ManagedMcpToolResult {
  const data = { ...result.data };
  delete data.browseUrl;
  const url = jiraBrowseUrl(baseUrl, data.issueKey ?? issueKey);
  if (url !== undefined) data.browseUrl = url;
  return { ...result, data };
}

function batchTool<Context extends ManagedMcpInvocationContext>(
  declaration: ManagedMcpToolDeclaration,
  connection: JiraManagedProviderDeps<Context>["connection"],
  batch: JiraDraftBatchExecutor<Context> | undefined,
): ManagedMcpTool<Context> {
  return Object.freeze({
    ...declaration,
    execute: async (args: CatalogJsonObject, context: Context): Promise<ManagedMcpToolResult> =>
      batch === undefined
        ? failure("unavailable")
        : batch(args, context, await connection(context)),
  });
}

function mutationTool<Context extends ManagedMcpInvocationContext>(
  declaration: ManagedMcpToolDeclaration,
  operation: (typeof JIRA_MUTATION_OPERATIONS)[number],
  connection: JiraManagedProviderDeps<Context>["connection"],
  executeMutation: JiraManagedMutationExecutor<Context>,
): ManagedMcpTool<Context> {
  return Object.freeze({
    ...declaration,
    execute: async (args: CatalogJsonObject, context: Context): Promise<ManagedMcpToolResult> => {
      const snapshot = structuredClone(args);
      const selected = Object.freeze({ ...(await connection(context)) });
      const result = await executeMutation(
        operation,
        structuredClone(snapshot),
        context,
        (http, trace, privatePorts) =>
          executeJiraManagedMutation(
            operation,
            snapshot,
            context,
            {
              ...selected,
              http,
              ...privatePorts,
              avatars: { ...selected.avatars, ...privatePorts?.avatars },
            },
            trace,
          ),
      );
      if (isJiraProjectMutation(operation) || isJiraProjectLifecycleMutation(operation))
        return withProjectLink(result, selected.baseUrl);
      return withIssueLink(
        result,
        selected.baseUrl,
        operation === "jira.create" ? undefined : snapshot.issueKey,
      );
    },
  });
}
/** Private connection/context stays outside the MCP declaration and arguments. */
function managedTool<Context extends ManagedMcpInvocationContext>(
  declaration: ManagedMcpToolDeclaration,
  connection: JiraManagedProviderDeps<Context>["connection"],
  executeMutation: JiraManagedMutationExecutor<Context> | undefined,
  report: JiraReportToolDeps<Context>,
  draft: JiraDraftToolDeps<Context>,
): ManagedMcpTool<Context> {
  if (declaration.name === "jira.draft-stage" && declaration.risk === "read")
    return Object.freeze({
      ...declaration,
      execute: async (args: CatalogJsonObject, context: Context): Promise<ManagedMcpToolResult> =>
        executeJiraDraftStageTool(args, context, await connection(context), draft),
    });
  if (declaration.name === "jira.report" && declaration.risk === "read")
    return Object.freeze({
      ...declaration,
      execute: async (args: CatalogJsonObject, context: Context): Promise<ManagedMcpToolResult> =>
        executeJiraReportTool(args, context, await connection(context), report),
    });
  const readName = JIRA_MANAGED_READ_TOOLS.find((name) => name === declaration.name);
  if (readName !== undefined && declaration.risk === "read")
    return Object.freeze({
      ...declaration,
      execute: (args: CatalogJsonObject, context: Context): Promise<ManagedMcpToolResult> =>
        read(readName, args, context, connection),
    });
  const operation = JIRA_MUTATION_OPERATIONS.find((name) => name === declaration.name);
  if (operation === undefined || declaration.risk !== "write" || executeMutation === undefined)
    throw new TypeError("Unsupported Jira declaration");
  return mutationTool(declaration, operation, connection, executeMutation);
}

export function createJiraManagedProvider<Context extends ManagedMcpInvocationContext>(
  deps: JiraManagedProviderDeps<Context>,
): ManagedMcpProvider<Context> {
  const connection = deps.connection;
  const executeMutation = deps.executeMutation;
  const report: JiraReportToolDeps<Context> = deps.report ?? {
    store: createJiraReportStore(),
    owner: () => "provider",
  };
  const draft: JiraDraftToolDeps<Context> = deps.draft ?? {
    store: createJiraDraftStore(),
    owner: () => "provider",
  };
  const tools: readonly ManagedMcpTool<Context>[] = Object.freeze(
    deps.declarations.map((declaration) =>
      declaration.name === "jira.draft-batch" && declaration.risk === "read"
        ? batchTool(declaration, connection, deps.batch)
        : managedTool(declaration, connection, executeMutation, report, draft),
    ),
  );
  return Object.freeze({ id: "jira", tools: (): readonly ManagedMcpTool<Context>[] => tools });
}
