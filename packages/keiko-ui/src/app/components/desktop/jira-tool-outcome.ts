import {
  CHAT_TOOL_BATCH_COUNT_MAX,
  type ChatToolExchange,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_DRAFT_PROBLEMS,
  JIRA_FIELD_VALIDATION_FAILURES,
  type JiraDraftProblemCode,
  JIRA_TEMPLATE_RULE_IDS,
  type JiraFieldValidationFailure,
  type JiraTemplateRuleId,
  JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE,
  JIRA_ATTACHMENT_OPERATIONS,
  isJiraReleaseScopeRefusal,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  JIRA_AGILE_TOOLS,
  JIRA_SPRINT_TOOLS,
  jiraAgileDetails,
  type JiraOutcomeFact,
  type JiraAgileDetails,
} from "./jira-agile-presentation";
import {
  JIRA_PROJECT_METADATA_TOOLS,
  jiraProjectMetadataDetails,
} from "./jira-project-metadata-presentation";
import {
  JIRA_COLLABORATION_TOOLS,
  jiraCollaborationDetails,
} from "./jira-collaboration-presentation";
import { JIRA_SAVED_VIEW_TOOLS, jiraSavedViewDetails } from "./jira-saved-view-presentation";
import {
  JIRA_FILE_METADATA_TOOLS,
  jiraFileMetadataDetails,
} from "./jira-file-metadata-presentation";
import {
  JIRA_PARTICIPATION_TOOLS,
  jiraParticipationDetails,
} from "./jira-participation-presentation";
import {
  JIRA_ADMINISTRATION_TOOLS,
  jiraAdministrationDetails,
} from "./jira-administration-presentation";
import {
  isCanonicalKnowledgeExchange,
  isKnownJiraToolAlias,
  JIRA_CATALOG_TOOLS,
  jiraBatchRefusalKey,
  jiraToolLabel,
  jiraLocalReadFailureNotice,
  jiraMutationUnchanged,
  jiraToolOnlyReads,
} from "./jira-tool-presentation";
import { JIRA_DIRECTORY_TOOLS, jiraDirectoryDetails } from "./jira-directory-presentation";
import { JIRA_ACCESS_TOOLS, jiraAccessDetails } from "./jira-access-presentation";
import {
  JIRA_PROJECT_ASSOCIATION_TOOLS,
  jiraProjectAssociationDetails,
} from "./jira-project-association-presentation";
import {
  JIRA_CORE_METADATA_TOOLS,
  jiraCoreMetadataDetails,
} from "./jira-core-metadata-presentation";
import { JIRA_INSTANCE_TOOLS, jiraInstanceDetails } from "./jira-instance-presentation";
import { JIRA_ROLE_TOOLS, jiraRoleDetails } from "./jira-role-presentation";
import { JIRA_RELEASE_TOOLS, jiraReleaseDetails } from "./jira-release-presentation";
import { JIRA_LOOKUP_TOOLS, jiraLookupDetails } from "./jira-lookup-presentation";
import { JIRA_JQL_TOOLS, jiraJqlDetails } from "./jira-jql-presentation";
import {
  JIRA_AGILE_CONTEXT_TOOLS,
  JIRA_AGILE_CONTEXT_METADATA_TOOLS,
  jiraAgileContextDetails,
} from "./jira-agile-context-presentation";
import {
  JIRA_ADMIN_METADATA_TOOLS,
  jiraAdminMetadataDetails,
} from "./jira-admin-metadata-presentation";
import {
  JIRA_RUNTIME_SETTINGS_TOOLS,
  jiraRuntimeSettingsDetails,
} from "./jira-runtime-settings-presentation";
import { JIRA_MAINTENANCE_TOOLS, jiraMaintenanceDetails } from "./jira-maintenance-presentation";
import {
  JIRA_VIEW_SETTINGS_TOOLS,
  jiraViewSettingsDetails,
} from "./jira-view-settings-presentation";
import {
  JIRA_JOB_OBSERVATION_TOOLS,
  jiraJobObservationDetails,
} from "./jira-job-observation-presentation";
import {
  JIRA_ACCOUNT_DIAGNOSTIC_TOOLS,
  jiraAccountDiagnosticDetails,
} from "./jira-account-diagnostic-presentation";
import {
  JIRA_ADMINISTRATIVE_OBSERVATION_TOOLS,
  jiraAdministrativeObservationDetails,
} from "./jira-administrative-observation-presentation";
import {
  JIRA_APPLICATION_SETTINGS_TOOLS,
  jiraApplicationSettingsDetails,
} from "./jira-application-settings-presentation";
import {
  JIRA_REMOTE_VERSION_LINK_TOOLS,
  jiraRemoteVersionLinkDetails,
} from "./jira-remote-version-link-presentation";
import { JIRA_WORKLOG_FEED_TOOLS, jiraWorklogFeedDetails } from "./jira-worklog-feed-presentation";
import {
  JIRA_IDENTITY_OBSERVATION_TOOLS,
  jiraIdentityObservationDetails,
} from "./jira-identity-observation-presentation";
import {
  JIRA_SELECTED_WORKLOG_TOOLS,
  jiraSelectedWorklogDetails,
} from "./jira-selected-worklog-presentation";
import {
  JIRA_SAVED_CONFIGURATION_WRITE_TOOLS,
  jiraSavedConfigurationDetails,
  jiraSavedConfigurationFilterContextComplete,
} from "./jira-saved-configuration-presentation";
import {
  JIRA_RELEASE_LIFECYCLE_TOOLS,
  jiraReleaseLifecycleDetails,
} from "./jira-release-lifecycle-presentation";
import {
  JIRA_LINK_MUTATION_TOOLS,
  jiraLinkMutationDetails,
} from "./jira-link-mutation-presentation";
import {
  JIRA_CONFIGURATION_MUTATION_TOOLS,
  jiraConfigurationMutationDetails,
} from "./jira-configuration-mutation-presentation";
import {
  JIRA_PLANNING_MUTATION_TOOLS,
  jiraPlanningMutationDetails,
} from "./jira-planning-mutation-presentation";
import {
  JIRA_ACCESS_CONFIGURATION_TOOLS,
  jiraAccessConfigurationDetails,
} from "./jira-access-configuration-presentation";
import {
  JIRA_SCHEME_ADMINISTRATION_TOOLS,
  jiraSchemeAdministrationDetails,
} from "./jira-scheme-administration-presentation";
import {
  JIRA_INSTANCE_ADMINISTRATION_TOOLS,
  JIRA_INSTANCE_ADMINISTRATION_WRITE_TOOLS,
  jiraInstanceAdministrationDetails,
} from "./jira-instance-administration-presentation";
import { JIRA_SYSTEM_ACTION_TOOLS } from "./jira-system-action-receipt";
import { jiraSystemActionDetails } from "./jira-system-action-presentation";
import {
  JIRA_ACCOUNT_RESOURCE_TOOLS,
  JIRA_ACCOUNT_RESOURCE_WRITE_TOOLS,
  jiraAccountResourceDetails,
} from "./jira-account-resource-presentation";
import { JIRA_PRIVATE_ACCOUNT_TOOLS } from "./jira-private-account-presentation";
import {
  JIRA_RESOURCE_LIFECYCLE_TOOLS,
  jiraResourceLifecycleIdentityComplete,
} from "./jira-resource-lifecycle-presentation";
import {
  JIRA_SPRINT_REVIEW_TOOLS,
  jiraSprintReviewDetails,
} from "./jira-sprint-review-presentation";
import { JIRA_PROPERTY_TOOLS, jiraPropertyDetails } from "./jira-property-presentation";
import { JIRA_MONITORING_WRITE_TOOLS, jiraMonitoringDetails } from "./jira-monitoring-presentation";
import {
  JIRA_PROPERTY_MUTATION_TOOLS,
  jiraPropertyMutationDetails,
} from "./jira-property-mutation-presentation";
import {
  JIRA_ISSUE_CONTEXT_METADATA_TOOLS,
  jiraIssueContextDetails,
  jiraIssuePickerGroups,
  jiraPinnedCommentDetails,
} from "./jira-issue-context-presentation";
import { jiraPresentationNativeText } from "./jira-presentation-values";
import { jiraReadableText } from "./jira-readable-text";

/** One Jira issue a tool call created, changed or read, as a person recognises it. */
interface JiraOutcomeIssue {
  readonly key: string;
  readonly href?: string;
  /** The result says the issue already existed; it was found, not created. */
  readonly existing?: true;
}
/**
 * How a person recognises a draft item: the summary they reviewed, else its place in the draft. The
 * model's own item reference never reaches the screen (#4355).
 */
