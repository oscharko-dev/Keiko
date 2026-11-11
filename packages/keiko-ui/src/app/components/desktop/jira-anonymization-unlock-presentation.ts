import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationNativeText,
} from "./jira-presentation-values";
import { jiraNullableReviewFacts } from "./jira-scheme-review-presentation";
import {
  accountResourceFields as fields,
  accountResourcePrincipal as principal,
  accountResourceOwn as own,
  accountResourceRecord as record,
  accountResourceExactFields as exactFields,
  accountResourceInteger as integer,
  accountResourceList as list,
  accountResourceBudget as budget,
  type AccountResourceSource as Source,
} from "./jira-account-resource-values";

export const JIRA_ANONYMIZATION_UNLOCK_TOOLS: ReadonlySet<string> = new Set([
  "jira_unlock_user_anonymization",
]);
export function jiraAnonymizationUnlockIdentityComplete(source: Source): boolean {
  return (
    own(source) &&
    fields(source, ["actorUserKey", "userKey", "executingNode", "anonymizationSubmittedTime"]) &&
    principal(source.actorUserKey) &&
    principal(source.userKey) &&
    principal(source.executingNode) &&
    typeof source.anonymizationSubmittedTime === "string" &&
    source.anonymizationSubmittedTime.length <= 128 &&
    principal(source.anonymizationSubmittedTime) &&
    budget(source)
  );
}
export function jiraAnonymizationUnlockDetails(source: Source): readonly JiraAgileDetails[] {
  const valid = jiraAnonymizationUnlockIdentityComplete(source);
  return [
    {
      facts: valid
        ? [
            ...fact("chat.jira.systemAction.actorKey", source.actorUserKey),
            ...fact("chat.jira.systemAction.targetUser", source.userKey),
            ...fact("chat.jira.accountWrite.executingNode", source.executingNode),
            ...fact("chat.jira.jobs.submittedTime", source.anonymizationSubmittedTime),
          ]
        : [],
      labels: [
        valid
          ? "chat.jira.savedConfiguration.unconfirmed"
          : "chat.jira.savedConfiguration.identityUnknown",
        "chat.jira.accountWrite.unlockScope",
      ],
    },
  ];
}
const TASK_REQUIRED = [
  "executingNode",
  "userKey",
  "submittedTime",
  "status",
  "operations",
  "isRerun",
  "currentProgress",
];
const TASK_OPTIONAL = [
  "userName",
  "fullName",
  "currentSubTask",
  "startTime",
  "finishTime",
  "errors",
  "warnings",
];
const OPTIONAL_TEXT = new Map<string, readonly [number, boolean]>([
  ["userName", [255, true]],
  ["fullName", [255, true]],
  ["currentSubTask", [4096, true]],
  ["startTime", [128, false]],
  ["finishTime", [128, false]],
]);
const taskText = (value: unknown, max: number, empty = false): boolean =>
  jiraPresentationNativeText(value, max, { empty, multiline: true });
function diagnosticField(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    exactFields(row, ["field", "message"]) &&
    taskText(row.field, 255) &&
    taskText(row.message, 4096, true)
  );
}
function diagnosticGroup(value: unknown): boolean {
  const row = record(value);
  if (
    row === undefined ||
    !exactFields(row, ["operation"], ["messages", "fields"]) ||
    !taskText(row.operation, 255)
  )
    return false;
  if (
    Object.hasOwn(row, "messages") &&
    !list(row.messages, (message) => taskText(message, 4096, true), 0, 1000, false)
  )
    return false;
  if (!Object.hasOwn(row, "fields")) return true;
  return (
    list(row.fields, diagnosticField, 0, 1000, false) &&
    new Set(row.fields.map((field) => record(field)?.field)).size === row.fields.length
  );
}
function taskDiagnostics(value: unknown): boolean {
  return (
    list(value, diagnosticGroup, 0, 1000, false) &&
    new Set(value.map((group) => record(group)?.operation)).size === value.length
  );
}
function optionalTaskValue(key: string, value: unknown): boolean {
  if (key === "errors" || key === "warnings") return taskDiagnostics(value);
  const bounds = OPTIONAL_TEXT.get(key);
  return bounds !== undefined && taskText(value, ...bounds);
}
function taskOptionalFields(snapshot: Source, progress: Source): boolean {
  return TASK_OPTIONAL.every((key) => {
    const value = snapshot[key];
    if (value === undefined || value === null) return progress[key] === undefined;
    return optionalTaskValue(key, value) && JSON.stringify(value) === JSON.stringify(progress[key]);
  });
}
function requiredTaskFields(snapshot: Source): boolean {
  return (
    principal(snapshot.executingNode) &&
    principal(snapshot.userKey) &&
    taskText(snapshot.submittedTime, 128) &&
    taskText(snapshot.status, 128) &&
    integer(snapshot.currentProgress, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) &&
    typeof snapshot.isRerun === "boolean" &&
    list(snapshot.operations, (value) => taskText(value, 128))
  );
}
function taskSnapshot(data: Source): Source | undefined {
  const snapshot = record(data.reviewSnapshot);
  const progress = record(data.progress);
  if (
    snapshot === undefined ||
    progress === undefined ||
    !exactFields(snapshot, TASK_REQUIRED, TASK_OPTIONAL)
  )
    return undefined;
  if (!requiredTaskFields(snapshot)) return undefined;
  const matching = [
    "userKey",
    "submittedTime",
    "status",
    "isRerun",
    "currentProgress",
    "operations",
  ].every((key) => JSON.stringify(snapshot[key]) === JSON.stringify(progress[key]));
  return matching && taskOptionalFields(snapshot, progress) ? snapshot : undefined;
}
const OPTIONAL_FACTS = [
  ["userName", "chat.jira.fact.userName"],
  ["fullName", "chat.jira.identity.displayName"],
  ["currentSubTask", "chat.jira.jobs.subtask"],
  ["startTime", "chat.jira.jobs.startTime"],
  ["finishTime", "chat.jira.jobs.finishTime"],
] as const;
/** The snapshot is native task metadata; no process-liveness conclusion follows from it. */
export function jiraAnonymizationTaskReviewDetails(data: Source): JiraAgileDetails {
  const snapshot = taskSnapshot(data);
  if (snapshot === undefined)
    return { facts: [], labels: ["chat.jira.accountWrite.taskReviewUnavailable"] };
  const labels: WidgetMessageKey[] = [
    "chat.jira.accountWrite.taskReviewAvailable",
    "chat.jira.accountWrite.taskOwnerNotShutdown",
  ];
  const facts = fact("chat.jira.accountWrite.executingNode", snapshot.executingNode);
  for (const [key, label] of OPTIONAL_FACTS) {
    const detail = jiraNullableReviewFacts(label, snapshot[key]);
    facts.push(...detail.facts);
    labels.push(...detail.labels);
  }
  for (const [key, label] of [
    ["errors", "chat.jira.identity.errorGroups"],
    ["warnings", "chat.jira.identity.warningGroups"],
  ] as const)
    if (snapshot[key] === null) labels.push(label, "chat.jira.structural.nativeNotProvided");
  return { facts, labels };
}
