import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraOutcomeFact } from "./jira-agile-presentation";

export type JiraPresentationSource = Readonly<Record<string, unknown>>;

/** Private saved-result text remains verbatim; whitespace-only values do not become facts. */
export function jiraPresentationText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
/** Native receipt IDs retain their exact positive int64 spelling. */
export function jiraPresentationIdentity(value: unknown): string | undefined {
  return typeof value === "string" && /^[1-9]\d{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n
    ? value : undefined;
}
/** Copy enumerable own fields; never inherit metadata from a supplied object's prototype. */
export function jiraPresentationRecord(value: unknown): JiraPresentationSource | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : undefined;
}
export function jiraPresentationFact(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  const content = jiraPresentationText(value);
  return content === undefined ? [] : [{ label, value: content }];
}

/** A supplied empty list has a known zero count; a missing or malformed list remains unknown. */
export function jiraPresentationStringList(
  value: unknown, label: WidgetMessageKey, countLabel: WidgetMessageKey,
): JiraOutcomeFact[] | undefined {
  if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === "string")) return undefined;
  return [...jiraPresentationFact(label, value.join(", ")), { label: countLabel, value: String(value.length) }];
}

/** Display-only receipt status; the caller supplies its closed family's identity completeness. */
export function jiraPresentationMutationLabels(source: JiraPresentationSource, complete: boolean): WidgetMessageKey[] {
  if (!complete) return ["chat.jira.savedConfiguration.identityUnknown"];
  if (source.outcome === "succeeded") return ["chat.jira.savedConfiguration.confirmed"];
  if (source.outcome === "rejected" && source.reason === "conflict" && source.unchanged === true)
    return ["chat.jira.savedConfiguration.unchanged"];
  return ["chat.jira.savedConfiguration.unconfirmed"];
}
