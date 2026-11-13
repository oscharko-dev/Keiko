import {
  jiraPrivateAccountDeclarationForTool,
  type JIRA_PRIVATE_ACCOUNT_READ_DEFINITIONS,
} from "./jiraPrivateAccountDescriptors.js";
import { JIRA_PROJECT_REVIEW_SCHEMA } from "./jiraProjectLifecycleSchemas.js";
import {
  jiraEmailTemplateDeclarationForTool,
  type JIRA_EMAIL_TEMPLATE_DEFINITIONS,
} from "./jiraEmailTemplateDescriptors.js";
import {
  jiraIdentityObservationDeclarationForTool,
  type JIRA_IDENTITY_OBSERVATION_READ_DEFINITIONS,
} from "./jiraIdentityObservationDescriptors.js";
import {
  jiraRemoteVersionLinkDeclarationForTool,
  type JIRA_REMOTE_VERSION_LINK_READ_DEFINITIONS,
} from "./jiraRemoteVersionLinkDescriptors.js";
import {
  jiraWorklogFeedDeclarationForTool,
  type JIRA_WORKLOG_FEED_READ_DEFINITIONS,
} from "./jiraWorklogFeedDescriptors.js";
import {
  jiraAdministrativeObservationDeclarationForTool,
  type JIRA_ADMINISTRATIVE_OBSERVATION_READ_DEFINITIONS,
} from "./jiraAdministrativeObservationDescriptors.js";
import {
  jiraApplicationSettingsDeclarationForTool,
  type JIRA_APPLICATION_SETTINGS_READ_DEFINITIONS,
} from "./jiraApplicationSettingsDescriptors.js";
import {
  jiraAccountDiagnosticDeclarationForTool,
  type JIRA_ACCOUNT_DIAGNOSTIC_READ_DEFINITIONS,
} from "./jiraAccountDiagnosticDescriptors.js";
import {
  jiraIssueContextDeclarationForTool,
  type JIRA_ISSUE_CONTEXT_READ_DEFINITIONS,
} from "./jiraIssueContextDescriptors.js";
import {
  jiraEntityPropertyDeclarationForTool,
  type JIRA_ENTITY_PROPERTY_READ_DEFINITIONS,
} from "./jiraEntityPropertyDescriptors.js";
import {
  jiraJobObservationDeclarationForTool,
  type JIRA_JOB_OBSERVATION_READ_DEFINITIONS,
} from "./jiraJobObservationDescriptors.js";
import {
  jiraResourceViewDeclarationForTool,
  type JIRA_RESOURCE_VIEW_READ_DEFINITIONS,
} from "./jiraResourceViewDescriptors.js";
import {
  jiraMaintenanceDeclarationForTool,
  type JIRA_MAINTENANCE_READ_DEFINITIONS,
} from "./jiraMaintenanceDescriptors.js";
import {
  jiraRuntimeSettingsDeclarationForTool,
  type JIRA_RUNTIME_SETTINGS_READ_DEFINITIONS,
} from "./jiraRuntimeSettingsDescriptors.js";
import {
  jiraConfigurationDeclarationForTool,
  type JIRA_CONFIGURATION_READ_DEFINITIONS,
} from "./jiraConfigurationDescriptors.js";
import {
  jiraAgileContextDeclarationForTool,
  type JIRA_AGILE_CONTEXT_READ_DEFINITIONS,
} from "./jiraAgileContextDescriptors.js";
import { jiraJqlDeclarationForTool, type JIRA_JQL_READ_DEFINITIONS } from "./jiraJqlDescriptors.js";
import {
  jiraScopedDirectoryDeclarationForTool,
  type JIRA_SCOPED_DIRECTORY_READ_DEFINITIONS,
} from "./jiraScopedDirectoryDescriptors.js";
import {
  jiraReleaseDeclarationForTool,
  type JIRA_RELEASE_READ_DEFINITIONS,
} from "./jiraReleaseDescriptors.js";
import {
  jiraRoleDeclarationForTool,
  type JIRA_ROLE_READ_DEFINITIONS,
} from "./jiraRoleDescriptors.js";
import {
  jiraInstanceDeclarationForTool,
  type JIRA_INSTANCE_READ_DEFINITIONS,
} from "./jiraInstanceDescriptors.js";
import {
  jiraCoreMetadataDeclarationForTool,
  type JIRA_CORE_METADATA_READ_DEFINITIONS,
} from "./jiraCoreMetadataDescriptors.js";
import {
  jiraAccessDeclarationForTool,
  type JIRA_ACCESS_READ_DEFINITIONS,
} from "./jiraAccessDescriptors.js";
import {
  jiraAdministrationDeclarationForTool,
  type JIRA_ADMINISTRATION_READ_DEFINITIONS,
} from "./jiraAdministrationDescriptors.js";
import {
  jiraDirectoryDeclarationForTool,
  type JIRA_DIRECTORY_READ_DEFINITIONS,
} from "./jiraDirectoryDescriptors.js";
import {
  jiraParticipationDeclarationForTool,
  type JIRA_PARTICIPATION_READ_DEFINITIONS,
} from "./jiraParticipationDescriptors.js";
import {
  createJiraManagedProvider,
  type JiraManagedConnection,
  type JiraManagedMutationExecutor,
  type JiraDraftToolDeps,
  type JiraDraftBatchExecutor,
  type JiraReportToolDeps,
} from "@oscharko-dev/keiko-connectors";
import {
  ATLASSIAN_JQL_MAX_CHARS,
  JIRA_FIELD_KINDS,
  JIRA_FIELD_READ_MAX,
  JIRA_FIELD_ID_PATTERN,
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
  type JiraManagedReadToolName,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
  ManagedMcpToolDeclaration,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { recordJiraProviderCall } from "./jiraOperationActivity.js";
import {
  compileExternalCatalogSchema,
  createToolDescriptor,
  createToolRef,
} from "@oscharko-dev/keiko-tool-catalog";

import { text, object } from "./jiraManagedSchemas.js";
import {
  JIRA_FAILURE_FIELD_ERRORS_SCHEMA,
  JIRA_FAILURE_MESSAGES_SCHEMA,
  jiraMutationDeclaration,
} from "./jiraManagedMutationDescriptors.js";
import { JIRA_DRAFT_BATCH_DECLARATION } from "./jiraDraftBatchDescriptor.js";
import { jiraDraftStageDeclaration } from "./jiraDraftDescriptor.js";
import { jiraReportDeclaration } from "./jiraReportDescriptor.js";
import { JIRA_APPLICABLE_TEMPLATES_SCHEMA } from "./jiraTemplateMetadataSchema.js";
import {
  jiraAgileDeclarationForTool,
  type JIRA_AGILE_READ_DEFINITIONS,
  type JIRA_FILTER_READ_DEFINITIONS,
} from "./jiraAgileDescriptors.js";
import {
  jiraIssueCollaborationDeclarationForTool,
  type JIRA_ISSUE_COLLABORATION_READ_DEFINITIONS,
} from "./jiraIssueCollaborationDescriptors.js";
import {
  jiraSavedViewDeclarationForTool,
  type JIRA_SAVED_VIEW_READ_DEFINITIONS,
} from "./jiraSavedViewDescriptors.js";
import {
  jiraAssetDeclarationForTool,
  type JIRA_ASSET_READ_DEFINITIONS,
} from "./jiraAssetDescriptors.js";
import {
  jiraProjectStructureDeclarationForTool,
  type JIRA_PROJECT_STRUCTURE_READ_DEFINITIONS,
} from "./jiraProjectStructureDescriptors.js";
import {
  createJiraOperationContract,
  matchesJiraOperationBinding,
  type JiraOperationBinding,
  type JiraOperationContract,
} from "./jiraOperationRegistry.js";

const PAGE_NUMBER = { type: "integer", minimum: 0, maximum: 1000000 };
const REFERENCE = object({
  id: text(256),
  name: text(256),
  accountId: text(256),
  label: text(256),
});
const FIELD = object(
  {
    id: text(64),
    name: text(255),
    required: { type: "boolean" },
    hasDefaultValue: { type: "boolean" },
    kind: { type: "string", enum: JIRA_FIELD_KINDS },
    richText: { type: "boolean" },
    operations: {
      type: "array",
      maxItems: 3,
      items: { type: "string", enum: ["set", "add", "remove"] },
    },
    allowedValues: { type: "array", maxItems: 500, items: REFERENCE },
    schemaType: text(129),
    inputSchema: { ...object({}), additionalProperties: true },
    nativeFormat: { type: "string", enum: ["jira-wiki"] },
    markdownSerialization: { type: "string", enum: ["supported-markdown"] },
  },
  ["id", "name", "required", "hasDefaultValue", "kind", "richText", "operations"],
);
// A value read from Jira is bounded by the catalog string limit the connector already judges it by,
// not by Jira's default field length: an instance may allow more, and a longer text must read as
// itself or as a named bounds failure, never as a failed tool.
const READ_TEXT = text(TOOL_CATALOG_LIMITS.maxStringBytes);
const FIELD_VALUE = object(
  {
    id: text(64),
    name: text(255),
    kind: { type: "string", enum: JIRA_FIELD_KINDS },
    state: { type: "string", enum: ["value", "empty", "unsupported", "unavailable"] },
    text: READ_TEXT,
    number: { type: "number", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    strings: { type: "array", maxItems: 100, items: text(255) },
    references: { type: "array", maxItems: 100, items: REFERENCE },
  },
  ["id", "name", "kind", "state"],
);
const DISPLAY_REFERENCE = object({
  id: text(256),
  key: text(256),
  name: text(256),
  displayName: text(256),
});
const ISSUE_SUMMARY = {
  browseUrl: text(4096),
  id: text(128),
  key: text(128),
  summary: text(255),
  status: DISPLAY_REFERENCE,
  issuetype: DISPLAY_REFERENCE,
  project: DISPLAY_REFERENCE,
  assignee: DISPLAY_REFERENCE,
  reporter: DISPLAY_REFERENCE,
  priority: DISPLAY_REFERENCE,
  assigneeEmpty: { type: "boolean" },
  labels: { type: "array", maxItems: 100, items: text(255) },
  duedate: text(64),
  created: text(64),
  updated: text(64),
};
// Requested fields: ids as the instance names them, typed by the instance's own schema (#4176).
const FIELD_IDS = {
  type: "array",
  minItems: 1,
  maxItems: JIRA_FIELD_READ_MAX,
  items: { ...text(64), pattern: JIRA_FIELD_ID_PATTERN },
};
interface ReadDefinition {
  readonly description: string;
  readonly arguments: CatalogJsonObject;
  readonly required: readonly string[];
  readonly item: CatalogJsonObject;
  readonly paged?: boolean;
  readonly rootResult?: CatalogJsonObject;
}
type CoreReadToolName = Exclude<
  JiraManagedReadToolName,
  | "jira.report"
  | "jira.draft-stage"
  | "jira.draft-batch"
  | Extract<
      JiraManagedReadToolName,
      | keyof typeof JIRA_PRIVATE_ACCOUNT_READ_DEFINITIONS
      | keyof typeof JIRA_EMAIL_TEMPLATE_DEFINITIONS
      | keyof typeof JIRA_IDENTITY_OBSERVATION_READ_DEFINITIONS
      | keyof typeof JIRA_REMOTE_VERSION_LINK_READ_DEFINITIONS
      | keyof typeof JIRA_WORKLOG_FEED_READ_DEFINITIONS
      | keyof typeof JIRA_ADMINISTRATIVE_OBSERVATION_READ_DEFINITIONS
      | keyof typeof JIRA_APPLICATION_SETTINGS_READ_DEFINITIONS
      | keyof typeof JIRA_ACCOUNT_DIAGNOSTIC_READ_DEFINITIONS
      | keyof typeof JIRA_AGILE_READ_DEFINITIONS
      | keyof typeof JIRA_CONFIGURATION_READ_DEFINITIONS
      | keyof typeof JIRA_RUNTIME_SETTINGS_READ_DEFINITIONS
      | keyof typeof JIRA_MAINTENANCE_READ_DEFINITIONS
      | keyof typeof JIRA_RESOURCE_VIEW_READ_DEFINITIONS
      | keyof typeof JIRA_JOB_OBSERVATION_READ_DEFINITIONS
      | keyof typeof JIRA_ENTITY_PROPERTY_READ_DEFINITIONS
      | keyof typeof JIRA_ISSUE_CONTEXT_READ_DEFINITIONS
      | keyof typeof JIRA_AGILE_CONTEXT_READ_DEFINITIONS
      | keyof typeof JIRA_FILTER_READ_DEFINITIONS
      | keyof typeof JIRA_PROJECT_STRUCTURE_READ_DEFINITIONS
      | keyof typeof JIRA_ISSUE_COLLABORATION_READ_DEFINITIONS
      | keyof typeof JIRA_PARTICIPATION_READ_DEFINITIONS
      | keyof typeof JIRA_ADMINISTRATION_READ_DEFINITIONS
      | keyof typeof JIRA_ACCESS_READ_DEFINITIONS
      | keyof typeof JIRA_CORE_METADATA_READ_DEFINITIONS
      | keyof typeof JIRA_INSTANCE_READ_DEFINITIONS
      | keyof typeof JIRA_ROLE_READ_DEFINITIONS
      | keyof typeof JIRA_RELEASE_READ_DEFINITIONS
      | keyof typeof JIRA_DIRECTORY_READ_DEFINITIONS
      | keyof typeof JIRA_SCOPED_DIRECTORY_READ_DEFINITIONS
      | keyof typeof JIRA_JQL_READ_DEFINITIONS
      | keyof typeof JIRA_SAVED_VIEW_READ_DEFINITIONS
      | keyof typeof JIRA_ASSET_READ_DEFINITIONS
    >
>;
const SEARCH_DEFINITION: ReadDefinition = {
  description: `Search Jira with bounded opaque JQL. Returns issue summaries; fetch an issue for its description and comments separately. Progress, estimates and template compliance across many issues come from jira.report, not from paging results.`,
  arguments: {
    jql: { type: "string", minLength: 1, maxLength: ATLASSIAN_JQL_MAX_CHARS },
    fields: FIELD_IDS,
  },
  required: ["jql"],
  item: object(
    {
      ...ISSUE_SUMMARY,
      fieldValues: { type: "array", maxItems: JIRA_FIELD_READ_MAX, items: FIELD_VALUE },
    },
    ["id", "key", "summary"],
  ),
};
const DEFINITIONS: Readonly<Record<CoreReadToolName, ReadDefinition>> = {
  "jira.project": {
    description:
      "Inspect one visible Jira project by its current id or key, including ordinary metadata and a trusted Jira link.",
    arguments: { projectIdOrKey: text(64) },
    required: ["projectIdOrKey"],
    paged: false,
    item: object({}),
    rootResult: {
      projectId: text(64),
      projectKey: text(64),
      projectName: text(255),
      reviewSnapshot: JIRA_PROJECT_REVIEW_SCHEMA,
      description: READ_TEXT,
      url: text(4096),
      lead: text(255),
      assigneeType: { type: "string", enum: ["PROJECT_LEAD", "UNASSIGNED"] },
      projectTypeKey: text(64),
      omittedMetadataCount: { type: "integer", minimum: 0, maximum: 5 },
    },
  },
  "jira.validate-project-key": {
    description:
      "Validate a proposed project key using the connected Jira instance's configured key rules. Validation does not reserve a key or create a project.",
    arguments: { key: text(64) },
    required: ["key"],
    paged: false,
    item: object({}),
    rootResult: { key: text(64), valid: { type: "boolean" } },
  },
  "jira.project-permissions": {
    description:
      "Read explicit current Jira permission facts globally or for one project. Missing facts do not grant permission.",
    arguments: { projectIdOrKey: text(64) },
    required: [],
    paged: false,
    item: object({}),
    rootResult: {
      permissions: {
        type: "array",
        maxItems: 100,
        items: object({ key: text(128), name: text(255), havePermission: { type: "boolean" } }, [
          "key",
          "havePermission",
        ]),
      },
    },
  },
  "jira.project-type": {
    description:
      "Read whether a native Jira project type is accessible to the current actor before creating a project.",
    arguments: { projectTypeKey: text(64) },
    required: ["projectTypeKey"],
    paged: false,
    item: object({}),
    rootResult: { projectTypeKey: text(64), name: text(255) },
  },
  "jira.projects": {
    description: "Read projects visible to the connected identity.",
    arguments: {},
    required: [],
    item: object({ id: text(64), key: text(64), name: text(255) }, ["id", "key", "name"]),
  },
  "jira.issue-types": {
    description: "Read issue types the connected identity may create in a project.",
    arguments: { projectKey: text(128) },
    required: ["projectKey"],
    item: object({ id: text(32), name: text(255), subtask: { type: "boolean" } }, [
      "id",
      "name",
      "subtask",
    ]),
  },
  "jira.create-fields": {
    description:
      "Read current create fields and applicable stored CREATE template rules for a project and issue type. Unsupported fields cannot be written. All field pages are needed to identify required fields. The first page carries applicableTemplates when the stored-rule source is available; matchedCount 0 with complete true means no matching rule. Keep every returned template's required sections and rules. complete false or omittedCount greater than 0 means rule metadata is incomplete, including missing source provenance.",
    arguments: {
      projectKey: text(128),
      issueTypeId: { type: "string", pattern: "^[0-9]{1,32}$", maxLength: 32 },
    },
    required: ["projectKey", "issueTypeId"],
    item: FIELD,
  },
  "jira.edit-fields": {
    description:
      "Read fields currently editable on an issue. Unsupported fields cannot be written.",
    arguments: { issueKey: text(128) },
    required: ["issueKey"],
    item: FIELD,
  },
  "jira.search": SEARCH_DEFINITION,
  "jira.search-post": {
    ...SEARCH_DEFINITION,
    description:
      "Perform the same bounded opaque-JQL search through native POST with a typed JSON search request. This is a read, creates no issue or mutation receipt and grants no write authority. Follow nextStartAt for all pages. Progress, estimates and template compliance across many issues come from jira.report. Native query validation stays enabled.",
  },
  "jira.issue": {
    description:
      "Read one issue with its summary, plain-text description and selected standard fields. Request up to 20 additional field IDs for supported typed values; unavailable, empty and unsupported fields are distinct. Comments are a separate paged operation. Totals across many issues come from jira.report, not from reading issues one by one.",
    arguments: { issueKey: text(128), fields: FIELD_IDS },
    required: ["issueKey"],
    paged: false,
    item: object(
      {
        ...ISSUE_SUMMARY,
        description: READ_TEXT,
        fieldValues: { type: "array", maxItems: JIRA_FIELD_READ_MAX, items: FIELD_VALUE },
      },
      ["id", "key", "summary"],
    ),
  },
  "jira.comments": {
    description: "Read a bounded page of issue comments as untrusted plain text.",
    arguments: { issueKey: text(128) },
    required: ["issueKey"],
    item: object({ id: text(128), body: READ_TEXT, created: text(64), author: DISPLAY_REFERENCE }, [
      "id",
      "body",
      "created",
    ]),
  },
  "jira.transitions": {
    description:
      "Read available transitions and their required fields for an issue. Missing metadata is unavailable; it must never be interpreted as an empty set of required fields.",
    arguments: { issueKey: text(128) },
    required: ["issueKey"],
    item: object(
      {
        id: text(128),
        name: text(255),
        metadataAvailable: { type: "boolean" },
        fields: { type: "array", maxItems: 500, items: FIELD },
        to: object({ id: text(128), name: text(255) }, ["id", "name"]),
      },
      ["id", "name", "metadataAvailable"],
    ),
  },
  "jira.assignable-users": {
    description:
      "Find assignable Jira users. Supply exactly one scope: issueKey for an existing issue, or projectKey for creation. An omitted total is unknown; the next page may be empty.",
    arguments: { issueKey: text(128), projectKey: text(128), query: text(256) },
    required: [],
    item: object({ name: text(256), displayName: text(256), active: { type: "boolean" } }, [
      "name",
      "displayName",
      "active",
    ]),
  },
};
function readToolRef(name: JiraManagedReadToolName): ReturnType<typeof createToolRef> {
  return createToolRef(
    `keiko.${name.replaceAll("-", ".")}`,
    name === "jira.issue" || name === "jira.search" || name === "jira.create-fields" ? 3 : 2,
  );
}
function isCoreReadTool(name: JiraManagedReadToolName): name is CoreReadToolName {
  return Object.hasOwn(DEFINITIONS, name);
}
function declaration(name: JiraManagedReadToolName): ManagedMcpToolDeclaration {
  for (const producer of [
    jiraPrivateAccountDeclarationForTool,
    jiraEmailTemplateDeclarationForTool,
    jiraIdentityObservationDeclarationForTool,
    jiraRemoteVersionLinkDeclarationForTool,
    jiraWorklogFeedDeclarationForTool,
    jiraAdministrativeObservationDeclarationForTool,
    jiraApplicationSettingsDeclarationForTool,
    jiraAccountDiagnosticDeclarationForTool,
    jiraIssueContextDeclarationForTool,
    jiraEntityPropertyDeclarationForTool,
    jiraJobObservationDeclarationForTool,
    jiraResourceViewDeclarationForTool,
    jiraMaintenanceDeclarationForTool,
    jiraRuntimeSettingsDeclarationForTool,
    jiraConfigurationDeclarationForTool,
    jiraAgileDeclarationForTool,
    jiraAgileContextDeclarationForTool,
    jiraProjectStructureDeclarationForTool,
    jiraAdministrationDeclarationForTool,
    jiraAccessDeclarationForTool,
    jiraCoreMetadataDeclarationForTool,
    jiraInstanceDeclarationForTool,
    jiraRoleDeclarationForTool,
    jiraReleaseDeclarationForTool,
    jiraDirectoryDeclarationForTool,
    jiraScopedDirectoryDeclarationForTool,
    jiraJqlDeclarationForTool,
    jiraParticipationDeclarationForTool,
    jiraIssueCollaborationDeclarationForTool,
    jiraSavedViewDeclarationForTool,
    jiraAssetDeclarationForTool,
  ]) {
    const selected = producer(name);
    if (selected !== undefined) return selected;
  }
  if (name === "jira.report") return jiraReportDeclaration();
  if (name === "jira.draft-stage") return jiraDraftStageDeclaration();
  if (name === "jira.draft-batch") return JIRA_DRAFT_BATCH_DECLARATION;
  if (!isCoreReadTool(name)) throw new TypeError("Unsupported Jira read tool");
  return coreDeclaration(name);
}
function coreInputSchema(definition: (typeof DEFINITIONS)[CoreReadToolName]): CatalogJsonObject {
  return object(
    {
      ...(definition.paged === false
        ? {}
        : { startAt: PAGE_NUMBER, maxResults: { type: "integer", minimum: 1, maximum: 100 } }),
      ...definition.arguments,
    },
    definition.required,
  );
}
function coreDeclaration(name: CoreReadToolName): ManagedMcpToolDeclaration {
  const definition = DEFINITIONS[name];
  const descriptor = createToolDescriptor({
    toolRef: readToolRef(name),
    description: definition.description,
    inputSchema: coreInputSchema(definition),
    resultSchema: coreResultSchema(
      name,
      object(
        {
          ...definition.rootResult,
          outcome: { type: "string", enum: ["succeeded", "failed"] },
          reason: text(64),
          fieldErrors: JIRA_FAILURE_FIELD_ERRORS_SCHEMA,
          messages: JIRA_FAILURE_MESSAGES_SCHEMA,
          browseUrl: text(4096),
          draft: object({ tool: text(16), use: text(256) }, ["tool", "use"]),
          ...(name === "jira.create-fields"
            ? { applicableTemplates: JIRA_APPLICABLE_TEMPLATES_SCHEMA }
            : {}),
          items: { type: "array", maxItems: 100, items: definition.item },
          startAt: PAGE_NUMBER,
          total: PAGE_NUMBER,
          nextStartAt: PAGE_NUMBER,
        },
        ["outcome"],
      ),
    ),
    effects: ["connector-access"],
    actionMapping: [{ action: name, effects: ["connector-access"] }],
    policyReferences: ["adr-0128.d4"],
    handlerRequirement: { id: name, contractVersion: 1 },
    bounds: {
      maxArgumentBytes: 8192,
      maxResultBytes: 262144,
      maxResultCount: 100,
      maxDurationMs: 15000,
    },
    idempotency: "server-key-required",
    cancellation: "before-effect",
  });
  return Object.freeze({ name, risk: "read", descriptor });
}
function coreResultSchema(name: CoreReadToolName, schema: CatalogJsonObject): CatalogJsonObject {
  return name === "jira.project" ? compileExternalCatalogSchema(schema) : schema;
}
const OPERATION_CONTRACTS = new Map<string, JiraOperationContract>();
const BUILDING_OPERATION_CONTRACTS = new Set<string>();
let completeOperationContracts: readonly JiraOperationContract[] | undefined;

function rawDeclarationForTool(tool: string): ManagedMcpToolDeclaration | undefined {
  const read = JIRA_MANAGED_READ_TOOLS.find((name) => name === tool);
  if (read !== undefined) return declaration(read);
  const mutation = JIRA_MUTATION_OPERATIONS.find((name) => name === tool);
  return mutation === undefined ? undefined : jiraMutationDeclaration(mutation);
}

/** An explicit full inventory request still compiles and validates every declaration in order. */
export function jiraOperationContracts(): readonly JiraOperationContract[] {
  if (completeOperationContracts !== undefined) return completeOperationContracts;
  const names = [...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS];
  if (new Set(names).size !== names.length)
    throw new TypeError("Duplicate Jira operation declaration");
  const contracts = names.map((name) => {
    const contract = jiraOperationForTool(name);
    if (contract === undefined) throw new TypeError("Missing Jira operation contract");
    return contract;
  });
  completeOperationContracts = Object.freeze(contracts);
  return completeOperationContracts;
}
/** Bind a requested raw declaration once, recursively retaining the same composite member digests. */
export function jiraOperationForTool(tool: string): JiraOperationContract | undefined {
  const cached = OPERATION_CONTRACTS.get(tool);
  if (cached !== undefined) return cached;
  if (BUILDING_OPERATION_CONTRACTS.has(tool)) throw new TypeError("Cyclic Jira operation contract");
  BUILDING_OPERATION_CONTRACTS.add(tool);
  try {
    const raw = rawDeclarationForTool(tool);
    if (raw === undefined) return undefined;
    if (raw.name !== tool) throw new TypeError("Mismatched Jira operation declaration");
    const contract = createJiraOperationContract(raw, jiraOperationForTool);
    OPERATION_CONTRACTS.set(tool, contract);
    return contract;
  } finally {
    BUILDING_OPERATION_CONTRACTS.delete(tool);
  }
}
export function jiraDeclarationForTool(tool: string): ManagedMcpToolDeclaration | undefined {
  return jiraOperationForTool(tool)?.declaration;
}
export function jiraOperationBindingForTool(tool: string): JiraOperationBinding | undefined {
  return jiraOperationForTool(tool)?.binding;
}
export function isCurrentJiraOperationBinding(
  tool: string,
  value: unknown,
): value is JiraOperationBinding {
  const contract = jiraOperationForTool(tool);
  return contract !== undefined && matchesJiraOperationBinding(contract, value);
}

/** Canonical descriptors are built by the server; the connector owns only Jira behavior. */
export function createJiraProviderForCatalog<Context extends ManagedMcpInvocationContext>(
  connection: (context: Context) => JiraManagedConnection | Promise<JiraManagedConnection>,
  tools: readonly (JiraManagedReadToolName | JiraMutationOperation)[] = JIRA_MANAGED_READ_TOOLS,
  executeMutation?: JiraManagedMutationExecutor<Context>,
  report?: JiraReportToolDeps<Context>,
  draft?: JiraDraftToolDeps<Context>,
  batch?: JiraDraftBatchExecutor<Context>,
): ManagedMcpProvider<Context> {
  const selected = tools.map((name) => {
    const declaration = jiraDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Unsupported Jira tool");
    return declaration;
  });
  const provider = createJiraManagedProvider({
    connection,
    declarations: selected,
    ...(executeMutation === undefined ? {} : { executeMutation }),
    ...(report === undefined ? {} : { report }),
    ...(draft === undefined ? {} : { draft }),
    ...(batch === undefined ? {} : { batch }),
  });
  const boundTools = Object.freeze(
    provider.tools().map((tool) => {
      const operation = tools.find((name) => name === tool.name);
      if (operation === undefined) throw new TypeError("Unselected Jira operation");
      const binding = jiraOperationBindingForTool(tool.name);
      if (binding === undefined) throw new TypeError("Unknown Jira operation");
      return Object.freeze({
        ...tool,
        execute: async (...args: Parameters<typeof tool.execute>) => {
          let result: ManagedMcpToolResult;
          try {
            result = await tool.execute(...args);
          } catch (error) {
            recordJiraProviderCall(args[1].correlationId, operation, "failed");
            throw error;
          }
          recordJiraProviderCall(
            args[1].correlationId,
            operation,
            result.isError === true ? "failed" : "completed",
          );
          // Provider response content never chooses the operation or its contract authority.
          return { ...result, data: { ...result.data, operationBinding: binding } };
        },
      });
    }),
  );
  return Object.freeze({ ...provider, tools: () => boundTools });
}
