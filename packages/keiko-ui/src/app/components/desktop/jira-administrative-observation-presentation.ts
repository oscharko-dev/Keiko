import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_ADMINISTRATIVE_OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  "jira_permission_scheme_attribute", "jira_email_template_types",
]);
const EMAIL_FLAGS: Readonly<Record<string, readonly [WidgetMessageKey, WidgetMessageKey, WidgetMessageKey]>> = {
  active: ["chat.jira.adminObservation.active", "chat.jira.adminObservation.inactive", "chat.jira.adminObservation.activeUnknown"],
  batchedNotification: ["chat.jira.adminObservation.batched", "chat.jira.adminObservation.unbatched", "chat.jira.adminObservation.batchedUnknown"],
  html: ["chat.jira.adminObservation.html", "chat.jira.adminObservation.noHtml", "chat.jira.adminObservation.htmlUnknown"],
  text: ["chat.jira.adminObservation.text", "chat.jira.adminObservation.noText", "chat.jira.adminObservation.textUnknown"],
};
function attribute(data: Source): JiraAgileDetails {
  const labels: WidgetMessageKey[] = ["chat.jira.adminObservation.configurationOnly"];
  const facts: JiraOutcomeFact[] = [
    ...fact("chat.jira.adminObservation.schemeId", data.schemeId),
    ...fact("chat.jira.adminObservation.attributeKey", data.attributeKey),
  ];
  if (data.valueState !== "observed" || typeof data.textValue !== "string")
    labels.push("chat.jira.adminObservation.valueUnknown");
  else if (data.textValue === "") labels.push("chat.jira.adminObservation.emptyValue");
  else facts.push({ label: "chat.jira.adminObservation.attributeValue", value: data.textValue });
  return { facts, labels };
}
function emailType(value: unknown): readonly JiraAgileDetails[] {
  const item = record(value);
  if (item === undefined) return [];
  return [{
    facts: [...fact("chat.jira.adminObservation.eventId", item.id),
      ...fact("chat.jira.adminObservation.eventName", item.eventName),
      ...fact("chat.jira.adminObservation.templateName", item.templateName)],
    labels: Object.entries(EMAIL_FLAGS).map(([key, labels]) =>
      item[key] === true ? labels[0] : item[key] === false ? labels[1] : labels[2]),
  }];
}
/** Configuration observations remain ordinary text in the established design-system cards. */
export function jiraAdministrativeObservationDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_ADMINISTRATIVE_OBSERVATION_TOOLS.has(tool) || data.outcome === "failed") return [];
  if (tool === "jira_permission_scheme_attribute") return [attribute(data)];
  const facts = typeof data.total === "number" && Number.isSafeInteger(data.total) && data.total >= 0
    ? [{ label: "chat.jira.adminObservation.typeCount" as const, value: String(data.total) }] : [];
  return [{ facts, labels: ["chat.jira.adminObservation.metadataOnly",
    ...(facts.length === 0 ? ["chat.jira.adminObservation.countUnknown"] as const : [])] },
    ...(Array.isArray(data.items) ? data.items.flatMap(emailType) : [])];
}
