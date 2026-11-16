import {
  isSafeAtlassianIdentifier,
  JIRA_RELEASE_LIFECYCLE_MUTATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationText as text,
  jiraPresentationStringList as stringList,
  jiraPresentationMutationLabels as mutationLabels,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_RELEASE_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set(
  JIRA_RELEASE_LIFECYCLE_MUTATIONS.map((operation) => operation.replace(/[.-]/gu, "_")),
);
export function jiraReleaseReferenceEffectsUnconfirmed(tool: string): boolean {
  return JIRA_RELEASE_LIFECYCLE_TOOLS.has(tool) && tool !== "jira_move_version";
}
function targetsComplete(tool: string, source: Source): boolean {
  if (tool === "jira_merge_version")
    return (
      identity(source.targetVersionId) !== undefined && source.targetVersionId !== source.versionId
    );
  if (tool === "jira_delete_component")
    return (
      !Object.hasOwn(source, "replacementComponentId") ||
      (identity(source.replacementComponentId) !== undefined &&
        source.replacementComponentId !== source.componentId)
    );
  if (tool !== "jira_remove_and_swap_version") return true;
  const ids = source.replacementVersionIds;
  return (
    Array.isArray(ids) &&
    ids.every((id: unknown) => identity(id) !== undefined && id !== source.versionId) &&
    new Set(ids).size === ids.length
  );
}
/** Context establishes the known resource, never completeness of issue-reference side effects. */
export function jiraReleaseLifecycleIdentityComplete(tool: string, source: Source): boolean {
  if (!JIRA_RELEASE_LIFECYCLE_TOOLS.has(tool)) return false;
  return (
    identity(source.projectId) !== undefined &&
    isSafeAtlassianIdentifier(source.projectKey) &&
    text(source.userKey) !== undefined &&
    identity(source[tool === "jira_delete_component" ? "componentId" : "versionId"]) !==
      undefined &&
    targetsComplete(tool, source)
  );
}
function outcomeLabels(tool: string, source: Source): WidgetMessageKey[] {
  if (!jiraReleaseLifecycleIdentityComplete(tool, source))
    return ["chat.jira.savedConfiguration.identityUnknown"];
  if (jiraReleaseReferenceEffectsUnconfirmed(tool))
    return ["chat.jira.releaseLifecycle.referencesUnconfirmed"];
  if (source.outcome === "succeeded") return ["chat.jira.releaseLifecycle.orderConfirmed"];
  return mutationLabels(source, true);
}
export function jiraReleaseLifecycleDetails(
  tool: string,
  source: Source,
): readonly JiraAgileDetails[] {
  if (!JIRA_RELEASE_LIFECYCLE_TOOLS.has(tool)) return [];
  const replacements =
    tool === "jira_remove_and_swap_version"
      ? stringList(
          source.replacementVersionIds,
          "chat.jira.releaseLifecycle.replacementVersions",
          "chat.jira.releaseLifecycle.replacementCount",
        )
      : undefined;
  return [
    {
      facts: [
        ...fact("chat.jira.fact.projectId", identity(source.projectId)),
        ...fact("chat.jira.fact.projectKey", source.projectKey),
        ...fact("chat.jira.fact.userKey", source.userKey),
        ...fact("chat.jira.fact.componentId", identity(source.componentId)),
        ...fact("chat.jira.fact.versionId", identity(source.versionId)),
        ...fact(
          "chat.jira.releaseLifecycle.replacementComponent",
          identity(source.replacementComponentId),
        ),
        ...fact("chat.jira.releaseLifecycle.targetVersion", identity(source.targetVersionId)),
        ...(replacements ?? []),
      ],
      labels: [
        ...outcomeLabels(tool, source),
        "chat.jira.releaseLifecycle.knownTargets",
        ...(tool === "jira_move_version" ? ["chat.jira.releaseLifecycle.orderOnly" as const] : []),
      ],
    },
  ];
}
