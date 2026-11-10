import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  JIRA_READ_TOOL_FAMILIES,
  JIRA_CORE_MUTATIONS,
  JIRA_ANONYMIZATION_UNLOCK_MUTATIONS,
  JIRA_EXTENDED_ISSUE_CREATION_MUTATIONS,
  JIRA_AVATAR_MUTATIONS,
  JIRA_IDENTITY_MUTATIONS,
  JIRA_PRIVATE_ACCOUNT_MUTATIONS,
  JIRA_ISSUE_LIFECYCLE_MUTATIONS,
  JIRA_PROJECT_LIFECYCLE_MUTATIONS,
  JIRA_GROUP_MUTATIONS,
  JIRA_ISSUE_ACTION_MUTATIONS,
  JIRA_MAINTENANCE_MUTATIONS,
  JIRA_SCHEMA_MUTATIONS,
  JIRA_DIRECTORY_ACCESS_MUTATIONS,
  JIRA_OPTION_SCHEME_MUTATIONS,
  JIRA_WORKFLOW_SCHEME_MUTATIONS,
  JIRA_INSTANCE_SETTING_MUTATIONS,
  JIRA_EMAIL_TEMPLATE_MUTATIONS,
  JIRA_PERMISSION_SCHEME_MUTATIONS,
  JIRA_ROLE_MUTATIONS,
  JIRA_AGILE_PLANNING_MUTATIONS,
  JIRA_VERSION_REMOTE_LINK_MUTATIONS,
  JIRA_PROJECT_CATEGORY_MUTATIONS,
  JIRA_SCREEN_CONFIGURATION_MUTATIONS,
  JIRA_BOARD_CONFIGURATION_MUTATIONS,
  JIRA_SPRINT_LIFECYCLE_MUTATIONS,
  JIRA_LINK_MUTATIONS,
  JIRA_RELEASE_LIFECYCLE_MUTATIONS,
  JIRA_SAVED_CONFIGURATION_MUTATIONS,
  JIRA_ENTITY_PROPERTY_MUTATIONS,
  type JiraManagedReadToolName,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
  type ActivityLogEventEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { processServerLogSink } from "../process-log-sink.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