export interface JiraOutcomeItemName {
  /** 1-based place in the draft as the call listed it (the result's order when the call lists none). */
  readonly position: number;
  readonly summary?: string;
  /** The result names an item the call never listed, so no place of the call applies. */
  readonly unlisted?: true;
  /** Another item of the draft carries the same summary or reference, so the place is shown too. */
  readonly ambiguous?: true;
}
/** One draft item Keiko's own field check refused before Jira saw it. */
interface JiraOutcomeItemValidation {
  readonly item: JiraOutcomeItemName;
  readonly validation: JiraFieldValidationFailure;
}
export interface JiraOutcomeItem {
  readonly key?: string;
  readonly projectId?: string;
  readonly name?: string;
  /** A code-owned title for catalog metadata; never a result-provided translation key. */
  readonly nameLabel?: WidgetMessageKey;
  readonly body?: string;
  readonly href?: string;
  readonly boardHref?: string;
  readonly filterHref?: string;
  readonly status?: string;
  readonly labels: readonly WidgetMessageKey[];
  readonly facts: readonly JiraOutcomeFact[];
}
interface JiraOutcomeProblem {
  /** The draft item the refusal belongs to. */
  readonly item?: JiraOutcomeItemName;
  readonly field?: string;
  readonly message: string;
}
/**
 * One card sentence per draft refusal that is not a field problem, by `data.draftRefusal`: the
 * draft was not found, it changed after review, or the Jira connection changed. A refusal that
 * `draft-invalid` carries is named by its problem instead. The test walks JIRA_DRAFT_REFUSALS, so a
 * refusal the contract gains without a sentence here fails there.
 */
export const JIRA_DRAFT_REFUSAL_MESSAGES: Readonly<Record<string, WidgetMessageKey>> = {
  "draft-not-found": "chat.jira.outcome.draftRefusal.draft-not-found",
  "draft-changed": "chat.jira.outcome.draftRefusal.draft-changed",
  "connection-changed": "chat.jira.outcome.draftRefusal.connection-changed",
};
/** Why Keiko refused a whole draft before sending it: a closed code and the item it concerns. */
interface JiraOutcomeDraftProblem {
  readonly problem: JiraDraftProblemCode;
  readonly position?: number;
}
export interface JiraOutcomeRule {
  readonly ruleId: JiraTemplateRuleId;
  readonly subject: string;
}
export interface JiraToolOutcomeView {
  readonly facts?: readonly JiraOutcomeFact[];
  readonly labels?: readonly WidgetMessageKey[];
  readonly resultsLabel?: WidgetMessageKey;
  readonly items: readonly JiraOutcomeItem[];
  readonly returnedCount: number | undefined;
  readonly total: number | undefined;
  readonly unreadableCount: number;
  readonly stagedCount: number | undefined;
  readonly unresolvedCount: number | undefined;
  /** Issues of a draft write that were not created (failed, skipped, still pending or excluded). */
  readonly notCreatedCount?: number;
  readonly problems: readonly JiraOutcomeProblem[];
  /** Absent unless the draft itself was refused; a person reads what to change from it. */
  readonly draftProblem?: JiraOutcomeDraftProblem;
  /** The sentence for a refusal that is not a field problem (not found, changed, connection). */
  readonly draftRefusal?: WidgetMessageKey;
  readonly rules: readonly JiraOutcomeRule[];
  /** Template rules an edit that succeeded left broken in fields it did not touch (#4354). */
  readonly templateNotices: readonly JiraOutcomeRule[];
  readonly validation: JiraFieldValidationFailure | undefined;
  /** Keiko's own field check refused these draft items; each is named by its summary. */
  readonly itemValidations: readonly JiraOutcomeItemValidation[];
  /** Problems beyond the shown ones, counted rather than dropped silently. */
  readonly hiddenProblemCount: number;
  readonly failure: WidgetMessageKey | undefined;
  /**
   * `count` lists at most JIRA_OUTCOME_ITEMS_SHOWN issues and counts the rest in "and N more";
   * `disclosure` keeps every item behind a bounded disclosure.
   */
  readonly overflow: "count" | "disclosure";
  /** How many rows stand open before the rest sit behind a disclosure. */
  readonly visibleItems?: number;
  /** Issues a compact result counted but did not list; added to the hidden count in `count` mode. */
  readonly unlistedItemCount: number;
}

export const JIRA_OUTCOME_ITEMS_SHOWN = 5;
/**
 * A draft write lists every issue it created, each with its link (#4355): this many rows stand
 * open in the card and the rest sit behind a disclosure that mounts them only when it is opened.
 * Every key a compact result carries is expanded from its ranges, up to the largest batch.
 */
const JIRA_OUTCOME_WRITE_ITEMS_SHOWN = 60;
const JIRA_OUTCOME_KEYS_LISTED = CHAT_TOOL_BATCH_COUNT_MAX;
/** The most keys one unexpanded span adds to the "and N more" count, however large it claims to be. */
const KEY_SPAN_COUNT_MAX = 1_000_000_000;
const JIRA_OUTCOME_PROBLEMS_SHOWN = 20;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,63}-\d{1,12}$/u;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const JIRA_PROJECT_TOOLS: ReadonlySet<string> = new Set([
  "jira_project",
  "jira_create_project",
  "jira_update_project",
  "jira_validate_project_key",
  "jira_project_type",
  "jira_project_permissions",
]);
const STANDALONE_TOOLS = new Set([
  ...JIRA_PROJECT_TOOLS,
  ...JIRA_COLLABORATION_TOOLS,
  ...JIRA_AGILE_TOOLS,
  ...JIRA_PROJECT_METADATA_TOOLS,
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
  ...JIRA_RUNTIME_SETTINGS_TOOLS,
  ...JIRA_MAINTENANCE_TOOLS,
  ...JIRA_VIEW_SETTINGS_TOOLS,
  ...JIRA_JOB_OBSERVATION_TOOLS,
  ...JIRA_PROPERTY_TOOLS,
]);
const BOARD_READ_TOOLS = new Set(["jira_board", "jira_boards", "jira_board_configuration"]);
type UnknownRecord = Readonly<Record<string, unknown>>;
function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function firstText(values: readonly unknown[]): string | undefined {
  return values.map(text).find((value) => value !== undefined);
}
function textMembers<Key extends string>(
  values: Readonly<Record<Key, unknown>>,
): Partial<Record<Key, string>> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const entry = text(value);
      return entry === undefined ? [] : [[key, entry]];
    }),
  ) as Partial<Record<Key, string>>;
}

