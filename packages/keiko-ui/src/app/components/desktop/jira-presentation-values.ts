import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraOutcomeFact } from "./jira-agile-presentation";

export type JiraPresentationSource = Readonly<Record<string, unknown>>;

/** Private saved-result text remains verbatim; whitespace-only values do not become facts. */
export function jiraPresentationText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
