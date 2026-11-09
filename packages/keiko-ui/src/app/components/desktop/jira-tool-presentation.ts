import {
  CHAT_TOOL_BATCH_TOOL_NAME,
  type ChatToolExchange,
  type ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MANAGED_ACTION_TYPES,
  JIRA_MUTATION_OPERATIONS,
  JIRA_MUTATION_RESULT_STATES,
  type JiraMutationResultState,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  isCanonicalKnowledgeReviewRef,
  isCanonicalKnowledgeToolRef,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { actionTypeLabelKey } from "./widgets/connectors/connector-labels";
import { JIRA_PROJECT_METADATA_TOOLS } from "./jira-project-metadata-presentation";
import { JIRA_COLLABORATION_TOOLS } from "./jira-collaboration-presentation";
import { JIRA_ADMINISTRATION_TOOLS } from "./jira-administration-presentation";
import { JIRA_PARTICIPATION_TOOLS } from "./jira-participation-presentation";
import { JIRA_FILE_METADATA_TOOLS } from "./jira-file-metadata-presentation";
import { JIRA_SAVED_VIEW_TOOLS } from "./jira-saved-view-presentation";
import { JIRA_DIRECTORY_TOOLS, jiraDirectoryNotice } from "./jira-directory-presentation";
import { JIRA_ACCESS_TOOLS } from "./jira-access-presentation";
import { JIRA_PROJECT_ASSOCIATION_TOOLS } from "./jira-project-association-presentation";
import { JIRA_CORE_METADATA_TOOLS } from "./jira-core-metadata-presentation";
import { JIRA_INSTANCE_TOOLS } from "./jira-instance-presentation";
import { JIRA_ROLE_TOOLS } from "./jira-role-presentation";
import { JIRA_RELEASE_TOOLS } from "./jira-release-presentation";
import { JIRA_LOOKUP_TOOLS, jiraLookupNotice } from "./jira-lookup-presentation";
import { JIRA_JQL_TOOLS } from "./jira-jql-presentation";
import { JIRA_AGILE_CONTEXT_TOOLS } from "./jira-agile-context-presentation";
import {
  JIRA_ADMIN_METADATA_TOOLS,
  jiraAdminMetadataNotice,
} from "./jira-admin-metadata-presentation";
import { JIRA_MAINTENANCE_TOOLS } from "./jira-maintenance-presentation";
import { JIRA_VIEW_SETTINGS_TOOLS } from "./jira-view-settings-presentation";
import { JIRA_JOB_OBSERVATION_TOOLS } from "./jira-job-observation-presentation";
import { JIRA_ADMINISTRATIVE_OBSERVATION_TOOLS } from "./jira-administrative-observation-presentation";
import { JIRA_PROPERTY_KEY_TOOLS } from "./jira-property-presentation";
import {
  JIRA_PROPERTY_MUTATION_TOOLS,
  jiraPropertyMutationIdentityComplete,
} from "./jira-property-mutation-presentation";
import { JIRA_ACCOUNT_DIAGNOSTIC_TOOLS } from "./jira-account-diagnostic-presentation";
import { JIRA_APPLICATION_SETTINGS_TOOLS } from "./jira-application-settings-presentation";
import { JIRA_REMOTE_VERSION_LINK_TOOLS } from "./jira-remote-version-link-presentation";
import {
  JIRA_SAVED_CONFIGURATION_WRITE_TOOLS,
  jiraSavedConfigurationIdentityComplete,
  jiraSavedConfigurationDeletionUnconfirmed,
} from "./jira-saved-configuration-presentation";
import {
  JIRA_RELEASE_LIFECYCLE_TOOLS,
  jiraReleaseLifecycleIdentityComplete,
  jiraReleaseReferenceEffectsUnconfirmed,
} from "./jira-release-lifecycle-presentation";
import {
  JIRA_LINK_MUTATION_TOOLS,
  jiraLinkMutationIdentityComplete,
} from "./jira-link-mutation-presentation";
import {
  JIRA_CONFIGURATION_MUTATION_TOOLS,
  jiraConfigurationMutationIdentityComplete,
  jiraConfigurationConfirmationUnavailable,
} from "./jira-configuration-mutation-presentation";
import {
  JIRA_PLANNING_MUTATION_TOOLS,
  jiraPlanningIdentityComplete,
  jiraPlanningConfirmationUnavailable,
} from "./jira-planning-mutation-presentation";
import {
  JIRA_ACCESS_CONFIGURATION_TOOLS,
  jiraAccessConfigurationIdentityComplete,
  jiraAccessConfirmationUnavailable,
  jiraAccessActorNoopSupported,
} from "./jira-access-configuration-presentation";
import {
  JIRA_SCHEME_ADMINISTRATION_TOOLS,
  jiraSchemeAdministrationIdentityComplete,
  jiraSchemeConfirmationUnavailable,
  jiraSchemeNoopSupported,
} from "./jira-scheme-administration-presentation";
import {
  JIRA_INSTANCE_ADMINISTRATION_WRITE_TOOLS,
  JIRA_INSTANCE_SETTING_WRITE_TOOLS,
  jiraInstanceAdministrationIdentityComplete,
  jiraInstanceConfirmationUnavailable,
} from "./jira-instance-administration-presentation";
import {
  JIRA_SYSTEM_ACTION_TOOLS,
  jiraSystemActionIdentityComplete,
  jiraSystemConfirmationUnavailable,
  jiraSystemNoopSupported,
} from "./jira-system-action-receipt";
import {
  JIRA_ACCOUNT_RESOURCE_WRITE_TOOLS,
  jiraAccountResourceIdentityComplete,
  jiraAccountResourceConfirmationUnavailable,
  jiraAccountResourceNoopSupported,
} from "./jira-account-resource-presentation";
import { REQUIREMENTS_TOOL_ALIAS, requirementsReadGroups } from "./jira-tool-progress";
const LOCALLY_PAGED_TOOLS = new Set([
  ...JIRA_REMOTE_VERSION_LINK_TOOLS,
  ...JIRA_ACCOUNT_DIAGNOSTIC_TOOLS,
  ...JIRA_APPLICATION_SETTINGS_TOOLS,
  "jira_pinned_comments",
  "jira_subtasks",
  "jira_remote_links",
  ...JIRA_PROJECT_METADATA_TOOLS,
  ...JIRA_COLLABORATION_TOOLS,
  ...JIRA_SAVED_VIEW_TOOLS,
  ...JIRA_FILE_METADATA_TOOLS,
  ...JIRA_PARTICIPATION_TOOLS,
  ...JIRA_ADMINISTRATION_TOOLS,
  ...JIRA_DIRECTORY_TOOLS,
  ...JIRA_ACCESS_TOOLS,
  ...JIRA_PROJECT_ASSOCIATION_TOOLS,
  ...JIRA_CORE_METADATA_TOOLS,
  ...JIRA_INSTANCE_TOOLS,
  ...JIRA_ROLE_TOOLS,
  ...JIRA_RELEASE_TOOLS,
  ...JIRA_LOOKUP_TOOLS,
  ...JIRA_JQL_TOOLS,
  ...JIRA_AGILE_CONTEXT_TOOLS,
  ...JIRA_ADMIN_METADATA_TOOLS,
  ...JIRA_MAINTENANCE_TOOLS,
  ...JIRA_VIEW_SETTINGS_TOOLS,
  ...JIRA_JOB_OBSERVATION_TOOLS,
  ...JIRA_ADMINISTRATIVE_OBSERVATION_TOOLS,
  ...JIRA_PROPERTY_KEY_TOOLS,
]);

const OUTCOME_KEYS: Readonly<Record<JiraMutationResultState, WidgetMessageKey>> = {
  "not-dispatched": "chat.jira.write.notDispatched",
  rejected: "chat.jira.write.rejected",
  succeeded: "chat.jira.write.succeeded",
  "succeeded-unconfirmed": "chat.jira.write.unconfirmed",
  unknown: "chat.jira.write.unknown",
  pending: "chat.jira.write.pending",
};
const MCP_OUTCOME_KEYS: Readonly<Record<JiraMutationResultState, WidgetMessageKey>> = {
  "not-dispatched": "chat.mcp.write.notDispatched",
  rejected: "chat.mcp.write.rejected",
  succeeded: "chat.mcp.write.succeeded",
  "succeeded-unconfirmed": "chat.mcp.write.unconfirmed",
  unknown: "chat.mcp.write.unknown",
  pending: "chat.mcp.write.pending",
};
const MANAGED_TOOLS = [...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS];
const CATALOG_TOOL_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  jira_discover: "chat.jira.catalog.discover",
  jira_describe: "chat.jira.catalog.describe",
};
export const JIRA_CATALOG_TOOLS: ReadonlySet<string> = new Set(Object.keys(CATALOG_TOOL_LABELS));
/** A familiar prefix does not give an unknown result the native Jira presentation contract. */
export function isKnownJiraToolAlias(name: string): boolean {
  return (
    JIRA_CATALOG_TOOLS.has(name) ||
    MANAGED_TOOLS.some((operation) => operation.replace(/[.-]/gu, "_") === name)
  );
}
const KNOWLEDGE_TOOLS: Readonly<
  Record<
    string,
    {
      readonly label: WidgetMessageKey;
      readonly details: WidgetMessageKey;
    }
  >
