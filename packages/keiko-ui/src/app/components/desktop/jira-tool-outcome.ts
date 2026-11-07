import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_TEMPLATE_RULE_IDS,
  type JiraFieldValidationFailure,
  type JiraTemplateRuleId,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
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
import { jiraMutationUnchanged } from "./jira-tool-presentation";
import { JIRA_DIRECTORY_TOOLS, jiraDirectoryDetails } from "./jira-directory-presentation";
import { JIRA_ACCESS_TOOLS, jiraAccessDetails } from "./jira-access-presentation";
import {
  JIRA_PROJECT_ASSOCIATION_TOOLS,
  jiraProjectAssociationDetails,
} from "./jira-project-association-presentation";
import { JIRA_CORE_METADATA_TOOLS, jiraCoreMetadataDetails } from "./jira-core-metadata-presentation";
import { JIRA_INSTANCE_TOOLS, jiraInstanceDetails } from "./jira-instance-presentation";
import { JIRA_ROLE_TOOLS, jiraRoleDetails } from "./jira-role-presentation";
import { JIRA_RELEASE_TOOLS, jiraReleaseDetails } from "./jira-release-presentation";
import { JIRA_LOOKUP_TOOLS, jiraLookupDetails } from "./jira-lookup-presentation";
import { JIRA_JQL_TOOLS, jiraJqlDetails } from "./jira-jql-presentation";
import { JIRA_AGILE_CONTEXT_TOOLS, JIRA_AGILE_CONTEXT_METADATA_TOOLS, jiraAgileContextDetails } from "./jira-agile-context-presentation";
import { JIRA_ADMIN_METADATA_TOOLS, jiraAdminMetadataDetails } from "./jira-admin-metadata-presentation";
import { JIRA_RUNTIME_SETTINGS_TOOLS, jiraRuntimeSettingsDetails } from "./jira-runtime-settings-presentation";
import { JIRA_MAINTENANCE_TOOLS, jiraMaintenanceDetails } from "./jira-maintenance-presentation";
import { JIRA_VIEW_SETTINGS_TOOLS, jiraViewSettingsDetails } from "./jira-view-settings-presentation";
import { JIRA_JOB_OBSERVATION_TOOLS, jiraJobObservationDetails } from "./jira-job-observation-presentation";
import { JIRA_PROPERTY_TOOLS, jiraPropertyDetails } from "./jira-property-presentation";
import { JIRA_MONITORING_WRITE_TOOLS, jiraMonitoringDetails } from "./jira-monitoring-presentation";
import {
  JIRA_ISSUE_CONTEXT_METADATA_TOOLS,
  jiraIssueContextDetails,
  jiraIssuePickerGroups,
  jiraPinnedCommentDetails,
} from "./jira-issue-context-presentation";

export interface JiraOutcomeItem {
  readonly key?: string;
  readonly projectId?: string;
  readonly name?: string;
  readonly body?: string;
  readonly href?: string;
  readonly boardHref?: string;
  readonly status?: string;
  readonly labels: readonly WidgetMessageKey[];
  readonly facts: readonly JiraOutcomeFact[];
}
interface JiraOutcomeProblem {
  readonly field?: string;
  readonly message: string;
}
export interface JiraOutcomeRule {
  readonly ruleId: JiraTemplateRuleId;
  readonly subject: string;
}
export interface JiraToolOutcomeView {
  readonly items: readonly JiraOutcomeItem[];
  readonly returnedCount: number | undefined;
  readonly total: number | undefined;
  readonly unreadableCount: number;
  readonly stagedCount: number | undefined;
  readonly unresolvedCount: number | undefined;
  readonly problems: readonly JiraOutcomeProblem[];
  readonly rules: readonly JiraOutcomeRule[];
  readonly validation: JiraFieldValidationFailure | undefined;
  readonly failure: WidgetMessageKey | undefined;
}

