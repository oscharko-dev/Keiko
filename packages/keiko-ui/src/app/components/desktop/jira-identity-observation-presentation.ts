import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraAnonymizationTaskReviewDetails } from "./jira-anonymization-unlock-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationStringList as stringList,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_IDENTITY_OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  "jira_anonymization_validation",
  "jira_anonymization_rerun_validation",
  "jira_anonymization_progress",
  "jira_current_session",
]);
const FLAGS = {
  success: [
    "chat.jira.identity.validationTrue",
    "chat.jira.identity.validationFalse",
    "chat.jira.identity.validationUnknown",
  ],
  deleted: [
    "chat.jira.identity.deletedTrue",
    "chat.jira.identity.deletedFalse",
    "chat.jira.identity.deletedUnknown",
  ],
  businessLogicValidationFailed: [
    "chat.jira.identity.businessFailedTrue",
    "chat.jira.identity.businessFailedFalse",
    "chat.jira.identity.businessFailedUnknown",
  ],
  isRerun: [
    "chat.jira.identity.rerunTrue",
    "chat.jira.identity.rerunFalse",
    "chat.jira.identity.rerunUnknown",
  ],
} as const satisfies Readonly<
  Record<string, readonly [WidgetMessageKey, WidgetMessageKey, WidgetMessageKey]>
