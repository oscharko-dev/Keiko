import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraOutcomeFact } from "./jira-agile-presentation";
import type { JiraDraftValue } from "./jiraDraftTree";

export type JiraPresentationSource = Readonly<Record<string, unknown>>;

/** Private saved-result text remains verbatim; whitespace-only values do not become facts. */
export function jiraPresentationText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
/** Display-only validation of native text; never converts a name into an identifier. */
export function jiraPresentationNativeText(
  value: unknown,
  max: number,
  options: { readonly empty?: boolean; readonly multiline?: boolean } = {},
): value is string {
  if (typeof value !== "string" || value.length > max) return false;
  if (options.empty !== true && value.trim().length === 0) return false;
  const checked = options.multiline === true ? value.replaceAll(/[\t\r\n]/gu, "") : value;
  return !/[\p{Cc}\p{Surrogate}]/u.test(checked);
}
/** Native receipt IDs retain their exact positive int64 spelling. */
export function jiraPresentationIdentity(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[1-9]\d{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
    ? value
    : undefined;
}
/** Copy enumerable own fields; never inherit metadata from a supplied object's prototype. */
export function jiraPresentationRecord(value: unknown): JiraPresentationSource | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
export function jiraPresentationFact(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  const content = jiraPresentationText(value);
  return content === undefined ? [] : [{ label, value: content }];
}

/** A supplied empty list has a known zero count; a missing or malformed list remains unknown. */
export function jiraPresentationStringList(
  value: unknown,
  label: WidgetMessageKey,
  countLabel: WidgetMessageKey,
): JiraOutcomeFact[] | undefined {
  if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === "string"))
    return undefined;
  return [
    ...jiraPresentationFact(label, value.join(", ")),
    { label: countLabel, value: String(value.length) },
  ];
}

/** Display-only receipt status; the caller supplies its closed family's identity completeness. */
export function jiraPresentationMutationLabels(
  source: JiraPresentationSource,
  complete: boolean,
): WidgetMessageKey[] {
  if (!complete) return ["chat.jira.savedConfiguration.identityUnknown"];
  if (source.outcome === "succeeded") return ["chat.jira.savedConfiguration.confirmed"];
  if (source.outcome === "rejected" && source.reason === "conflict" && source.unchanged === true)
    return ["chat.jira.savedConfiguration.unchanged"];
  return ["chat.jira.savedConfiguration.unconfirmed"];
}
/** One plain text value of a reviewed draft. */
export const jiraPresentationLiteral = (text: string): JiraDraftValue => ({ kind: "text", text });
/** The catalog tool a reviewed operation names (dots and dashes folded), when one of the sets owns it. */
export function jiraSelectedMutationTool(
  operation: string | undefined,
  ...owners: readonly ReadonlySet<string>[]
): string | undefined {
  const tool = operation?.replace(/[.-]/gu, "_");
  return tool !== undefined && owners.some((owner) => owner.has(tool)) ? tool : undefined;
}