/** Retain the saved instance/context path; never manufacture a link from a current connector. */
function savedUrl(value: unknown, queryAllowed = false): URL | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" &&
    [url.username, url.password, queryAllowed ? "" : url.search, url.hash].every(
      (part) => part === "",
    )
    ? url
    : undefined;
}
function boardLink(value: unknown, identity: unknown): string | undefined {
  const id = text(identity);
  if (id === undefined || !/^[1-9]\d{0,15}$/u.test(id) || !Number.isSafeInteger(Number(id)))
    return undefined;
  const url = savedUrl(value, true);
  return url?.pathname.endsWith("/secure/RapidBoard.jspa") === true &&
    [...url.searchParams].length === 1 &&
    url.searchParams.get("rapidView") === id
    ? url.href
    : undefined;
}
function filterLink(tool: string, source: UnknownRecord): string | undefined {
  if (!jiraSavedConfigurationFilterContextComplete(tool, source)) return undefined;
  if (typeof source.browseUrl !== "string" || /[\p{Cc}\\]/u.test(source.browseUrl))
    return undefined;
  const url = savedUrl(source.browseUrl, true);
  return url?.pathname.endsWith("/issues/") === true &&
    !/%(?:2f|5c|25)/iu.test(url.pathname) &&
    url.search === `?filter=${String(source.filterId)}`
    ? url.href
    : undefined;
}
function issueLink(value: unknown, key: string | undefined): string | undefined {
  if (key === undefined || !ISSUE_KEY.test(key)) return undefined;
  const url = savedUrl(value);
  return url?.pathname.endsWith(`/browse/${key}`) === true ? url.href : undefined;
}
/** Only the server-minted saved browse URL is a project destination, never its homepage or self. */
function projectLink(value: unknown, key: string): string | undefined {
  if (!PROJECT_KEY.test(key)) return undefined;
  const url = savedUrl(value);
  return url?.pathname.endsWith(`/projects/${key}/summary`) === true ? url.href : undefined;
}
const DRAFT_STATES: Readonly<Record<string, WidgetMessageKey>> = {
  pending: "chat.jira.outcome.state.pending",
  created: "chat.jira.outcome.state.created",
  existing: "chat.jira.outcome.state.existing",
  failed: "chat.jira.outcome.state.failed",
  uncertain: "chat.jira.outcome.state.uncertain",
  skipped: "chat.jira.outcome.state.skipped",
  excluded: "chat.jira.outcome.state.excluded",
};
function itemLabels(source: UnknownRecord): WidgetMessageKey[] {
  const labels: WidgetMessageKey[] = [];
  if (typeof source.state === "string" && Object.hasOwn(DRAFT_STATES, source.state)) {
    const state = DRAFT_STATES[source.state];
    if (state !== undefined) labels.push(state);
  }
  if (typeof source.required === "boolean")
    labels.push(source.required ? "chat.jira.outcome.required" : "chat.jira.outcome.optional");
  if (typeof source.active === "boolean")
    labels.push(source.active ? "chat.jira.outcome.active" : "chat.jira.outcome.inactive");
  return [...labels, ...projectLabels(source)];
}
function projectLabels(source: UnknownRecord): WidgetMessageKey[] {
  const labels: WidgetMessageKey[] = [];
  if (typeof source.valid === "boolean")
    labels.push(
      source.valid ? "chat.jira.outcome.keyAvailable" : "chat.jira.outcome.keyUnavailable",
    );
  if (typeof source.havePermission === "boolean")
    labels.push(
      source.havePermission
        ? "chat.jira.outcome.permissionGranted"
        : "chat.jira.outcome.permissionDenied",
    );
  return labels;
}
function metadataOutcomeItem(source: UnknownRecord, tool: string): JiraOutcomeItem | undefined {
  const { facts, labels } = jiraProjectMetadataDetails(tool, source);
  const name = firstText([source.versionName, source.componentName, source.name]);
  const body = text(source.description);
  const projectId = text(source.projectId);
  if (![name, body, projectId, ...facts].some((entry) => entry !== undefined)) return undefined;
  return { ...textMembers({ name, body, projectId }), facts, labels };
}
function metadataDetailsItem({
  name,
  body,
  facts,
  labels,
}: JiraAgileDetails): JiraOutcomeItem | undefined {
  return name === undefined && body === undefined && facts.length === 0 && labels.length === 0
    ? undefined
    : { ...textMembers({ name, body }), facts, labels };
}
function outcomeHref(
  tool: string,
  source: UnknownRecord,
  key: string | undefined,
  projectKey: string | undefined,
): string | undefined {
  if (
    tool === "jira_board_create" ||
    JIRA_SPRINT_TOOLS.has(tool) ||
    JIRA_SYSTEM_ACTION_TOOLS.has(tool)
  )
    return undefined;
  if (BOARD_READ_TOOLS.has(tool)) return boardLink(source.browseUrl, source.boardId ?? source.id);
  return projectKey === undefined
    ? issueLink(source.browseUrl, key)
    : projectLink(source.browseUrl, projectKey);
}
function boardContextLink(tool: string, source: UnknownRecord): string | undefined {
  if (tool === "jira_board_create") return boardLink(source.browseUrl, source.boardId);
  return JIRA_SPRINT_TOOLS.has(tool)
    ? boardLink(source.boardBrowseUrl, source.originBoardId)
    : undefined;
}
type ConfigurationPresenter = (
  tool: string,
  source: UnknownRecord,
  args?: unknown,
) => readonly JiraAgileDetails[];
const CONFIGURATION_PRESENTERS: readonly (readonly [
  ReadonlySet<string>,
  ConfigurationPresenter,
])[] = [
  [JIRA_ACCOUNT_RESOURCE_TOOLS, jiraAccountResourceDetails],
  [JIRA_SYSTEM_ACTION_TOOLS, jiraSystemActionDetails],
  [JIRA_SCHEME_ADMINISTRATION_TOOLS, jiraSchemeAdministrationDetails],
  [JIRA_INSTANCE_ADMINISTRATION_TOOLS, jiraInstanceAdministrationDetails],
  [JIRA_IDENTITY_OBSERVATION_TOOLS, jiraIdentityObservationDetails],
  [JIRA_SELECTED_WORKLOG_TOOLS, jiraSelectedWorklogDetails],
  [JIRA_SAVED_CONFIGURATION_WRITE_TOOLS, jiraSavedConfigurationDetails],
  [JIRA_RELEASE_LIFECYCLE_TOOLS, jiraReleaseLifecycleDetails],
  [JIRA_LINK_MUTATION_TOOLS, jiraLinkMutationDetails],
  [JIRA_CONFIGURATION_MUTATION_TOOLS, jiraConfigurationMutationDetails],
  [JIRA_PLANNING_MUTATION_TOOLS, jiraPlanningMutationDetails],
  [JIRA_ACCESS_CONFIGURATION_TOOLS, jiraAccessConfigurationDetails],
  [JIRA_SPRINT_REVIEW_TOOLS, jiraSprintReviewDetails],
  [JIRA_REMOTE_VERSION_LINK_TOOLS, jiraRemoteVersionLinkDetails],
  [JIRA_WORKLOG_FEED_TOOLS, jiraWorklogFeedDetails],
  [JIRA_ADMINISTRATIVE_OBSERVATION_TOOLS, jiraAdministrativeObservationDetails],
  [JIRA_APPLICATION_SETTINGS_TOOLS, jiraApplicationSettingsDetails],
  [JIRA_ACCOUNT_DIAGNOSTIC_TOOLS, jiraAccountDiagnosticDetails],
  [JIRA_PROPERTY_MUTATION_TOOLS, jiraPropertyMutationDetails],
  [JIRA_MONITORING_WRITE_TOOLS, jiraMonitoringDetails],
  [JIRA_ISSUE_CONTEXT_METADATA_TOOLS, jiraIssueContextDetails],
  [JIRA_PROPERTY_TOOLS, jiraPropertyDetails],
  [JIRA_JOB_OBSERVATION_TOOLS, jiraJobObservationDetails],
  [JIRA_VIEW_SETTINGS_TOOLS, jiraViewSettingsDetails],
  [JIRA_MAINTENANCE_TOOLS, jiraMaintenanceDetails],
  [JIRA_RUNTIME_SETTINGS_TOOLS, jiraRuntimeSettingsDetails],
  [JIRA_ADMIN_METADATA_TOOLS, jiraAdminMetadataDetails],
  [JIRA_AGILE_CONTEXT_METADATA_TOOLS, jiraAgileContextDetails],
  [JIRA_ACCESS_TOOLS, jiraAccessDetails],
  [JIRA_CORE_METADATA_TOOLS, jiraCoreMetadataDetails],
  [JIRA_INSTANCE_TOOLS, jiraInstanceDetails],
  [JIRA_ROLE_TOOLS, jiraRoleDetails],
  [JIRA_RELEASE_TOOLS, jiraReleaseDetails],
  [JIRA_LOOKUP_TOOLS, jiraLookupDetails],
  [JIRA_JQL_TOOLS, jiraJqlDetails],
  [JIRA_PROJECT_ASSOCIATION_TOOLS, jiraProjectAssociationDetails],
];
function configurationDetails(
  tool: string,
  source: UnknownRecord,
  args?: unknown,
): readonly JiraAgileDetails[] | undefined {
  return CONFIGURATION_PRESENTERS.find(([tools]) => tools.has(tool))?.[1](tool, source, args);
}
function metadataDetails(tool: string, source: UnknownRecord): JiraAgileDetails | undefined {
  if (tool === "jira_pinned_comments") return jiraPinnedCommentDetails(source);
  const configuration = configurationDetails(tool, source);
  if (configuration !== undefined) return configuration[0] ?? { facts: [], labels: [] };
  if (JIRA_AGILE_CONTEXT_TOOLS.has(tool)) return jiraAgileContextDetails(tool, source)[0];
  if (JIRA_DIRECTORY_TOOLS.has(tool)) return jiraDirectoryDetails(tool, source);
  if (JIRA_SAVED_VIEW_TOOLS.has(tool)) return jiraSavedViewDetails(tool, source);
  if (JIRA_FILE_METADATA_TOOLS.has(tool)) return jiraFileMetadataDetails(tool, source);
  return JIRA_ADMINISTRATION_TOOLS.has(tool) ? jiraAdministrationDetails(tool, source) : undefined;
}
/** A draft row Jira or Keiko's field check refused is named by its reference where the refusal is read. */
function refusedRow(source: UnknownRecord): boolean {
  return (
    text(source.ref) !== undefined &&
    text(source.issueKey) === undefined &&
    ((JIRA_FIELD_VALIDATION_FAILURES as readonly unknown[]).includes(source.validation) ||
      problemsOf(source).length > 0)
  );
}
const CATALOG_EFFECT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  "remote-read": "chat.jira.catalog.read",
  "remote-write": "chat.jira.catalog.write",
  "local-read": "chat.jira.catalog.local",
  "local-write": "chat.jira.catalog.local",
};
function catalogOutcomeItem(source: UnknownRecord): JiraOutcomeItem | undefined {
  const alias = jiraPresentationNativeText(source.tool, 128)
    ? source.tool.replace(/[.-]/gu, "_")
    : undefined;
  if (
    alias === undefined ||
    JIRA_CATALOG_TOOLS.has(alias) ||
    !isKnownJiraToolAlias(alias) ||
    !jiraPresentationNativeText(source.identity, 512)
  )
    return undefined;
  const effects: readonly unknown[] = Array.isArray(source.effects)
    ? source.effects.slice(0, 16)
    : [];
  const labels = Object.entries(CATALOG_EFFECT_LABELS)
    .filter(([effect]) => effects.includes(effect))
    .map(([, label]) => label);
  return {
    nameLabel: jiraToolLabel({ call: { name: alias, arguments: {} } }),
    ...textMembers({
      body: jiraPresentationNativeText(source.description, 4096, { multiline: true })
        ? source.description
        : undefined,
    }),
    labels: [...new Set(labels)],
    facts: [],
  };
}
/** A draft row that carries only its state (excluded, skipped) still reads as that state. */
function presentable(entries: readonly unknown[], source: UnknownRecord): boolean {
  return (
    entries.some((entry) => entry !== undefined) ||
    (text(source.ref) !== undefined && itemLabels(source).length > 0)
  );
}
/**
 * The one place that decides which stored text is Jira wiki text and which is plain text (#4355).
 * Wiki text is what Jira renders as wiki markup, so it is shown through `jiraReadableText`: an
 * issue's description (a row with an issue key), a comment's body and a worklog's comment. Plain
 * text is shown exactly as stored, because Jira shows it as typed: a sprint goal and an epic's
 * summary (`agile`), and the descriptions of a project, version, component or catalog tool, which
 * never reach this function (`metadataOutcomeItem` and `catalogOutcomeItem` build their own rows).
 */