>;
function flag(source: Source, field: keyof typeof FLAGS): WidgetMessageKey {
  const value = source[field];
  if (value === true) return FLAGS[field][0];
  return FLAGS[field][value === false ? 1 : 2];
}
function integer(
  label: WidgetMessageKey,
  value: unknown,
  min = Number.MIN_SAFE_INTEGER,
): JiraOutcomeFact[] {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min
    ? [{ label, value: String(value) }]
    : [];
}
function operations(source: Source): JiraAgileDetails {
  const facts = stringList(
    source.operations,
    "chat.jira.identity.operations",
    "chat.jira.identity.operationCount",
  );
  return {
    facts: facts ?? [],
    labels: facts === undefined ? ["chat.jira.identity.operationsUnknown"] : [],
  };
}
function diagnosticMessages(source: Source, kind: WidgetMessageKey): JiraAgileDetails[] {
  const messages = Array.isArray(source.messages)
    ? source.messages.filter((value): value is string => typeof value === "string")
    : [];
  const name = text(source.operation);
  const header: JiraAgileDetails = {
    ...(name === undefined ? {} : { name }),
    ...(messages.length === 0 ? {} : { body: messages.join("\n") }),
    facts: [],
    labels: [kind],
  };
  const fields = Array.isArray(source.fields)
    ? source.fields.flatMap((value: unknown) => {
        const row = record(value);
        if (row === undefined || typeof row.message !== "string") return [];
        const fieldName = text(row.field);
        return [
          {
            ...(fieldName === undefined ? {} : { name: fieldName }),
            body: row.message,
            facts: [],
            labels: [kind],
          } satisfies JiraAgileDetails,
        ];
      })
    : [];
  return [header, ...fields];
}
function diagnostics(source: Source, field: "errors" | "warnings"): JiraAgileDetails[] {
  const values = source[field];
  const isError = field === "errors";
  if (!Array.isArray(values))
    return [
      {
        facts: [],
        labels: [
          isError ? "chat.jira.identity.errorsUnknown" : "chat.jira.identity.warningsUnknown",
        ],
      },
    ];
  const header: JiraAgileDetails = {
    facts: [
      {
        label: isError ? "chat.jira.identity.errorGroups" : "chat.jira.identity.warningGroups",
        value: String(values.length),
      },
    ],
    labels: [],
  };
  return [
    header,
    ...values.flatMap((value: unknown) => {
      const row = record(value);
      if (row === undefined) return [];
      return diagnosticMessages(
        row,
        isError ? "chat.jira.identity.nativeError" : "chat.jira.identity.nativeWarning",
      );
    }),
  ];
}
function taskSelectionLabel(selection: unknown): WidgetMessageKey {
  if (selection === "selected-task") return "chat.jira.jobs.selectedTask";
  if (selection === "active-or-latest") return "chat.jira.jobs.activeOrLatest";
  return "chat.jira.jobs.taskSelectionUnknown";
}
function nameLabels(source: Source, displayField: "displayName" | "fullName"): WidgetMessageKey[] {
  const labels: WidgetMessageKey[] = [];
  if (typeof source.userName === "string" && text(source.userName) === undefined)
    labels.push("chat.jira.identity.blankUsername");
  if (typeof source[displayField] === "string" && text(source[displayField]) === undefined)
    labels.push("chat.jira.identity.blankDisplayName");
  return labels;
}
function validation(tool: string, data: Source): readonly JiraAgileDetails[] {
  const source = record(data.validation) ?? {};
  const labels: WidgetMessageKey[] = [
    "chat.jira.identity.validationOnly",
    flag(source, "success"),
    flag(source, "deleted"),
    flag(source, "businessLogicValidationFailed"),
    ...nameLabels(source, "displayName"),
  ];
  if (tool === "jira_anonymization_rerun_validation")
    labels.push("chat.jira.identity.rerunValidationOnly");
  return [
    {
      facts: [
        ...fact("chat.jira.fact.userKey", data.userKey),
        ...fact("chat.jira.fact.userName", source.userName),
        ...fact("chat.jira.identity.displayName", source.displayName),
      ],
      labels,
    },
    operations(source),
    ...diagnostics(source, "errors"),
    ...diagnostics(source, "warnings"),
  ];
}
function progress(data: Source): readonly JiraAgileDetails[] {
  const source = record(data.progress) ?? {};
  const value = integer("chat.jira.jobs.nativeProgress", source.currentProgress);
  const labels: WidgetMessageKey[] = [
    "chat.jira.identity.progressOnly",
    "chat.jira.identity.progressUnitsUnknown",
    "chat.jira.identity.completionCaveat",
    flag(source, "isRerun"),
    ...nameLabels(source, "fullName"),
  ];
  labels.push(taskSelectionLabel(data.taskSelection));
  if (data.taskSelection === "selected-task") labels.push("chat.jira.identity.requestedTaskOnly");
  if (value.length === 0) labels.push("chat.jira.jobs.progressUnknown");
  if (text(source.status) === undefined) labels.push("chat.jira.jobs.statusUnknown");
  if (source.currentSubTask === "") labels.push("chat.jira.identity.emptySubtask");
  return [
    {
      facts: [
        ...fact("chat.jira.fact.userKey", source.userKey),
        ...fact("chat.jira.fact.userName", source.userName),
        ...fact("chat.jira.identity.displayName", source.fullName),
        ...fact("chat.jira.jobs.selectedTaskId", data.selectedTaskId),
        ...fact("chat.jira.jobs.status", source.status),
        ...value,
        ...fact("chat.jira.jobs.subtask", source.currentSubTask),
        ...fact("chat.jira.jobs.submittedTime", source.submittedTime),
        ...fact("chat.jira.jobs.startTime", source.startTime),
        ...fact("chat.jira.jobs.finishTime", source.finishTime),
      ],
      labels,
    },
    jiraAnonymizationTaskReviewDetails(data),
    operations(source),
    ...diagnostics(source, "errors"),
    ...diagnostics(source, "warnings"),
  ];
}
function session(data: Source): JiraAgileDetails {
  const source = record(data.loginInfo) ?? {};
  const failed = integer("chat.jira.identity.failedLoginCount", source.failedLoginCount, 0);
  const logins = integer("chat.jira.identity.loginCount", source.loginCount, 0);
  const labels: WidgetMessageKey[] = ["chat.jira.identity.sessionOnly"];
  if (failed.length === 0) labels.push("chat.jira.identity.failedLoginCountUnknown");
  if (logins.length === 0) labels.push("chat.jira.identity.loginCountUnknown");
  return {
    facts: [
      ...fact("chat.jira.fact.userKey", data.userKey),
      ...fact("chat.jira.fact.userName", data.username),
      ...failed,
      ...logins,
      ...fact("chat.jira.identity.lastFailedLoginTime", source.lastFailedLoginTime),
      ...fact("chat.jira.identity.previousLoginTime", source.previousLoginTime),
    ],
    labels,
  };
}
/** Persisted observation facts only; never infer a completed identity mutation or a permission grant. */
export function jiraIdentityObservationDetails(
  tool: string,
  data: Source,
): readonly JiraAgileDetails[] {
  if (!JIRA_IDENTITY_OBSERVATION_TOOLS.has(tool) || data.outcome === "failed") return [];
  if (tool === "jira_current_session") return [session(data)];
  return tool === "jira_anonymization_progress" ? progress(data) : validation(tool, data);
}