// These are projections of existing execution families, not another dispatch or authority table.
// Every schema stays below the unchanged 64-value limit. The union is pinned to the catalog.
const ISSUE_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.issueContext,
  ...JIRA_READ_TOOL_FAMILIES.issues,
  ...JIRA_READ_TOOL_FAMILIES.comment,
  ...JIRA_READ_TOOL_FAMILIES.issueLinks,
  ...JIRA_READ_TOOL_FAMILIES.participation,
  ...JIRA_READ_TOOL_FAMILIES.worklogs,
  ...JIRA_READ_TOOL_FAMILIES.attachments,
  ...JIRA_READ_TOOL_FAMILIES.issueWorkflow,
  ...JIRA_READ_TOOL_FAMILIES.searchPost,
  ...JIRA_READ_TOOL_FAMILIES.worklogBatch,
  ...JIRA_READ_TOOL_FAMILIES.worklogFeeds,
  ...JIRA_ISSUE_LIFECYCLE_MUTATIONS,
  ...JIRA_ISSUE_ACTION_MUTATIONS,
  ...JIRA_LINK_MUTATIONS,
  ...JIRA_EXTENDED_ISSUE_CREATION_MUTATIONS,
] as const;
const PLANNING_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.agile,
  ...JIRA_READ_TOOL_FAMILIES.agileContext,
  ...JIRA_BOARD_CONFIGURATION_MUTATIONS,
  ...JIRA_SPRINT_LIFECYCLE_MUTATIONS,
  ...JIRA_AGILE_PLANNING_MUTATIONS,
] as const;
const PROJECT_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.projectList,
  ...JIRA_READ_TOOL_FAMILIES.projects,
  ...JIRA_READ_TOOL_FAMILIES.components,
  ...JIRA_READ_TOOL_FAMILIES.versions,
  ...JIRA_READ_TOOL_FAMILIES.release,
  ...JIRA_READ_TOOL_FAMILIES.remoteVersionLinks,
  ...JIRA_PROJECT_LIFECYCLE_MUTATIONS,
  ...JIRA_RELEASE_LIFECYCLE_MUTATIONS,
  ...JIRA_VERSION_REMOTE_LINK_MUTATIONS,
  ...JIRA_PROJECT_CATEGORY_MUTATIONS,
] as const;
const METADATA_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.coreMetadata,
  ...JIRA_READ_TOOL_FAMILIES.fieldDirectory,
  ...JIRA_READ_TOOL_FAMILIES.jqlMetadata,
  ...JIRA_READ_TOOL_FAMILIES.resourceLookups,
  ...JIRA_READ_TOOL_FAMILIES.issueMetadata,
  ...JIRA_SCHEMA_MUTATIONS,
] as const;
const SCHEME_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.workflowSchemes,
  ...JIRA_READ_TOOL_FAMILIES.issueTypeSchemes,
  ...JIRA_READ_TOOL_FAMILIES.prioritySchemes,
  ...JIRA_READ_TOOL_FAMILIES.accessSchemes,
  ...JIRA_READ_TOOL_FAMILIES.notificationSchemes,
  ...JIRA_READ_TOOL_FAMILIES.projectAssociations,
  ...JIRA_OPTION_SCHEME_MUTATIONS,
  ...JIRA_WORKFLOW_SCHEME_MUTATIONS,
  ...JIRA_PERMISSION_SCHEME_MUTATIONS,
] as const;
const IDENTITY_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.accountDiagnostics,
  ...JIRA_READ_TOOL_FAMILIES.users,
  ...JIRA_READ_TOOL_FAMILIES.scopedDirectory,
  ...JIRA_READ_TOOL_FAMILIES.directory,
  ...JIRA_READ_TOOL_FAMILIES.roles,
  ...JIRA_READ_TOOL_FAMILIES.privateAccount,
  ...JIRA_READ_TOOL_FAMILIES.anonymization,
  ...JIRA_READ_TOOL_FAMILIES.sessionObservation,
  ...JIRA_IDENTITY_MUTATIONS,
  ...JIRA_PRIVATE_ACCOUNT_MUTATIONS,
  ...JIRA_DIRECTORY_ACCESS_MUTATIONS,
  ...JIRA_GROUP_MUTATIONS,
  ...JIRA_ROLE_MUTATIONS,
  ...JIRA_ANONYMIZATION_UNLOCK_MUTATIONS,
] as const;
const AVATAR_OPERATIONS = [...JIRA_READ_TOOL_FAMILIES.avatars, ...JIRA_AVATAR_MUTATIONS] as const;
const PROPERTY_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.entityProperties,
  ...JIRA_ENTITY_PROPERTY_MUTATIONS,
] as const;
const CONFIGURATION_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.columns,
  ...JIRA_READ_TOOL_FAMILIES.runtimeSettings,
  ...JIRA_READ_TOOL_FAMILIES.instance,
  ...JIRA_READ_TOOL_FAMILIES.configuration,
  ...JIRA_READ_TOOL_FAMILIES.screens,
  ...JIRA_READ_TOOL_FAMILIES.applicationSettings,
  ...JIRA_READ_TOOL_FAMILIES.administrativeObservations,
  ...JIRA_READ_TOOL_FAMILIES.emailTemplatePacks,
  ...JIRA_INSTANCE_SETTING_MUTATIONS,
  ...JIRA_EMAIL_TEMPLATE_MUTATIONS,
  ...JIRA_SCREEN_CONFIGURATION_MUTATIONS,
] as const;
const MAINTENANCE_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.maintenance,
  ...JIRA_READ_TOOL_FAMILIES.jobObservations,
  ...JIRA_MAINTENANCE_MUTATIONS,
] as const;
const SAVED_VIEW_OPERATIONS = [
  ...JIRA_READ_TOOL_FAMILIES.filters,
  ...JIRA_READ_TOOL_FAMILIES.savedViews,
  ...JIRA_SAVED_CONFIGURATION_MUTATIONS,
] as const;

const FACT_FIELDS = {
  stage: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: [
      "action-outcome",
      "provider-call",
      "coding-call",
      "coding-binding",
      "description-projection",
      "field-admission",
    ],
  },
  outcome: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: [
      "succeeded",
      "partial",
      "failed",
      "denied",
      "cancelled",
      "pending-review",
      "bound",
      "refused",
      "completed",
    ],
  },
  reason: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: [
      ...ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
      "none",
      "other",
      "pod-not-found",
      "pod-not-ready",
      "pod-changed",
      "unsupported-runtime",
      "tool-failed",
      "scope-missing",
      "internal",
    ],
  },
} as const;
const FACT_REGISTRATION = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraOperationActivity.recordJiraOperationActivity",
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  releaseImpact: "patch",
} as const;
const ISSUES = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.issues",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ISSUE_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.issues.line"],
});
const PLANNING = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.planning",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: PLANNING_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.planning.line"],
});
const PROJECTS = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.projects",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: PROJECT_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.projects.line"],
});
const METADATA = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.metadata",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: METADATA_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.metadata.line"],
});
const SCHEMES = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.schemes",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: SCHEME_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.schemes.line"],
});
const IDENTITIES = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.identities",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: IDENTITY_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.identities.line"],
});
const AVATARS = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.avatars",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: AVATAR_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.avatars.line"],
});
const PROPERTIES = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.properties",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: PROPERTY_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.properties.line"],
});
const CONFIGURATION = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.configuration",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CONFIGURATION_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.configuration.line"],
});
const MAINTENANCE = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.maintenance",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MAINTENANCE_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.maintenance.line"],
});
const SAVED_VIEWS = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.saved-views",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: SAVED_VIEW_OPERATIONS,
    },
  },
  proofIds: ["jira.operation.saved-views.line"],
});
const CORE = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.core",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: JIRA_CORE_MUTATIONS,
    },
  },
  proofIds: ["jira.operation.core.line"],
});
const LOCAL = defineActivityLogOperation({
  ...FACT_REGISTRATION,
  op: "jira.operation.local",
  fields: {
    ...FACT_FIELDS,
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: JIRA_READ_TOOL_FAMILIES.localCompositions,
    },
  },
  proofIds: ["jira.operation.local.line"],
});

