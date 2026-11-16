import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import { jiraPropertyValueDetails } from "./jira-property-presentation";
import { jiraVersionReviewGlobalId } from "./jira-planning-mutation-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationRecord as record,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_REMOTE_VERSION_LINK_TOOLS: ReadonlySet<string> = new Set([
  "jira_remote_version_links",
  "jira_version_remote_links",
  "jira_version_remote_link",
]);
function header(data: Source): JiraAgileDetails {
  const labels: WidgetMessageKey[] = [
    "chat.jira.versionLinks.scope",
    "chat.jira.properties.pointerHelp",
  ];
  if (!Array.isArray(data.items)) labels.push("chat.jira.versionLinks.listUnknown");
  else if (data.items.length === 0) labels.push("chat.jira.versionLinks.emptyList");
  return {
    facts: [
      ...fact("chat.jira.fact.versionId", identity(data.versionId)),
      ...fact("chat.jira.versionLinks.versionName", data.versionName),
      ...fact("chat.jira.versionLinks.selectedGlobalId", data.selectedGlobalId),
    ],
    labels,
  };
}
function linkDetails(value: unknown, position: number): readonly JiraAgileDetails[] {
  const source = record(value);
  const association = [
    { label: "chat.jira.versionLinks.position" as const, value: String(position) },
  ];
  const reviewable =
    source?.reviewIdentityAvailable === true && jiraVersionReviewGlobalId(source.globalId, false);
  const facts = [
    ...association,
    ...fact("chat.jira.versionLinks.name", source?.name),
    ...(reviewable ? fact("chat.jira.issueContext.globalId", source.globalId) : []),
  ];
  const identityLabels: WidgetMessageKey[] = [
    reviewable
      ? "chat.jira.versionLinkWrite.identityAvailable"
      : "chat.jira.versionLinkWrite.identityUnavailable",
  ];
  if (
    source?.valueAvailable !== true ||
    !Array.isArray(source.valueNodes) ||
    source.valueNodes.length === 0
  )
    return [{ facts, labels: [...identityLabels, "chat.jira.versionLinks.valueUnknown"] }];
  return [
    { facts, labels: identityLabels },
    ...source.valueNodes.map((node: unknown): JiraAgileDetails => {
      const row = record(node);
      const details =
        row === undefined
          ? { facts: [], labels: ["chat.jira.properties.valueUnknown"] as const }
          : jiraPropertyValueDetails(row);
      return { ...details, facts: [...association, ...details.facts] };
    }),
  ];
}
/** The native JSON string has already been decoded. Render only its saved typed nodes. */
export function jiraRemoteVersionLinkDetails(
  tool: string,
  data: Source,
): readonly JiraAgileDetails[] {
  if (!JIRA_REMOTE_VERSION_LINK_TOOLS.has(tool) || data.outcome === "failed") return [];
  const start =
    typeof data.startAt === "number" && Number.isSafeInteger(data.startAt) && data.startAt >= 0
      ? data.startAt
      : 0;
  return [
    header(data),
    ...(Array.isArray(data.items)
      ? data.items.flatMap((value: unknown, index: number) => linkDetails(value, start + index + 1))
      : []),
  ];
}