function itemBody(
  tool: string,
  source: UnknownRecord,
  collaboration: unknown,
  agile: unknown,
): { readonly body: string | undefined; readonly shown: string | undefined } {
  const issueRow = ISSUE_KEY.test(text(source.key) ?? text(source.issueKey) ?? "");
  const nativeBody = text(tool === "jira_comments" ? source.body : source.description);
  const hit = (
    [
      [text(collaboration), true],
      [text(agile), false],
      [nativeBody, tool === "jira_comments" || issueRow],
    ] as const
  ).find(([value]) => value !== undefined);
  const body = hit?.[0];
  return { body, shown: body !== undefined && hit?.[1] === true ? jiraReadableText(body) : body };
}
function outcomeItem(value: unknown, tool: string): JiraOutcomeItem | undefined {
  const source = record(value);
  if (source === undefined || refusedRow(source)) return undefined;
  if (JIRA_CATALOG_TOOLS.has(tool)) return catalogOutcomeItem(source);
  if (JIRA_PROJECT_METADATA_TOOLS.has(tool)) return metadataOutcomeItem(source, tool);
  const metadata = metadataDetails(tool, source);
  if (metadata !== undefined) return metadataDetailsItem(metadata);
  const agile = jiraAgileDetails(tool, source);
  const collaboration = jiraCollaborationDetails(tool, source);
  const participation = jiraParticipationDetails(tool, source);
  const projectKey = text(source.projectKey);
  const key = firstText([
    projectKey,
    source.issueKey,
    agile.key,
    source.key,
    source.projectTypeKey,
  ]);
  const author = record(source.author) ?? {};
  const name = firstText([
    source.projectName,
    collaboration.name,
    agile.name,
    source.summary,
    source.displayName,
    source.name,
    author.displayName,
    author.name,
  ]);
  const { body, shown: readableBody } = itemBody(tool, source, collaboration.body, agile.body);
  const facts = [...agile.facts, ...collaboration.facts, ...participation.facts];
  if (!presentable([key, name, body, ...facts], source)) return undefined;
  const status = firstText([source.status, source.to].map((value) => record(value)?.name));
  const href = outcomeHref(tool, source, key, projectKey);
  const projectId = text(source.projectId);
  const boardHref = boardContextLink(tool, source);
  return {
    ...textMembers({ key, name, body: readableBody, status, href, projectId, boardHref }),
    labels: [...itemLabels(source), ...agile.labels, ...participation.labels],
    facts,
  };
}
function returnedEntries(
  data: UnknownRecord | undefined,
  tool: string,
): readonly unknown[] | undefined {
  const entries = tool === "jira_project_permissions" ? data?.permissions : data?.items;
  if (Array.isArray(entries))
    return JIRA_CATALOG_TOOLS.has(tool)
      ? entries.slice(0, TOOL_CATALOG_LIMITS.maxArrayItems)
      : entries;
  return JIRA_AGILE_TOOLS.has(tool) && Array.isArray(data?.issueKeys)
    ? data.issueKeys.map((issueKey) => ({ issueKey }))
    : undefined;
}
function presentedDetails(details: readonly JiraAgileDetails[]): JiraOutcomeItem[] {
  return details.flatMap((entry) => {
    const item = metadataDetailsItem(entry);
    return item === undefined ? [] : [item];
  });
}
function configurationItems(
  tool: string,
  data: UnknownRecord,
  details: readonly JiraAgileDetails[],
): JiraOutcomeItem[] {
  const items = presentedDetails(details);
  const resourceLink = resourceLifecycleLink(tool, data);
  if (resourceLink !== undefined)
    return items.map((item, index) => (index === 0 ? { ...item, ...resourceLink } : item));
  const filterHref = filterLink(tool, data);
  return filterHref === undefined
    ? items
    : items.map((item, index) => (index === 0 ? { ...item, filterHref } : item));
}
/** A retained, canonical receipt supplies the key; its saved URL uses the existing Jira destination
 * validators. Do not turn arguments, remote-link content or a current connector into a URL. */