> = {
  knowledge_requirements: {
    label: "chat.requirements.tool",
    details: "chat.requirements.details",
  },
  knowledge_documents: {
    label: "chat.documents.tool",
    details: "chat.documents.details",
  },
  knowledge_review: {
    label: "chat.review.tool",
    details: "chat.review.details",
  },
};
/** A saved alias alone cannot turn an external payload into a Knowledge receipt. */
export function isCanonicalKnowledgeExchange(exchange: ChatToolExchange): boolean {
  const ref = exchange.result?.toolRef;
  if (ref === undefined || ref === null) return false;
  return isCanonicalKnowledgeToolRef(exchange.call.name, ref);
}

const REQUIREMENTS_CUT_COUNTS = ["unitsOmitted", "documentsOmitted", "documentsNotExtracted"];

/** A draft and an attachment are governed like a create and an edit, but are neither to the human. */
const OPERATION_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  "jira.draft": "chat.jira.draft.operation",
  "jira.attach": "chat.jira.attach.operation",
};
function jiraOperationLabel(operation: keyof typeof JIRA_MANAGED_ACTION_TYPES): WidgetMessageKey {
  return OPERATION_LABELS[operation] ?? actionTypeLabelKey(JIRA_MANAGED_ACTION_TYPES[operation]);
}
const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) ? value.length === 0 : Object.keys(value as object).length === 0);
/** An edit carrying nothing but links updates no field of the issue. */
function onlyLinks(args: ChatToolExchange["call"]["arguments"]): boolean {
  const links = args.links;
  return Array.isArray(links) && links.length > 0 && isEmpty(args.fields) && isEmpty(args.updates);
}
/** What this one call does to the human, where the operation alone would say something else. */
export function jiraCallLabel(
  operation: keyof typeof JIRA_MANAGED_ACTION_TYPES,
  args: ChatToolExchange["call"]["arguments"],
): WidgetMessageKey {
  return operation === "jira.edit" && onlyLinks(args)
    ? "chat.jira.link.operation"
    : jiraOperationLabel(operation);
}
export function jiraToolLabel(exchange: {
  readonly call: Pick<ChatToolExchange["call"], "name" | "arguments">;
}): WidgetMessageKey {
  if (exchange.call.name === CHAT_TOOL_BATCH_TOOL_NAME)
    return actionTypeLabelKey("jira.draft-batch");
  const catalog = CATALOG_TOOL_LABELS[exchange.call.name];
  if (catalog !== undefined) return catalog;
  const knowledge = KNOWLEDGE_TOOLS[exchange.call.name];
  if (knowledge !== undefined) return knowledge.label;
  const operation = MANAGED_TOOLS.find(
    (name) => name.replace(/[.-]/gu, "_") === exchange.call.name,
  );
  return operation === undefined
    ? "chat.jira.tool"
    : jiraCallLabel(operation, exchange.call.arguments);
}
/** A local envelope refusal is not a Jira permission response or evidence of a remote effect. */
export function jiraLocalAccessDenialNotice(
  exchange: ChatToolExchange,
): WidgetMessageKey | undefined {
  const result = exchange.result;
  return result?.status === "denied" &&
    result.reason === "effect-denied" &&
    result.data === null &&
    MANAGED_TOOLS.some((name) => name.replace(/[.-]/gu, "_") === exchange.call.name)
    ? "atlassianConnectors.denied.reason.connector-access-denied"
    : undefined;
}
const LOCAL_READ_FAILURE_NOTICES: ReadonlyMap<string, WidgetMessageKey> = new Map([
  ["denied:effect-denied", "chat.jira.outcome.failure.localAuthority"],
  ["failed:handler-failed", "chat.jira.outcome.failure.localHandler"],
  ["timeout:deadline-exceeded", "chat.jira.outcome.failure.readDeadline"],
  ["cancelled:parent-cancelled", "chat.jira.outcome.failure.cancelled"],
]);
/** Technical read outcomes retain their exact closed envelope cause, including after history reload. */
export function jiraLocalReadFailureNotice(
  exchange: ChatToolExchange,
): WidgetMessageKey | undefined {
  const result = exchange.result;
  if (
    result?.data !== null ||
    !JIRA_MANAGED_READ_TOOLS.some((name) => name.replace(/[.-]/gu, "_") === exchange.call.name)
  )
    return undefined;
  return LOCAL_READ_FAILURE_NOTICES.get(`${result.status}:${result.reason}`);
}
export function jiraToolRegionLabel(exchange: ChatToolExchange): WidgetMessageKey {
  const knowledge = KNOWLEDGE_TOOLS[exchange.call.name];
  if (knowledge !== undefined) return knowledge.label;
  return exchange.call.name.startsWith("mcp_") ? "chat.mcp.tool" : "chat.jira.tool";
}
export function jiraToolDetailsLabel(exchange: ChatToolExchange): WidgetMessageKey {
  const knowledge = KNOWLEDGE_TOOLS[exchange.call.name];
  if (knowledge !== undefined) return knowledge.details;
  return exchange.call.name.startsWith("mcp_") ? "chat.mcp.details" : "chat.jira.details";
}
function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
/** The inventory is cut only when the tool's own totals name an omission; a further page is not. */
type CompletedResult = Extract<NonNullable<ChatToolExchange["result"]>, { status: "completed" }>;
function requirementsCut(result: CompletedResult): boolean {
  const data = plainRecord(result.data);
  const totals = plainRecord(data?.totals);
  const reasons = totals?.cutReasons;
  return (
    requirementChangesCut(data) ||
    (Array.isArray(reasons) && reasons.length > 0) ||
    REQUIREMENTS_CUT_COUNTS.some((name) => {
      const value = totals?.[name];
      return typeof value === "number" && value > 0;
    })
  );
}
function requirementChangesCut(data: Record<string, unknown> | undefined): boolean {
  const changes = plainRecord(data?.changes);
  return (
    plainRecord(changes?.baseline)?.complete === false ||
    (Array.isArray(changes?.truncated) && changes.truncated.length > 0)
  );
}
function knowledgeCut(result: CompletedResult): boolean {
  const data = plainRecord(result.data);
  const coverage = plainRecord(data?.coverage);
  const cursor = data?.nextCursor;
  return (
    requirementsCut(result) ||
    result.page.truncated ||
    (typeof cursor === "string" && cursor.length > 0) ||
    [
      "inventoryComplete",
      "documentComplete",
      "searchComplete",
      "windowReviewComplete",
      "documentReviewComplete",
      "documentReadable",
    ].some((field) => coverage?.[field] === false)
  );
}
function requirementsPartialNotice(exchange: ChatToolExchange): WidgetMessageKey | undefined {
  if (exchange.result?.status !== "completed") return undefined;
  if (requirementsReadGroups([exchange]).members.size > 0 && knowledgeCut(exchange.result))
    return "chat.requirements.partial";
  return requirementsReadGroups([exchange]).members.size === 0 && requirementsCut(exchange.result)
    ? "chat.requirements.partial"
    : undefined;
}
/** The note a completed read of a partial result carries, or undefined for a complete one. */
export function jiraToolPartialNotice(exchange: ChatToolExchange): WidgetMessageKey | undefined {
  if (exchange.call.name.startsWith("mcp_") || exchange.result?.status !== "completed")
    return undefined;
  // Paged unit reads are counted by the consolidated card, which names what a cut left out.
  if (exchange.call.name === REQUIREMENTS_TOOL_ALIAS) return requirementsPartialNotice(exchange);

  if (KNOWLEDGE_TOOLS[exchange.call.name] !== undefined)
    return knowledgeCut(exchange.result) ? "chat.knowledge.partial" : undefined;
  return jiraReadPartialNotice(exchange, exchange.result);
}
function jiraReadPartialNotice(
  exchange: ChatToolExchange,
  result: CompletedResult,
): WidgetMessageKey | undefined {
  const data = plainRecord(result.data) ?? {};
  const directory =
    jiraDirectoryNotice(exchange.call.name, data) ??
    jiraLookupNotice(exchange.call.name, data) ??
    jiraAdminMetadataNotice(exchange.call.name, data);
  if (directory !== undefined) return directory;
  return result.page.truncated || projectMetadataPageCut(exchange)
    ? "chat.jira.partial"
    : undefined;
}

