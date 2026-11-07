import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_TEMPLATE_RULE_IDS,
  type JiraFieldValidationFailure,
  type JiraTemplateRuleId,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";

export interface JiraOutcomeItem {
  readonly key?: string;
  readonly projectId?: string;
  readonly name?: string;
  readonly body?: string;
  readonly href?: string;
  readonly status?: string;
  readonly labels: readonly WidgetMessageKey[];
}
export interface JiraOutcomeProblem {
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
function savedUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      [url.username, url.password, url.search, url.hash].every((part) => part === "")
      ? url
      : undefined;
  } catch {
    return undefined;
  }
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
function outcomeItem(value: unknown, comments: boolean): JiraOutcomeItem | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
  const projectKey = text(source.projectKey);
  const key = firstText([projectKey, source.issueKey, source.key, source.projectTypeKey]);
  const author = record(source.author) ?? {};
  const name = firstText([
    source.projectName,
    source.summary,
    source.displayName,
    source.name,
    source.ref,
    author.displayName,
    author.name,
  ]);
  const body = text(comments ? source.body : source.description);
  if (key === undefined && name === undefined && body === undefined) return undefined;
  const status = firstText([record(source.status)?.name, record(source.to)?.name]);
  const href =
    projectKey === undefined
      ? issueLink(source.browseUrl, key)
      : projectLink(source.browseUrl, projectKey);
  const projectId = text(source.projectId);
  return {
    ...textMembers({ key, name, body, status, href, projectId }),
    labels: itemLabels(source),
  };
}
function outcomeItems(
  exchange: ChatToolExchange,
  data: UnknownRecord | undefined,
): JiraOutcomeItem[] {
  const candidates =
    exchange.call.name === "jira_project_permissions" ? data?.permissions : data?.items;
  const items = Array.isArray(candidates) ? candidates : [];
  const progress = Array.isArray(exchange.draftProgress?.items) ? exchange.draftProgress.items : [];
  const single = data?.issueKey !== undefined || JIRA_PROJECT_TOOLS.has(exchange.call.name);
  const source = single ? [data, ...items, ...progress] : [...items, ...progress];
  const seen = new Set<string>();
  return source.flatMap((entry) => {
    const item = outcomeItem(entry, exchange.call.name === "jira_comments");
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
function failureMessage(
  exchange: ChatToolExchange,
  data: UnknownRecord | undefined,
): WidgetMessageKey | undefined {
  const reason = text(data?.reason);
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
  comments: boolean,
  permissions: boolean,
): Pick<JiraToolOutcomeView, "returnedCount" | "total" | "unreadableCount"> {
  const items = permissions ? data.permissions : data.items;
  if (!Array.isArray(items))
    return { returnedCount: undefined, total: undefined, unreadableCount: 0 };
  const total = count(data.total);
  const covered = (count(data.startAt) ?? 0) + items.length;
  return {
    returnedCount: items.length,
    total: total !== undefined && total >= covered ? total : undefined,
    unreadableCount: items.filter((item) => outcomeItem(item, comments) === undefined).length,
  };
}

/** A display projection of the immutable receipt, shared by the live turn and restored history. */
export function jiraToolOutcomeView(exchange: ChatToolExchange): JiraToolOutcomeView {
  const data = record(exchange.result?.data) ?? {};
  return {
    items: outcomeItems(exchange, data),
    ...pageCounts(
      data,
      exchange.call.name === "jira_comments",
      exchange.call.name === "jira_project_permissions",
    ),
    stagedCount: count(data.itemCount),
    unresolvedCount: count(data.unresolvedRefCount),
    problems: problemsOf(data),
    rules: rulesOf(data),
    validation: JIRA_FIELD_VALIDATION_FAILURES.find((value) => value === data.validation),
    failure: failureMessage(exchange, data),
  };
}