function resourceLifecycleLink(
  tool: string,
  data: UnknownRecord,
): Pick<JiraOutcomeItem, "key" | "href"> | undefined {
  if (
    !JIRA_RESOURCE_LIFECYCLE_TOOLS.has(tool) ||
    !jiraResourceLifecycleIdentityComplete(tool, data)
  )
    return undefined;
  const saved = data.browseUrl;
  if (typeof saved !== "string" || /[\p{Cc}\\]/u.test(saved) || /%(?:2f|5c|25)/iu.test(saved))
    return undefined;
  const projectKey = text(data.projectKey);
  const key = projectKey ?? text(data.issueKey);
  const href = projectKey === undefined ? issueLink(saved, key) : projectLink(saved, projectKey);
  return href === undefined || key === undefined ? undefined : { key, href };
}
function issueContextItems(tool: string, data: UnknownRecord): JiraOutcomeItem[] | undefined {
  if (tool === "jira_issue_picker")
    return jiraIssuePickerGroups(data).flatMap((group) => [
      ...presentedDetails([group.details]),
      ...group.issues.flatMap((issue) => {
        const item = outcomeItem(issue, "jira_issue");
        return item === undefined ? [] : [item];
      }),
    ]);
  if (tool !== "jira_pinned_comments" && tool !== "jira_subtasks") return undefined;
  if (data.outcome === "failed") return [];
  const items = Array.isArray(data.items) ? data.items : [];
  return [
    ...presentedDetails(jiraIssueContextDetails(tool, data)),
    ...items.flatMap((value: unknown) => {
      const item = outcomeItem(value, tool);
      return item === undefined ? [] : [item];
    }),
  ];
}
function collaborationItems(
  tool: string,
  data: UnknownRecord | undefined,
  items: readonly unknown[],
): JiraOutcomeItem[] | undefined {
  if (
    (!JIRA_COLLABORATION_TOOLS.has(tool) && !JIRA_SAVED_VIEW_TOOLS.has(tool)) ||
    items.length === 0
  )
    return undefined;
  return items.flatMap((entry) => {
    const raw = record(entry);
    const item = outcomeItem(
      {
        ...raw,
        browseUrl: raw?.browseUrl ?? data?.browseUrl,
        filterId: raw?.filterId ?? data?.filterId,
      },
      tool,
    );
    return item === undefined ? [] : [item];
  });
}
function outcomeSources(
  tool: string,
  data: UnknownRecord | undefined,
  items: readonly unknown[],
  progress: readonly unknown[],
): readonly unknown[] {
  return data?.issueKey !== undefined || STANDALONE_TOOLS.has(tool)
    ? [data, ...items, ...progress]
    : [...items, ...progress];
}
function outcomeItems(
  exchange: ChatToolExchange,
  data: UnknownRecord | undefined,
): JiraOutcomeItem[] {
  const issueContext = issueContextItems(exchange.call.name, data ?? {});
  if (issueContext !== undefined) return issueContext;
  const configuration = configurationDetails(
    exchange.call.name,
    data ?? {},
    exchange.call.arguments,
  );
  if (configuration !== undefined)
    return configurationItems(exchange.call.name, data ?? {}, configuration);
  const items = returnedEntries(data, exchange.call.name) ?? [];
  const progress = Array.isArray(exchange.draftProgress?.items) ? exchange.draftProgress.items : [];
  const source = outcomeSources(exchange.call.name, data, items, progress);
  const collaboration = collaborationItems(exchange.call.name, data, items);
  if (collaboration !== undefined) return collaboration;
  const seen = new Set<string>();
  const reviewed = reviewedItems(exchange);
  return source.flatMap((entry) => {
    const item = outcomeItem(withReviewedSummary(entry, reviewed), exchange.call.name);
    if (item === undefined) return [];
    // A journal fallback and a final receipt can describe the same draft item.
    const identity = item.key;
    if (identity !== undefined && seen.has(identity)) return [];
    if (identity !== undefined) seen.add(identity);
    return [item];
  });
}
/** Only a plain web link opens Jira; anything else stays an unlinked key. */
function webLink(value: unknown): string | undefined {
  const candidate = text(value);
  if (candidate === undefined) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
interface ListedKeys {
  readonly shown: readonly JiraOutcomeIssue[];
  /** The keys and unreadable parts beyond `shown`: counted, never silently dropped. */
  readonly count: number;
}
const RANGE = /^([A-Z][A-Z0-9_]{0,254})-(\d{1,15})\.\.\1-(\d{1,15})$/u;
interface KeyRun {
  readonly project: string;
  readonly from: number;
  readonly to: number;
}
function runOf(part: string): KeyRun | undefined {
  const range = RANGE.exec(part);
  const project = range?.[1];
  const from = Number(range?.[2]);
  const to = Number(range?.[3]);
  return project === undefined || to < from || !Number.isSafeInteger(to)
    ? undefined
    : { project, from, to };
}
/** What a result's key ranges name: the keys as far as they fit, and the keys or parts left over. */
interface ExpandedKeys {
  readonly shown: readonly JiraOutcomeIssue[];
  readonly count: number;
}
interface KeyExpansion {
  readonly shown: Map<string, JiraOutcomeIssue>;
  readonly room: number;
  readonly taken: ReadonlySet<string>;
  readonly existing: boolean;
  /** Keys past the room and parts that name no key: counted, never dropped silently. */
  count: number;
}
function admitKey(expansion: KeyExpansion, key: string): void {
  if (expansion.shown.has(key) || expansion.taken.has(key)) return;
  if (expansion.shown.size >= expansion.room) expansion.count += 1;
  else expansion.shown.set(key, expansion.existing ? { key, existing: true } : { key });
}
/** One `KEY-3` or `KEY-3..KEY-9` part; a part that is neither (descending, mixed prefixes) counts as one. */
function expandPart(expansion: KeyExpansion, part: string): void {
  const run = runOf(part);
  if (run === undefined) {
    if (ISSUE_KEY.test(part)) admitKey(expansion, part);
    else expansion.count += 1;
    return;
  }
  // Expand only while the list has room; the rest of the span is counted arithmetically, so a
  // hostile range such as KEY-1..KEY-999999999999999 returns at once.
  let n = run.from;
  for (; n <= run.to && expansion.shown.size < expansion.room; n += 1)
    admitKey(expansion, `${run.project}-${String(n)}`);
  expansion.count += Math.min(Math.max(0, run.to - n + 1), KEY_SPAN_COUNT_MAX);
}
/**
 * The compact result's comma-joined parts, expanded into distinct keys (an overlapping range lists a
 * key once, a key already taken by the created list is not listed again as found).
 */
function expandKeyEntries(
  entries: readonly string[],
  room: number,
  taken: ReadonlySet<string>,
  existing: boolean,
): ExpandedKeys {
  const expansion: KeyExpansion = { shown: new Map(), room, taken, existing, count: 0 };
  for (const entry of entries)
    for (const part of entry.split(",")) expandPart(expansion, part.trim());
  return { shown: [...expansion.shown.values()], count: expansion.count };
}
/** A listed key opens under the result's own browse prefix; without a web prefix it stays plain. */
function linked(issue: JiraOutcomeIssue, prefix: unknown): JiraOutcomeIssue {
  const base = text(prefix);
  const href = base === undefined ? undefined : webLink(`${base}${issue.key}`);
  return href === undefined ? issue : { ...issue, href };
}
/** The created and found keys a compact large-draft result lists as ranges, and those it counts. */
function compactKeys(data: UnknownRecord | undefined): ListedKeys {
  if (data?.compact !== true) return { shown: [], count: 0 };
  const entriesOf = (name: string): string[] => {
    const listed: unknown = data[name];
    return Array.isArray(listed)
      ? listed.filter((entry): entry is string => typeof entry === "string")
      : [];
  };
  const created = expandKeyEntries(
    entriesOf("createdRanges"),
    JIRA_OUTCOME_KEYS_LISTED,
    new Set(),
    false,
  );
  const found = expandKeyEntries(
    entriesOf("existingRanges"),
    JIRA_OUTCOME_KEYS_LISTED - created.shown.length,
    new Set(created.shown.map((issue) => issue.key)),
    true,
  );
  return {
    shown: [...created.shown, ...found.shown].map((issue) => linked(issue, data.browseUrlPrefix)),
    count: created.count + found.count + (count(data.unlistedKeyCount) ?? 0),
  };
}
function problemsOf(
  data: UnknownRecord | undefined,
  item?: JiraOutcomeItemName,
): JiraOutcomeProblem[] {
  const fieldErrors = Array.isArray(data?.fieldErrors) ? data.fieldErrors : [];
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const own = item === undefined ? {} : { item };
  return [
    ...fieldErrors.flatMap((entry): JiraOutcomeProblem[] => {
      const error = record(entry);
      const message = text(error?.message);
      if (message === undefined) return [];
      const field = text(error?.fieldName) ?? text(error?.fieldId);
      return [{ ...own, ...(field === undefined ? {} : { field }), message }];
    }),
    ...messages.flatMap((entry): JiraOutcomeProblem[] => {
      const message = text(entry);
      return message === undefined ? [] : [{ ...own, message }];
    }),
  ];
}
interface ReviewedItem {
  readonly position: number;
  readonly summary?: string;
  readonly ambiguous: boolean;
}
function summaryCounts(
  items: readonly { readonly summary: string | undefined }[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { summary } of items)
    if (summary !== undefined) counts.set(summary, (counts.get(summary) ?? 0) + 1);
  return counts;
}
/** A reference the call lists again keeps its first place and is marked, like a repeated summary. */
function reviewedEntry(
  first: ReviewedItem | undefined,
  listed: { readonly summary: string | undefined; readonly position: number },
  counts: ReadonlyMap<string, number>,
): ReviewedItem {
  const summary = first?.summary ?? listed.summary;
  return {
    position: first?.position ?? listed.position,
    ...(summary === undefined ? {} : { summary }),
    ambiguous: first !== undefined || (counts.get(listed.summary ?? "") ?? 0) > 1,
  };
}
/** The draft as the call listed it: each item's place and the summary the person reviewed. */
function reviewedItems(exchange: ChatToolExchange): ReadonlyMap<string, ReviewedItem> {
  const entries: readonly unknown[] = Array.isArray(exchange.call.arguments.items)
    ? (exchange.call.arguments.items as readonly unknown[])
    : [];
  const listed = entries.map((entry, index) => {
    const item = record(entry);
    return {
      ref: text(item?.ref),
      summary: text(record(item?.fields)?.summary),
      position: index + 1,
    };
  });
  const counts = summaryCounts(listed);
  const reviewed = new Map<string, ReviewedItem>();
  for (const { ref, summary, position } of listed) {
    if (ref !== undefined)
      reviewed.set(ref, reviewedEntry(reviewed.get(ref), { summary, position }, counts));
  }
  return reviewed;
}
/** A result row the model's reference names gets the summary the person reviewed for it. */
function withReviewedSummary(entry: unknown, reviewed: ReadonlyMap<string, ReviewedItem>): unknown {
  const source = record(entry);
  const ref = text(source?.ref);
  const summary = ref === undefined ? undefined : reviewed.get(ref)?.summary;
  return source === undefined || summary === undefined || text(source.summary) !== undefined
    ? entry
    : { ...source, summary };
}
function itemName(
  entry: unknown,
  index: number,
  reviewed: ReadonlyMap<string, ReviewedItem>,
): JiraOutcomeItemName | undefined {
  const ref = text(record(entry)?.ref);
  if (ref === undefined) return undefined;
  const known = reviewed.get(ref);
  if (known === undefined)
    return { position: index + 1, ...(reviewed.size > 0 ? { unlisted: true as const } : {}) };
  return {
    position: known.position,
    ...(known.summary === undefined ? {} : { summary: known.summary }),
    ...(known.ambiguous ? { ambiguous: true as const } : {}),
  };
}
/** Jira's words for each refused draft item, tied to the item as the person knows it. */
function itemProblemsOf(
  data: UnknownRecord | undefined,
  reviewed: ReadonlyMap<string, ReviewedItem>,
): JiraOutcomeProblem[] {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.flatMap((entry, index) =>
    problemsOf(record(entry), itemName(entry, index, reviewed)),
  );
}
/** A result that reports draft rows by state, or lists its keys as ranges, is a draft write. */
function reportsDraftRows(data: UnknownRecord): boolean {
  const rows: readonly unknown[] = Array.isArray(data.items) ? data.items : [];
  return data.compact === true || rows.some((row) => typeof record(row)?.state === "string");
}
/** Decided by the result's shape, not by a tool name: it names created or found issues. */
function writesIssueKeys(data: UnknownRecord): boolean {
  const rows: readonly unknown[] = Array.isArray(data.items) ? data.items : [];
  return (
    data.compact === true ||
    rows.some((row) => ["created", "existing"].includes(String(record(row)?.state)))
  );
}
const NOT_CREATED_COUNTS = [
  "failedCount",
  "skippedCount",
  "pendingCount",
  "excludedCount",
] as const;
const NOT_CREATED_STATES: ReadonlySet<unknown> = new Set([
  "failed",
  "skipped",
  "pending",
  "excluded",
]);
/** What a partial draft left uncreated: its own counts, else its rows; none for another tool. */
function notCreatedOf(data: UnknownRecord): number | undefined {
  if (!reportsDraftRows(data)) return undefined;
  const counts = NOT_CREATED_COUNTS.map((name) => count(data[name]));
  const rows: readonly unknown[] = Array.isArray(data.items) ? data.items : [];
  const total = counts.some((value) => value !== undefined)
    ? counts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : rows.filter((row) => NOT_CREATED_STATES.has(record(row)?.state)).length;
  return total > 0 ? total : undefined;
}
function draftRefusalOf(data: UnknownRecord | undefined): WidgetMessageKey | undefined {
  const reason = text(data?.draftRefusal);
  return reason !== undefined && Object.hasOwn(JIRA_DRAFT_REFUSAL_MESSAGES, reason)
    ? JIRA_DRAFT_REFUSAL_MESSAGES[reason]
    : undefined;
}
function draftProblemOf(data: UnknownRecord | undefined): JiraOutcomeDraftProblem | undefined {
  const problem = JIRA_DRAFT_PROBLEMS.find((value) => value === data?.draftProblem);
  if (problem === undefined) return undefined;
  const position = count(data?.draftItem);
  return position === undefined || position < 1 ? { problem } : { problem, position };
}
function itemValidationsOf(
  data: UnknownRecord | undefined,
  reviewed: ReadonlyMap<string, ReviewedItem>,
): JiraOutcomeItemValidation[] {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.flatMap((entry, index): JiraOutcomeItemValidation[] => {
    const item = itemName(entry, index, reviewed);
    const validation = JIRA_FIELD_VALIDATION_FAILURES.find(
      (value) => value === record(entry)?.validation,
    );
    return item === undefined || validation === undefined ? [] : [{ item, validation }];
  });
}

function ruleList(entries: readonly unknown[]): JiraOutcomeRule[] {
  const seen = new Set<string>();
  return entries.flatMap((entry): JiraOutcomeRule[] => {
    const rule = record(entry);
    const ruleId = JIRA_TEMPLATE_RULE_IDS.find((id) => id === rule?.ruleId);
    const subject = text(rule?.subject);
    if (ruleId === undefined || subject === undefined) return [];
    const identity = `${ruleId}\0${subject}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ ruleId, subject }];
  });
}
function rulesOf(data: UnknownRecord | undefined): JiraOutcomeRule[] {
  const own = Array.isArray(data?.violations) ? data.violations : [];
  const items = Array.isArray(data?.items) ? data.items : [];
  const nested = items.flatMap((item): unknown[] => {
    const violations = record(item)?.violations;
    return Array.isArray(violations) ? violations : [];
  });
  return ruleList([...own, ...nested]);
}
/** Only closed rule ids and their subjects are read; the model's own words never reach the card. */
function templateNoticesOf(data: UnknownRecord | undefined): JiraOutcomeRule[] {
  return Array.isArray(data?.templateNotices) ? ruleList(data.templateNotices) : [];
}
const FAILURE_MESSAGES: Readonly<Record<string, WidgetMessageKey>> = {
  "catalog:invalid-arguments": "chat.jira.catalog.invalidArguments",
  "source-changed": "chat.jira.outcome.failure.sourceChanged",
  "auth-failed": "chat.jira.outcome.failure.auth",
  "auth-unverified": "chat.jira.outcome.failure.authUnverified",
  "permission-denied": "chat.jira.outcome.failure.permission",
  forbidden: "chat.jira.outcome.failure.permission",
  "not-found": "chat.jira.outcome.failure.notFound",
  "rate-limited": "chat.jira.outcome.failure.rateLimited",
  conflict: "chat.jira.outcome.failure.conflict",
  "invalid-transition": "chat.jira.outcome.failure.transition",
  "bounds-exceeded": "chat.jira.outcome.failure.bounds",
  "malformed-payload": "chat.jira.outcome.failure.response",
  "field-validation": "chat.jira.outcome.failure.fields",
  "read:field-validation": "chat.jira.outcome.failure.readParameters",
  "invalid-input": "chat.jira.outcome.failure.invalidInput",
  "requirement:untraced": "chat.jira.outcome.failure.requirementUntraced",
  "requirement:criteria-missing": "chat.jira.outcome.failure.requirementCriteria",
  "requirement:references": "chat.jira.outcome.failure.requirementReferences",
  "requirement:unavailable": "chat.jira.outcome.failure.requirementUnavailable",
  "effect-denied": "chat.jira.outcome.failure.localAuthority",
  cancelled: "chat.jira.outcome.failure.cancelled",
  timeout: "chat.jira.outcome.failure.unavailable",
  unavailable: "chat.jira.outcome.failure.unavailable",
};
/**
 * A refusal of the requirement trace names which part of the trace failed, so the person reads why
 * nothing was created instead of the generic field-validation advice.
 */
function requirementRefusalReason(data: UnknownRecord | undefined): string | undefined {
  if (data?.outcome !== "rejected") return undefined;
  const refusal = data.requirementRefusal;
  if (refusal === "source-changed") return "source-changed";
  if (refusal === "untraced") return "requirement:untraced";
  if (refusal === "unavailable" || refusal === "no-knowledge-pod") return "requirement:unavailable";
  if (refusal !== "references") return undefined;
  const problems = Array.isArray(data.requirementProblems) ? data.requirementProblems : [];
  const criteriaMissing = problems.some(
    (problem) => record(problem)?.reason === "acceptance-criteria-missing",
  );
  return criteriaMissing ? "requirement:criteria-missing" : "requirement:references";
}
const APPROVAL_ENDED_STATES: ReadonlySet<string> = new Set(["rejected", "expired", "revoked"]);
/**
 * The one reason every failed draft row shares; a draft reports reasons per item, not on top. A
 * failed row without a reason may have another cause, so it leaves the generic message.
 */
function failedItemsReason(data: UnknownRecord | undefined): string | undefined {
  const items: readonly unknown[] = Array.isArray(data?.items) ? data.items : [];
  const reasons = new Set(
    items.flatMap((item) => {
      const row = record(item);
      return row?.state === "failed" ? [text(row.reason)] : [];
    }),
  );
  return reasons.size === 1 ? [...reasons][0] : undefined;
}
function failureReason(
  data: UnknownRecord | undefined,
  exchange: ChatToolExchange,
): string | undefined {
  const reason = requirementRefusalReason(data) ?? text(data?.reason) ?? failedItemsReason(data);
  if (JIRA_CATALOG_TOOLS.has(exchange.call.name) && reason === "invalid-arguments")
    return "catalog:invalid-arguments";
  // A read changes nothing, so Jira refused the requested values, not fields of a change.
  if (reason === "field-validation" && jiraToolOnlyReads(exchange)) return "read:field-validation";
  return reason;
}
/** The card already states why nothing changed, so no failure line is added. */
function outcomeStatedElsewhere(exchange: ChatToolExchange): boolean {
  if (jiraMutationUnchanged(exchange)) return true;
  // A human decision that ended the write is stated on the approval card ("Action declined",
  // expired, revoked); nothing went to Jira, so no connection failure is suggested.
  if (APPROVAL_ENDED_STATES.has(exchange.approval?.state ?? "")) return true;
  // A refused or stopped draft batch names its own reason in the state line.
  return jiraBatchRefusalKey(exchange) !== undefined;
}
/** The attachment operation a call alias names: `jira_attach`, `jira_delete_attachment`. */
function attachmentOperationOf(
  alias: string,
): (typeof JIRA_ATTACHMENT_OPERATIONS)[number] | undefined {
  return JIRA_ATTACHMENT_OPERATIONS.find(
    (operation) => alias === `jira_${operation.slice("jira.".length).replaceAll("-", "_")}`,
  );
}
/** The release switch's refusal of THIS exchange's attachment call: its sentence, its operation (#4354). */
function releaseScopeRefusal(exchange: ChatToolExchange, data: UnknownRecord | undefined): boolean {
  const operation = attachmentOperationOf(exchange.call.name);
  return operation !== undefined && isJiraReleaseScopeRefusal(operation, data?.messages);
}
function failureMessage(
  exchange: ChatToolExchange,
  data: UnknownRecord | undefined,
): WidgetMessageKey | undefined {
  if (outcomeStatedElsewhere(exchange)) return undefined;
  const localRead = jiraLocalReadFailureNotice(exchange);
  if (localRead !== undefined) return localRead;
  if (releaseScopeRefusal(exchange, data)) return "chat.jira.outcome.failure.releaseScope";
  const reason = failureReason(data, exchange);
  if (reason !== undefined && Object.hasOwn(FAILURE_MESSAGES, reason))
    return FAILURE_MESSAGES[reason];
  if (
    data?.outcome === "failed" ||
    (exchange.result !== undefined && exchange.result.status !== "completed")
  )
    return "chat.jira.outcome.failure.unavailable";
  return undefined;
}

function pageCounts(
  data: UnknownRecord,
  tool: string,
  reviewed: ReadonlyMap<string, ReviewedItem>,
): Pick<JiraToolOutcomeView, "returnedCount" | "total" | "unreadableCount"> {
  const items = returnedEntries(data, tool);
  if (items === undefined)
    return { returnedCount: undefined, total: undefined, unreadableCount: 0 };
  const total =
    JIRA_WORKLOG_FEED_TOOLS.has(tool) || JIRA_SELECTED_WORKLOG_TOOLS.has(tool)
      ? undefined
      : count(data.total);
  const omitted =
    JIRA_CATALOG_TOOLS.has(tool) && Array.isArray(data.items)
      ? data.items.length - items.length
      : 0;
  const returnedCount = items.length + omitted;
  const covered = (count(data.startAt) ?? 0) + returnedCount;
  return {
    returnedCount,
    total: total !== undefined && total >= covered ? total : undefined,
    unreadableCount:
      omitted +
      items.filter(
        (item) =>
          outcomeItem(withReviewedSummary(item, reviewed), tool) === undefined &&
          !refusedRow(record(item) ?? {}),
      ).length,
  };
}

const KNOWLEDGE_VIEWS: Readonly<Record<string, readonly string[]>> = {
  knowledge_requirements: ["units", "documents", "change-queries", "changes"],
  knowledge_documents: ["inventory", "search", "read"],
  knowledge_review: ["review"],
};
const KNOWLEDGE_COUNTS = {
  detectedCount: "chat.knowledge.outcome.detected",
  matchedCount: "chat.knowledge.outcome.matched",
  documentsScanned: "chat.knowledge.outcome.scanned",
  documentCount: "chat.knowledge.outcome.documents",
  documentsNotExtracted: "chat.knowledge.outcome.notExtracted",
  documentsOmitted: "chat.knowledge.outcome.documentsOmitted",
  unitsOmitted: "chat.knowledge.outcome.unitsOmitted",
} as const satisfies Readonly<Record<string, WidgetMessageKey>>;
const KNOWLEDGE_SOURCE_FIELDS = {
  documentScope: "chat.knowledge.outcome.documentReference",
  documentName: "chat.knowledge.outcome.document",
  pageLabel: "chat.knowledge.outcome.page",
} as const satisfies Readonly<Record<string, WidgetMessageKey>>;
const KNOWLEDGE_REVIEW_KINDS: Readonly<Record<string, WidgetMessageKey>> = {
  obligation: "chat.knowledge.outcome.obligation",
  "acceptance-criterion": "chat.knowledge.outcome.criterion",
  conflict: "chat.knowledge.outcome.conflict",
  omission: "chat.knowledge.outcome.omission",
  clarification: "chat.knowledge.outcome.clarification",
};
function knowledgeFacts(
  source: UnknownRecord,
  fields: Readonly<Record<string, WidgetMessageKey>>,
): JiraOutcomeFact[] {
  return Object.entries(fields).flatMap(([field, label]) => {
    const value = text(source[field]);
    return value === undefined || value.length > 32_768 ? [] : [{ label, value }];
  });
}
function knowledgeCounts(
  source: UnknownRecord,
  fields: Readonly<Record<string, WidgetMessageKey>>,
): JiraOutcomeFact[] {
  return Object.entries(fields).flatMap(([field, label]) => {
    const value = count(source[field]);
    return value === undefined ? [] : [{ label, value: String(value) }];
  });
}
function knowledgeRange(source: UnknownRecord): string | undefined {
  const start = count(source.characterStart);
  const end = count(source.characterEnd);
  return start !== undefined && end !== undefined && end >= start ? `${start}–${end}` : undefined;
}
function knowledgeSourceFacts(source: UnknownRecord): JiraOutcomeFact[] {
  const facts = knowledgeFacts(source, KNOWLEDGE_SOURCE_FIELDS);
  const range = knowledgeRange(source);
  if (range !== undefined) facts.push({ label: "chat.knowledge.outcome.characters", value: range });
  const section = source.sectionPath;
  if (
    Array.isArray(section) &&
    section.length > 0 &&
    section.length <= 12 &&
    section.every((part) => typeof part === "string" && part.length <= 300)
  )
    facts.push({ label: "chat.knowledge.outcome.section", value: section.join(" › ") });
  return facts;
}
function knowledgeRequirement(source: UnknownRecord): JiraOutcomeItem | undefined {
  const reference = text(source.reference);
  if (reference === undefined || reference.length > 120 || text(source.documentScope) === undefined)
    return undefined;
  const facts = knowledgeSourceFacts(source);
  const criteria = source.acceptanceCriteria;
  if (Array.isArray(criteria) && criteria.length <= 20) {
    const entries = criteria.flatMap((entry) => {
      const criterion = record(entry);
      const id = text(criterion?.id);
      const value = text(criterion?.text);
      return id === undefined || value === undefined ? [] : [`${id}: ${value}`];
    });
    if (entries.length > 0)
      facts.push({ label: "chat.knowledge.outcome.criteria", value: entries.join("\n") });
  }
  return {
    key: reference,
    ...textMembers({ name: source.title, body: source.statement }),
    facts,
    labels:
      source.statementTruncated === true || source.criteriaTruncated === true
        ? ["chat.requirements.partial"]
        : [],
  };
}
function knowledgeDocument(source: UnknownRecord): JiraOutcomeItem | undefined {
  if (text(source.documentScope) === undefined || text(source.documentName) === undefined)
    return undefined;
  const labels: WidgetMessageKey[] = [];
  if (source.sourceUnavailable === true) labels.push("chat.knowledge.outcome.sourceUnavailable");
  else if (source.text === "") labels.push("chat.knowledge.outcome.emptyText");
  if (source.positionSpace === "original-document-text")
    labels.push("chat.knowledge.outcome.originalPositions");
  if (source.positionSpace === "redacted-document-text")
    labels.push("chat.knowledge.outcome.redactedPositions");
  return {
    ...textMembers({
      name: source.documentName,
      body: source.sourceUnavailable === true ? undefined : source.text,
    }),
    labels,
    facts: [
      ...knowledgeSourceFacts(source),
      ...knowledgeFacts(source, { extractionStatus: "chat.knowledge.outcome.extraction" }),
      ...knowledgeCounts(source, { unitCount: "chat.knowledge.outcome.detected" }),
    ],
  };
}
function knowledgeReviewSources(source: UnknownRecord): JiraOutcomeFact[] | undefined {
  if (!Array.isArray(source.sources) || source.sources.length === 0 || source.sources.length > 2)
    return undefined;
  const references: string[] = [];
  for (const value of source.sources) {
    const citation = record(value);
    if (citation === undefined) return undefined;
    const document = text(citation.documentScope);
    const range = knowledgeRange(citation);
    if (document === undefined || range === undefined) return undefined;
    const quote = text(citation.quote);
    const quoteSuffix = quote === undefined ? "" : `\n${quote}`;
    references.push(`${document} · ${range}${quoteSuffix}`);
  }
  return [{ label: "chat.knowledge.outcome.sources", value: references.join("\n\n") }];
}
function knowledgeReview(source: UnknownRecord): JiraOutcomeItem | undefined {
  const key = text(source.proposalId);
  const kind =
    typeof source.kind === "string" && Object.hasOwn(KNOWLEDGE_REVIEW_KINDS, source.kind)
      ? KNOWLEDGE_REVIEW_KINDS[source.kind]
      : undefined;
  const facts = knowledgeReviewSources(source);
  if (key === undefined || kind === undefined || facts === undefined) return undefined;
  if (source.origin !== "model-proposal" || source.status !== "proposed") return undefined;
  const labels: WidgetMessageKey[] = ["chat.knowledge.outcome.proposal", kind];
  if (
    Array.isArray(source.sources) &&
    source.sources.some((value) => record(value)?.quoteTruncated === true)
  )
    labels.push("chat.knowledge.outcome.quoteTruncated");
  return {
    key,
    ...textMembers({ body: source.proposal }),
    labels,
    facts: [...facts, ...knowledgeFacts(source, { question: "chat.knowledge.outcome.question" })],
  };
}
function knowledgeQuery(source: UnknownRecord): JiraOutcomeItem | undefined {
  if (text(source.jql) === undefined || !Array.isArray(source.requirementIds)) return undefined;
  const refs = source.requirementIds;
  if (!refs.every((ref) => typeof ref === "string" && ref.length <= 120)) return undefined;
  return {
    facts: [
      { label: "chat.knowledge.outcome.requirements", value: refs.join(", ") },
      ...knowledgeFacts(source, { jql: "chat.knowledge.outcome.query" }),
    ],
    labels: [],
  };
}
function knowledgeItem(view: unknown, value: unknown): JiraOutcomeItem | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
  if (view === "units") return knowledgeRequirement(source);
  if (view === "review") return knowledgeReview(source);
  return view === "change-queries" ? knowledgeQuery(source) : knowledgeDocument(source);
}
function knowledgeChangeItems(changes: UnknownRecord): JiraOutcomeItem[] {
  const labels = {
    changed: "chat.knowledge.outcome.changed",
    removed: "chat.knowledge.outcome.removed",
    untraced: "chat.knowledge.outcome.untraced",
    unchanged: "chat.knowledge.outcome.unchanged",
  } as const;
  return Object.entries(labels).flatMap(([field, label]) => {
    const entries = changes[field];
    if (!Array.isArray(entries) || entries.length > 200) return [];
    return entries.flatMap((value): JiraOutcomeItem[] => {
      const source = record(value);
      const key = text(source?.id ?? value);
      if (key === undefined || key.length > 120) return [];
      return [
        {
          key,
          ...textMembers({ name: source?.title }),
          labels: [label],
          facts: knowledgeCounts(source ?? {}, {
            issueCount: "chat.knowledge.outcome.linkedIssues",
          }),
        },
      ];
    });
  });
}
function knowledgeReceiptData(exchange: ChatToolExchange): UnknownRecord | undefined {
  if (!isCanonicalKnowledgeExchange(exchange) || exchange.result?.status !== "completed")
    return undefined;
  const data = record(exchange.result.data);
  const views = KNOWLEDGE_VIEWS[exchange.call.name];
  if (data?.outcome !== "succeeded" || typeof data.view !== "string" || !views?.includes(data.view))
    return undefined;
  return data;
}
function knowledgeEntries(data: UnknownRecord): readonly unknown[] | undefined {
  if (data.view === "changes") {
    const counts = record(record(data.changes)?.counts);
    return ["changed", "removed", "untraced", "unchanged"].every(
      (key) => count(counts?.[key]) !== undefined,
    )
      ? []
      : undefined;
  }
  return Array.isArray(data.items) && data.items.length <= 100 ? data.items : undefined;
}
function knowledgeTotal(data: UnknownRecord, returned: number): number | undefined {
  const totals = record(data.totals);
  let total: number | undefined;
  if (data.view === "units") total = count(totals?.matchedCount);
  if (data.view === "inventory") total = count(totals?.documentCount);
  return total !== undefined && total >= returned ? total : undefined;
}
function knowledgeSummaryFacts(data: UnknownRecord): JiraOutcomeFact[] {
  const coverage = record(data.coverage) ?? {};
  return [
    ...knowledgeCounts(record(data.totals) ?? {}, KNOWLEDGE_COUNTS),
    ...(data.view === "review" ? knowledgeSourceFacts(coverage) : []),
    ...knowledgeCounts(coverage, {
      returnedChars: "chat.knowledge.outcome.returnedChars",
      documentChars: "chat.knowledge.outcome.documentChars",
    }),
    ...knowledgeCounts(record(record(data.changes)?.counts) ?? {}, {
      changed: "chat.knowledge.outcome.changedCount",
      removed: "chat.knowledge.outcome.removedCount",
      untraced: "chat.knowledge.outcome.untracedCount",
      unchanged: "chat.knowledge.outcome.unchangedCount",
    }),
  ];
}
/** Only the versioned Knowledge producers' declared fields become plain text facts, never URLs. */
export function knowledgeToolOutcomeView(
  exchange: ChatToolExchange,
): JiraToolOutcomeView | undefined {
  const data = knowledgeReceiptData(exchange);
  if (data === undefined) return undefined;
  const entries = knowledgeEntries(data);
  if (entries === undefined) return undefined;
  const projected = entries.map((entry) => knowledgeItem(data.view, entry));
  const items = projected.filter((item): item is JiraOutcomeItem => item !== undefined);
  if (entries.length > 0 && items.length === 0) return undefined;
  return {
    items: data.view === "changes" ? knowledgeChangeItems(record(data.changes) ?? {}) : items,
    returnedCount: data.view === "changes" ? undefined : entries.length,
    total: knowledgeTotal(data, entries.length),
    unreadableCount: entries.length - items.length,
    stagedCount: undefined,
    unresolvedCount: undefined,
    problems: [],
    rules: [],
    templateNotices: [],
    validation: undefined,
    itemValidations: [],
    hiddenProblemCount: 0,
    overflow: "disclosure",
    unlistedItemCount: 0,
    failure: undefined,
    resultsLabel: "chat.knowledge.outcome.results",
    facts: knowledgeSummaryFacts(data),
    labels: data.view === "review" ? ["chat.knowledge.outcome.reviewScope"] : [],
  };
}

/** Tools with their own presentation; every other Jira result lists the issues it names. */
const SPECIALIZED_TOOLS: ReadonlySet<string> = new Set([
  ...STANDALONE_TOOLS,
  ...JIRA_COLLABORATION_TOOLS,
  ...JIRA_PARTICIPATION_TOOLS,
  ...CONFIGURATION_PRESENTERS.flatMap(([tools]) => [...tools]),
  "jira_pinned_comments",
  "jira_subtasks",
  "jira_issue_picker",
  "jira_issue",
]);
/** The label a draft row that already existed carries, shared with the compact key list. */
function foundLabels(): WidgetMessageKey[] {
  const label = DRAFT_STATES.existing;
  return label === undefined ? [] : [label];
}
function issueListItems(items: readonly JiraOutcomeItem[], listed: ListedKeys): JiraOutcomeItem[] {
  const keyed = new Set(items.flatMap((item) => (item.key === undefined ? [] : [item.key])));
  const compact = listed.shown.flatMap((issue): JiraOutcomeItem[] =>
    keyed.has(issue.key)
      ? []
      : [
          {
            key: issue.key,
            ...(issue.href === undefined ? {} : { href: issue.href }),
            labels: issue.existing === true ? foundLabels() : [],
            facts: [],
          },
        ],
  );
  return [...items, ...compact];
}
function usesIssueList(
  tool: string,
  items: readonly JiraOutcomeItem[],
  listed: ListedKeys,
): boolean {
  return (
    !SPECIALIZED_TOOLS.has(tool) &&
    (listed.shown.length > 0 ||
      items.some((item) => item.key !== undefined && ISSUE_KEY.test(item.key)))
  );
}
function privateAccount(tool: string): boolean {
  return JIRA_PRIVATE_ACCOUNT_TOOLS.has(tool);
}
function problemViews(
  exchange: ChatToolExchange,
  data: UnknownRecord,
): Pick<JiraToolOutcomeView, "problems" | "hiddenProblemCount"> {
  // Private credential/session validators expose only closed reasons and violation counts.
  const all = (
    privateAccount(exchange.call.name)
      ? []
      : [...problemsOf(data), ...itemProblemsOf(data, reviewedItems(exchange))]
  ).filter(
    // The release switch's own sentence is worded from the catalog (failureMessage), not shown raw,
    // and only for the attachment call it refused.
    (problem) =>
      !(
        releaseScopeRefusal(exchange, data) &&
        problem.message === JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE
      ),
  );
  return {
    problems: all.slice(0, JIRA_OUTCOME_PROBLEMS_SHOWN),
    hiddenProblemCount: Math.max(0, all.length - JIRA_OUTCOME_PROBLEMS_SHOWN),
  };
}
function storedOutcomeData(exchange: ChatToolExchange): UnknownRecord {
  const stored = record(exchange.result?.data) ?? {};
  return [
    JIRA_PARTICIPATION_TOOLS,
    JIRA_MONITORING_WRITE_TOOLS,
    JIRA_PROPERTY_MUTATION_TOOLS,
    JIRA_SAVED_CONFIGURATION_WRITE_TOOLS,
    JIRA_RELEASE_LIFECYCLE_TOOLS,
    JIRA_LINK_MUTATION_TOOLS,
    JIRA_CONFIGURATION_MUTATION_TOOLS,
    JIRA_PLANNING_MUTATION_TOOLS,
    JIRA_ACCESS_CONFIGURATION_TOOLS,
    JIRA_SCHEME_ADMINISTRATION_TOOLS,
    JIRA_INSTANCE_ADMINISTRATION_WRITE_TOOLS,
    JIRA_SYSTEM_ACTION_TOOLS,
    JIRA_ACCOUNT_RESOURCE_WRITE_TOOLS,
  ].some((tools) => tools.has(exchange.call.name)) && exchange.mutationOutcome !== undefined
    ? { ...stored, outcome: exchange.mutationOutcome }
    : stored;
}
function resultItemsView(
  exchange: ChatToolExchange,
  data: UnknownRecord,
): Pick<
  JiraToolOutcomeView,
  "items" | "resultsLabel" | "overflow" | "visibleItems" | "unlistedItemCount"
> {
  const listed: ListedKeys = exchange.call.name.startsWith("jira_")
    ? compactKeys(data)
    : { shown: [], count: 0 };
  const own = outcomeItems(exchange, data);
  const issueList = usesIssueList(exchange.call.name, own, listed);
  const items = issueList ? issueListItems(own, listed) : own;
  const listsEveryKey = writesIssueKeys(data);
  return {
    items,
    ...resultsLabelOf(exchange.call.name, issueList),
    overflow: issueList && !listsEveryKey ? "count" : "disclosure",
    ...(listsEveryKey ? { visibleItems: JIRA_OUTCOME_WRITE_ITEMS_SHOWN } : {}),
    unlistedItemCount: issueList ? listed.count : 0,
  };
}
/** A display projection of the immutable receipt, shared by the live turn and restored history. */
export function jiraToolOutcomeView(exchange: ChatToolExchange): JiraToolOutcomeView {
  const knowledge = knowledgeToolOutcomeView(exchange);
  if (knowledge !== undefined) return knowledge;
  const data = storedOutcomeData(exchange);
  return {
    ...resultItemsView(exchange, data),
    ...pageCounts(data, exchange.call.name, reviewedItems(exchange)),
    ...(exchange.call.name === "jira_describe" &&
    data.outcome === "succeeded" &&
    data.selectedFor === "next-round"
      ? { labels: ["chat.jira.catalog.selected" as const] }
      : {}),
    stagedCount: count(data.itemCount),
    unresolvedCount: count(data.unresolvedRefCount),
    ...problemViews(exchange, data),
    rules: privateAccount(exchange.call.name) ? [] : rulesOf(data),
    templateNotices: privateAccount(exchange.call.name) ? [] : templateNoticesOf(data),
    validation: JIRA_FIELD_VALIDATION_FAILURES.find((value) => value === data.validation),
    itemValidations: privateAccount(exchange.call.name)
      ? []
      : itemValidationsOf(data, reviewedItems(exchange)),
    ...draftViews(exchange, data),
  };
}
/**
 * What a refused or partial draft tells the person: the named problem or refusal, which replaces
 * the generic "review the fields" advice, and the issues that were not created.
 */
function draftViews(
  exchange: ChatToolExchange,
  data: UnknownRecord,
): Pick<JiraToolOutcomeView, "draftProblem" | "draftRefusal" | "notCreatedCount" | "failure"> {
  const draftProblem = draftProblemOf(data);
  const notCreatedCount = notCreatedOf(data);
  const draftRefusal = draftProblem === undefined ? draftRefusalOf(data) : undefined;
  return {
    ...(draftProblem === undefined ? {} : { draftProblem }),
    ...(notCreatedCount === undefined ? {} : { notCreatedCount }),
    ...(draftRefusal === undefined ? {} : { draftRefusal }),
    failure:
      draftProblem === undefined && draftRefusal === undefined
        ? failureMessage(exchange, data)
        : undefined,
  };
}
function resultsLabelOf(
  tool: string,
  issueList: boolean,
): { readonly resultsLabel: WidgetMessageKey } | Record<string, never> {
  if (JIRA_CATALOG_TOOLS.has(tool)) return { resultsLabel: "chat.jira.catalog.actions" };
  return issueList ? { resultsLabel: "chat.jira.outcome.issues" } : {};
}