function projectMetadataPageCut(exchange: ChatToolExchange): boolean {
  if (!LOCALLY_PAGED_TOOLS.has(exchange.call.name)) return false;
  const data = plainRecord(exchange.result?.data);
  const startAt = data?.startAt;
  const next = data?.nextStartAt;
  return (
    (typeof startAt === "number" && Number.isSafeInteger(startAt) && startAt > 0) ||
    (typeof next === "number" && Number.isSafeInteger(next) && next > 0)
  );
}
function mutationOutcome(exchange: ChatToolExchange): JiraMutationResultState | undefined {
  const data = exchange.result?.data;
  const value =
    data !== null && typeof data === "object" && "outcome" in data ? data.outcome : undefined;
  return JIRA_MUTATION_RESULT_STATES.find(
    (outcome) => outcome === (exchange.mutationOutcome ?? value),
  );
}
function isMutation(exchange: ChatToolExchange): boolean {
  return JIRA_MUTATION_OPERATIONS.some(
    (name) => name.replace(/[.-]/gu, "_") === exchange.call.name,
  );
}
const MUTATION_IDENTITY_PRESENTERS = [
  [JIRA_ACCOUNT_RESOURCE_WRITE_TOOLS, jiraAccountResourceIdentityComplete],
  [JIRA_SYSTEM_ACTION_TOOLS, jiraSystemActionIdentityComplete],
  [JIRA_SCHEME_ADMINISTRATION_TOOLS, jiraSchemeAdministrationIdentityComplete],
  [JIRA_INSTANCE_ADMINISTRATION_WRITE_TOOLS, jiraInstanceAdministrationIdentityComplete],
  [JIRA_ACCESS_CONFIGURATION_TOOLS, jiraAccessConfigurationIdentityComplete],
  [JIRA_PROPERTY_MUTATION_TOOLS, jiraPropertyMutationIdentityComplete],
  [JIRA_RELEASE_LIFECYCLE_TOOLS, jiraReleaseLifecycleIdentityComplete],
  [JIRA_LINK_MUTATION_TOOLS, jiraLinkMutationIdentityComplete],
  [JIRA_CONFIGURATION_MUTATION_TOOLS, jiraConfigurationMutationIdentityComplete],
  [JIRA_PLANNING_MUTATION_TOOLS, jiraPlanningIdentityComplete],
  [JIRA_SAVED_CONFIGURATION_WRITE_TOOLS, jiraSavedConfigurationIdentityComplete],
] as const;
function mutationIdentityMissing(exchange: ChatToolExchange): boolean {
  const presenter = MUTATION_IDENTITY_PRESENTERS.find(([tools]) => tools.has(exchange.call.name));
  return (
    presenter !== undefined &&
    !presenter[1](exchange.call.name, plainRecord(exchange.result?.data) ?? {})
  );
}
const TOOL_CONFIRMATION_REFUSALS = [
  jiraSystemConfirmationUnavailable,
  jiraSavedConfigurationDeletionUnconfirmed,
  jiraReleaseReferenceEffectsUnconfirmed,
  jiraConfigurationConfirmationUnavailable,
  jiraPlanningConfirmationUnavailable,
  jiraAccessConfirmationUnavailable,
  jiraInstanceConfirmationUnavailable,
];
function mutationConfirmationUnavailable(
  tool: string,
  args?: unknown,
  source: Readonly<Record<string, unknown>> = {},
): boolean {
  return (
    TOOL_CONFIRMATION_REFUSALS.some((refuses) => refuses(tool)) ||
    jiraSchemeConfirmationUnavailable(tool, args) ||
    jiraAccountResourceConfirmationUnavailable(tool, args, source)
  );
}
function unconfirmedNoopSupported(tool: string): boolean {
  return (
    jiraAccessActorNoopSupported(tool) ||
    jiraSchemeNoopSupported(tool) ||
    JIRA_INSTANCE_SETTING_WRITE_TOOLS.has(tool)
  );
}
function mutationNoopUnsupported(exchange: ChatToolExchange): boolean {
  if (JIRA_ACCOUNT_RESOURCE_WRITE_TOOLS.has(exchange.call.name))
    return !jiraAccountResourceNoopSupported(exchange.call.name);
  if (JIRA_SYSTEM_ACTION_TOOLS.has(exchange.call.name))
    return !jiraSystemNoopSupported(exchange.call.name);
  if (JIRA_SCHEME_ADMINISTRATION_TOOLS.has(exchange.call.name))
    return !jiraSchemeNoopSupported(exchange.call.name);
  return (
    mutationConfirmationUnavailable(exchange.call.name, exchange.call.arguments) &&
    !unconfirmedNoopSupported(exchange.call.name)
  );
}
/** Only an explicit, rejected no-change receipt can soften a conflict; journal state wins. */
export function jiraMutationUnchanged(exchange: ChatToolExchange): boolean {
  const data = plainRecord(exchange.result?.data);
  if (mutationIdentityMissing(exchange)) return false;
  if (mutationNoopUnsupported(exchange)) return false;
  return (
    isMutation(exchange) &&
    mutationOutcome(exchange) === "rejected" &&
    data?.outcome === "rejected" &&
    data.reason === "conflict" &&
    data.unchanged === true
  );
}
/** Why a draft batch was refused, in words a business user reads; any other reason stays generic. */
const BATCH_REFUSAL_KEYS: Readonly<Record<string, WidgetMessageKey>> = {
  "no-requirements": "chat.jira.batch.refused.noRequirements",
  "no-knowledge-pod": "chat.jira.batch.refused.noKnowledgePod",
  "project-not-found": "chat.jira.batch.refused.projectNotFound",
  "issue-type-not-found": "chat.jira.batch.refused.issueTypeNotFound",
  "no-usable-issue-type": "chat.jira.batch.refused.noUsableIssueType",
};
function localToolRefusalState(exchange: ChatToolExchange): WidgetMessageKey | undefined {
  const { result } = exchange;
  if (JIRA_CATALOG_TOOLS.has(exchange.call.name) && plainRecord(result?.data)?.outcome === "failed")
    return "chat.jira.unavailable";
  if (exchange.call.name !== CHAT_TOOL_BATCH_TOOL_NAME || result?.status !== "failed")
    return undefined;
  const reason = plainRecord(result.data)?.reason;
  return typeof reason === "string" ? BATCH_REFUSAL_KEYS[reason] : undefined;
}
function succeededWithoutConfirmation(exchange: ChatToolExchange): boolean {
  return mutationConfirmationUnavailable(
    exchange.call.name,
    exchange.call.arguments,
    plainRecord(exchange.result?.data) ?? {},
  );
}
function awaitsHumanInput(
  exchange: ChatToolExchange,
  turnState: ChatTurnState | undefined,
): boolean {
  return (
    exchange.result === undefined &&
    exchange.mutationOutcome === undefined &&
    exchange.humanInput?.state === "awaiting-input" &&
    turnState === "pending"
  );
}
function managedMutationState(
  exchange: ChatToolExchange,
  turnState: ChatTurnState | undefined,
): WidgetMessageKey {
  const outcome = mutationOutcome(exchange);
  if (outcome === "succeeded" && mutationIdentityMissing(exchange)) return OUTCOME_KEYS.unknown;
  if (outcome === "succeeded" && succeededWithoutConfirmation(exchange))
    return OUTCOME_KEYS["succeeded-unconfirmed"];
  if (outcome !== undefined)
    return jiraMutationUnchanged(exchange) ? "chat.jira.write.unchanged" : OUTCOME_KEYS[outcome];
  return exchange.result === undefined && turnState === "pending"
    ? OUTCOME_KEYS.pending
    : OUTCOME_KEYS.unknown;
}
export function jiraToolState(
  exchange: ChatToolExchange,
  turnState: ChatTurnState | undefined,
): WidgetMessageKey {
  if (awaitsHumanInput(exchange, turnState)) return "chat.jira.humanInput.waiting";
  if (exchange.call.name.startsWith("mcp_") && exchange.mutationOutcome !== undefined)
    return MCP_OUTCOME_KEYS[exchange.mutationOutcome];
  if (isMutation(exchange)) return managedMutationState(exchange, turnState);
  if (exchange.result === undefined)
    return turnState === "pending" ? "chat.jira.running" : "chat.jira.resultUnavailable";
  const refusal = localToolRefusalState(exchange);
  if (refusal !== undefined) return refusal;
  if (exchange.result.status === "completed") return "chat.jira.complete";
  return "chat.jira.unavailable";
}
export function jiraToolOutcomeHelp(state: WidgetMessageKey): WidgetMessageKey | undefined {
  switch (state) {
    case "chat.jira.write.unchanged":
      return "chat.jira.write.unchangedHelp";
    case "chat.mcp.write.unconfirmed":
      return "chat.mcp.write.unconfirmedHelp";
    case "chat.mcp.write.unknown":
      return "chat.mcp.write.unknownHelp";
    case "chat.mcp.write.pending":
      return "chat.mcp.write.pendingHelp";
    case "chat.jira.write.unconfirmed":
      return "chat.jira.write.unconfirmedHelp";
    case "chat.jira.write.unknown":
      return "chat.jira.write.unknownHelp";
    case "chat.jira.write.pending":
      return "chat.jira.write.pendingHelp";
    default:
      return undefined;
  }
}

function canonicalReviewFailureData(
  result: ChatToolExchange["result"],
): Record<string, unknown> | undefined {
  if (
    result === undefined ||
    !isCanonicalKnowledgeReviewRef(result.toolRef) ||
    result.status !== "failed" ||
    result.reason !== "provider-reported-error"
  )
    return undefined;
  return plainRecord(result.data);
}

/** Only this versioned, source-checked managed receipt can identify a review-stage failure. */
export function knowledgeReviewFailureNotice(
  exchange: ChatToolExchange,
): WidgetMessageKey | undefined {
  const data = canonicalReviewFailureData(exchange.result);
  if (
    data?.outcome !== "failed" ||
    data.sourceAvailable !== true ||
    data.reason !== data.failureStage
  )
    return undefined;
  switch (data.failureStage) {
    case "model-output-invalid":
      return "chat.review.invalidModelOutput";
    case "model-port-unavailable":
      return "chat.review.modelUnavailable";
    case "budget-port-unavailable":
      return "chat.review.budgetUnavailable";
    default:
      return undefined;
  }
}