interface Observation {
  readonly stage: (typeof FACT_FIELDS.stage.values)[number];
  readonly outcome: (typeof FACT_FIELDS.outcome.values)[number];
  readonly reason: (typeof FACT_FIELDS.reason.values)[number];
}
interface FactInput {
  readonly tool: string;
  readonly envelope: ActivityLogEventEnvelope;
  readonly observation: Observation;
}
type Fact = (input: FactInput) => ServerLogEvent | undefined;
function belongs<const Names extends readonly string[]>(
  names: Names,
  tool: string,
): tool is Names[number] {
  return (names as readonly string[]).includes(tool);
}
// A family claims only its exact code-owned names; unmatched tools fall through to the next one.
function family<const Names extends readonly string[]>(
  names: Names,
  emit: (operation: Names[number], input: FactInput) => ServerLogEvent,
): Fact {
  return (input) => (belongs(names, input.tool) ? emit(input.tool, input) : undefined);
}
// Each emission names its own static registration. No dynamic registry factory is admitted.
const issueFact = family(ISSUE_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(ISSUES, envelope, { ...observation, operation }),
);
const planningFact = family(PLANNING_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(PLANNING, envelope, { ...observation, operation }),
);
const projectFact = family(PROJECT_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(PROJECTS, envelope, { ...observation, operation }),
);
const metadataFact = family(METADATA_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(METADATA, envelope, { ...observation, operation }),
);
const schemeFact = family(SCHEME_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(SCHEMES, envelope, { ...observation, operation }),
);
const identityFact = family(IDENTITY_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(IDENTITIES, envelope, { ...observation, operation }),
);
const avatarFact = family(AVATAR_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(AVATARS, envelope, { ...observation, operation }),
);
const propertyFact = family(PROPERTY_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(PROPERTIES, envelope, { ...observation, operation }),
);
const configurationFact = family(CONFIGURATION_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(CONFIGURATION, envelope, { ...observation, operation }),
);
const maintenanceFact = family(MAINTENANCE_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(MAINTENANCE, envelope, { ...observation, operation }),
);
const savedViewFact = family(SAVED_VIEW_OPERATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(SAVED_VIEWS, envelope, { ...observation, operation }),
);
const coreFact = family(JIRA_CORE_MUTATIONS, (operation, { envelope, observation }) =>
  activityLogEvent(CORE, envelope, { ...observation, operation }),
);
const localFact = family(
  JIRA_READ_TOOL_FAMILIES.localCompositions,
  (operation, { envelope, observation }) =>
    activityLogEvent(LOCAL, envelope, { ...observation, operation }),
);
const FAMILY_FACTS = [
  issueFact,
  planningFact,
  projectFact,
  metadataFact,
  schemeFact,
  identityFact,
  avatarFact,
  propertyFact,
  configurationFact,
  maintenanceFact,
  savedViewFact,
  coreFact,
  localFact,
];

/** Exact code-owned identity only; unknown or local discovery names never become native facts. */
export function recordJiraOperationActivity(
  sink: ServerLogSink | undefined,
  envelope: ActivityLogEventEnvelope,
  tool: JiraManagedReadToolName | JiraMutationOperation,
  observation: Observation,
): void {
  if (sink === undefined) return;
  for (const fact of FAMILY_FACTS) {
    const event = fact({ tool, envelope, observation });
    if (event === undefined) continue;
    sink.write(event);
    return;
  }
}

/** Provider completion is neither acknowledgement nor proof of native dispatch or availability. */
export function recordJiraProviderCall(
  correlationId: string,
  tool: JiraManagedReadToolName | JiraMutationOperation,
  outcome: "completed" | "failed",
): void {
  try {
    recordJiraOperationActivity(
      processServerLogSink(),
      {
        correlationId,
        level: outcome === "failed" ? "warn" : "info",
      },
      tool,
      {
        stage: "provider-call",
        outcome,
        reason: outcome === "failed" ? "tool-failed" : "none",
      },
    );
  } catch (error) {
    recordActivityLogLoss("port-sink-failed");
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId,
        operation: "atlassian.action.log-failed",
        source: "atlassian-action-activity",
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
}