export const JIRA_OUTCOME_ITEMS_SHOWN = 5;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,63}-\d{1,12}$/u;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const JIRA_PROJECT_TOOLS: ReadonlySet<string> = new Set([
  "jira_project",
  "jira_create_project",
  "jira_update_project",
  "jira_validate_project_key",
  "jira_project_type",
  "jira_project_permissions",
]);
const STANDALONE_TOOLS = new Set([
  ...JIRA_PROJECT_TOOLS,
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
  if (tool === "jira_board_create" || JIRA_SPRINT_TOOLS.has(tool)) return undefined;
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
type ConfigurationPresenter = (tool: string, source: UnknownRecord) => readonly JiraAgileDetails[];
const CONFIGURATION_PRESENTERS: readonly (readonly [ReadonlySet<string>, ConfigurationPresenter])[] = [
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
function configurationDetails(tool: string, source: UnknownRecord): readonly JiraAgileDetails[] | undefined {
  return CONFIGURATION_PRESENTERS.find(([tools]) => tools.has(tool))?.[1](tool, source);
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
function outcomeItem(value: unknown, tool: string): JiraOutcomeItem | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
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
    source.ref,
    author.displayName,
    author.name,
  ]);
  const body = firstText([
    collaboration.body,
    agile.body,
    tool === "jira_comments" ? source.body : source.description,
  ]);
  const facts = [...agile.facts, ...collaboration.facts, ...participation.facts];
  if (![key, name, body, ...facts].some((entry) => entry !== undefined)) return undefined;
  const status = firstText([record(source.status)?.name, record(source.to)?.name]);
  const href = outcomeHref(tool, source, key, projectKey);
  const projectId = text(source.projectId);
  const boardHref = boardContextLink(tool, source);
  return {
    ...textMembers({ key, name, body, status, href, projectId, boardHref }),
    labels: [...itemLabels(source), ...agile.labels, ...participation.labels],
    facts,
  };
}
function returnedEntries(
  data: UnknownRecord | undefined,
  tool: string,
): readonly unknown[] | undefined {
  const entries = tool === "jira_project_permissions" ? data?.permissions : data?.items;
  if (Array.isArray(entries)) return entries;
  return JIRA_AGILE_TOOLS.has(tool) && Array.isArray(data?.issueKeys)
    ? data.issueKeys.map((issueKey) => ({ issueKey }))
    : undefined;
}
function presentedDetails(details: readonly JiraAgileDetails[]): JiraOutcomeItem[] {
  return details.flatMap((entry) => {
    const item = metadataDetailsItem(entry);
    return item === undefined ? [] : [item];
  });
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
function outcomeItems(
  exchange: ChatToolExchange,
  data: UnknownRecord | undefined,
): JiraOutcomeItem[] {
  const issueContext = issueContextItems(exchange.call.name, data ?? {});
  if (issueContext !== undefined) return issueContext;
  const configuration = configurationDetails(exchange.call.name, data ?? {});
  if (configuration !== undefined) return presentedDetails(configuration);
  const items = returnedEntries(data, exchange.call.name) ?? [];
  const progress = Array.isArray(exchange.draftProgress?.items) ? exchange.draftProgress.items : [];
  const single = data?.issueKey !== undefined || STANDALONE_TOOLS.has(exchange.call.name);
  const source = single ? [data, ...items, ...progress] : [...items, ...progress];
  if (
    (JIRA_COLLABORATION_TOOLS.has(exchange.call.name) ||
      JIRA_SAVED_VIEW_TOOLS.has(exchange.call.name)) &&
    items.length > 0
  )
    return items.flatMap((entry) => {
      const raw = record(entry);
      const item = outcomeItem(
        {
          ...raw,
          browseUrl: raw?.browseUrl ?? data?.browseUrl,
          filterId: raw?.filterId ?? data?.filterId,
        },
        exchange.call.name,
      );
      return item === undefined ? [] : [item];
    });
  const seen = new Set<string>();
  return source.flatMap((entry) => {
    const item = outcomeItem(entry, exchange.call.name);
    if (item === undefined) return [];
    // A journal fallback and a final receipt can describe the same draft item.
    const identity = item.key;
    if (identity !== undefined && seen.has(identity)) return [];
    if (identity !== undefined) seen.add(identity);
    return [item];
  });
}
function problemsOf(data: UnknownRecord | undefined): JiraOutcomeProblem[] {
  const errors = Array.isArray(data?.fieldErrors) ? data.fieldErrors : [];
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return [
    ...errors.flatMap((entry): JiraOutcomeProblem[] => {
      const error = record(entry);
      const message = text(error?.message);
      const field = text(error?.fieldName);
      return message === undefined ? [] : [{ ...(field === undefined ? {} : { field }), message }];
    }),
    ...messages.flatMap((entry): JiraOutcomeProblem[] => {
      const message = text(entry);
      return message === undefined ? [] : [{ message }];
    }),
  ];
}
function rulesOf(data: UnknownRecord | undefined): JiraOutcomeRule[] {
  const own = Array.isArray(data?.violations) ? data.violations : [];
  const items = Array.isArray(data?.items) ? data.items : [];
  const nested = items.flatMap((item): unknown[] => {
    const violations = record(item)?.violations;
    return Array.isArray(violations) ? violations : [];
  });
  const seen = new Set<string>();
  return [...own, ...nested].flatMap((entry): JiraOutcomeRule[] => {
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
const FAILURE_MESSAGES: Readonly<Record<string, WidgetMessageKey>> = {
  "source-changed": "chat.jira.outcome.failure.sourceChanged",
  "auth-failed": "chat.jira.outcome.failure.auth",
  "permission-denied": "chat.jira.outcome.failure.permission",
  forbidden: "chat.jira.outcome.failure.permission",
  "not-found": "chat.jira.outcome.failure.notFound",
  "rate-limited": "chat.jira.outcome.failure.rateLimited",
  conflict: "chat.jira.outcome.failure.conflict",
  "invalid-transition": "chat.jira.outcome.failure.transition",
  "bounds-exceeded": "chat.jira.outcome.failure.bounds",
  "malformed-payload": "chat.jira.outcome.failure.response",
  "field-validation": "chat.jira.outcome.failure.fields",
  timeout: "chat.jira.outcome.failure.unavailable",
  unavailable: "chat.jira.outcome.failure.unavailable",
};
function failureReason(data: UnknownRecord | undefined): string | undefined {
  return data?.outcome === "rejected" && data.requirementRefusal === "source-changed"
    ? "source-changed"
    : text(data?.reason);
}
function failureMessage(
  exchange: ChatToolExchange,
  data: UnknownRecord | undefined,
): WidgetMessageKey | undefined {
  if (jiraMutationUnchanged(exchange)) return undefined;
  const reason = failureReason(data);
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
): Pick<JiraToolOutcomeView, "returnedCount" | "total" | "unreadableCount"> {
  const items = returnedEntries(data, tool);
  if (items === undefined)
    return { returnedCount: undefined, total: undefined, unreadableCount: 0 };
  const total = count(data.total);
  const covered = (count(data.startAt) ?? 0) + items.length;
  return {
    returnedCount: items.length,
    total: total !== undefined && total >= covered ? total : undefined,
    unreadableCount: items.filter((item) => outcomeItem(item, tool) === undefined).length,
  };
}

/** A display projection of the immutable receipt, shared by the live turn and restored history. */
export function jiraToolOutcomeView(exchange: ChatToolExchange): JiraToolOutcomeView {
  const stored = record(exchange.result?.data) ?? {};
  const data =
    (JIRA_PARTICIPATION_TOOLS.has(exchange.call.name) || JIRA_MONITORING_WRITE_TOOLS.has(exchange.call.name)) && exchange.mutationOutcome !== undefined
      ? { ...stored, outcome: exchange.mutationOutcome }
      : stored;
  return {
    items: outcomeItems(exchange, data),
    ...pageCounts(data, exchange.call.name),
    stagedCount: count(data.itemCount),
    unresolvedCount: count(data.unresolvedRefCount),
    problems: problemsOf(data),
    rules: rulesOf(data),
    validation: JIRA_FIELD_VALIDATION_FAILURES.find((value) => value === data.validation),
    failure: failureMessage(exchange, data),
  };
}
