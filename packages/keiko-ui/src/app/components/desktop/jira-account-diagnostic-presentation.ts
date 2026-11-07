import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_ACCOUNT_DIAGNOSTIC_TOOLS: ReadonlySet<string> = new Set([
  "jira_password_policy", "jira_duplicate_user_count", "jira_duplicate_users", "jira_search_error",
]);
function count(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? [{ label, value: String(value) }] : [];
}
function listHeader(data: Source, label: WidgetMessageKey): JiraAgileDetails {
  const facts = count(label, data.total);
  return { facts, labels: facts.length === 0 ? ["chat.jira.accounts.countUnknown"] : [] };
}
function policy(data: Source): readonly JiraAgileDetails[] {
  const header = listHeader(data, "chat.jira.accounts.requirementCount");
  const labels: WidgetMessageKey[] = [
    "chat.jira.accounts.requirementsOnly",
    data.hasOldPassword === true ? "chat.jira.accounts.withOldPassword"
      : data.hasOldPassword === false ? "chat.jira.accounts.withoutOldPassword"
        : "chat.jira.accounts.passwordContextUnknown",
  ];
  const items = Array.isArray(data.items) ? data.items.flatMap((value: unknown) => {
    const requirement = text(record(value)?.requirement);
    return requirement === undefined ? [] : [{ body: requirement, facts: [], labels: [] }];
  }) : [];
  return [{ ...header, labels: [...header.labels, ...labels] }, ...items];
}
function duplicateUser(value: unknown): readonly JiraAgileDetails[] {
  const source = record(value);
  if (source === undefined || text(source.username) === undefined) return [];
  const user = fact("chat.jira.accounts.username", source.username);
  if (!Array.isArray(source.directories)) return [{ facts: user, labels: ["chat.jira.accounts.directoriesUnknown"] }];
  const header: JiraAgileDetails = {
    facts: [...user, ...count("chat.jira.accounts.directoryCount", source.directories.length)], labels: [],
  };
  const directories = source.directories.flatMap((value: unknown): JiraAgileDetails[] => {
    const directory = record(value);
    if (directory === undefined) return [];
    return [{
      facts: [...user, ...fact("chat.jira.accounts.directoryId", directory.directoryId),
        ...fact("chat.jira.accounts.directoryName", directory.directoryName)],
      labels: [directory.userActive === true ? "chat.jira.accounts.active"
        : directory.userActive === false ? "chat.jira.accounts.inactive" : "chat.jira.accounts.activityUnknown"],
    }];
  });
  return [header, ...directories];
}
function duplicates(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (tool === "jira_duplicate_user_count") {
    const facts = count("chat.jira.accounts.duplicateCount", data.count);
    return [{ facts, labels: ["chat.jira.accounts.cachedOnly",
      ...(facts.length === 0 ? ["chat.jira.accounts.countUnknown"] as const : [])] }];
  }
  const header = listHeader(data, "chat.jira.accounts.cachedUsernames");
  const users = Array.isArray(data.items) ? data.items.flatMap(duplicateUser) : [];
  return [{ ...header, labels: [...header.labels, "chat.jira.accounts.cachedOnly"] }, ...users];
}
function searchError(data: Source): JiraAgileDetails {
  const message = text(data.message);
  return {
    facts: [],
    ...(data.errorPresent === true && message !== undefined ? { body: message } : {}),
    labels: ["chat.jira.accounts.searchContext", data.errorPresent === false
      ? "chat.jira.accounts.noStoredError" : data.errorPresent === true && message !== undefined
        ? "chat.jira.accounts.storedError" : "chat.jira.accounts.searchErrorUnknown"],
  };
}
/** Existing result cards render private observations as text without deriving account or password authority. */
export function jiraAccountDiagnosticDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_ACCOUNT_DIAGNOSTIC_TOOLS.has(tool) || data.outcome === "failed") return [];
  if (tool === "jira_password_policy") return policy(data);
  return tool === "jira_search_error" ? [searchError(data)] : duplicates(tool, data);
}
