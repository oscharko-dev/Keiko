import type { JiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { matchingJiraIssueTemplates } from "./jira-issue-template-check.js";
import {
  readJiraCreateTemplateIdentity,
  type JiraIssueTemplateSet,
} from "./jira-managed-template-gate.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { requestFor } from "./jira-managed-mutations.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";

const TEMPLATES_MAX = 8;
const TEMPLATE_BYTES_MAX = 16_384;

function ruleFacts(template: JiraIssueTemplate, set: JiraIssueTemplateSet): CatalogJsonObject {
  const source = set.references?.find((reference) => reference.template === template);
  return {
    project: template.project,
    issueType: template.issueType,
    operation: "create",
    ...(source === undefined
      ? {}
      : { source: { id: source.id, revision: source.revision, digest: source.digest } }),
    summary: { ...template.summary },
    requiredFields: [...template.requiredFields],
    requiredSections: [...template.requiredSections],
    labels: { ...template.labels, required: [...template.labels.required] },
    parent: { ...template.parent },
  };
}

function boundedRules(
  matching: readonly JiraIssueTemplate[],
  set: JiraIssueTemplateSet,
): CatalogJsonObject {
  const items: CatalogJsonObject[] = [];
  for (const template of matching) {
    const item = ruleFacts(template, set);
    if (
      items.length === TEMPLATES_MAX ||
      Buffer.byteLength(JSON.stringify([...items, item])) > TEMPLATE_BYTES_MAX
    )
      break;
    items.push(item);
  }
  return {
    items,
    matchedCount: matching.length,
    omittedCount: matching.length - items.length,
    complete: items.length === matching.length,
    unreadableCount: 0,
  };
}

function unreadableRules(
  connection: JiraManagedConnection,
  unreadableCount: number,
): ManagedMcpToolResult {
  connection.templateMetadataActivity?.({
    matchedCount: 0,
    returnedCount: 0,
    omittedCount: 0,
    unreadableCount,
  });
  const result = jiraReadFailure("template-unreadable");
  return {
    ...result,
    data: {
      ...result.data,
      applicableTemplates: {
        items: [],
        matchedCount: 0,
        omittedCount: 0,
        unreadableCount,
        complete: false,
      },
    },
  };
}

function matchedRulesResult(
  result: ManagedMcpToolResult,
  matching: readonly JiraIssueTemplate[],
  set: JiraIssueTemplateSet,
  connection: JiraManagedConnection,
): ManagedMcpToolResult {
  const rules = boundedRules(matching, set);
  const returnedCount = Array.isArray(rules.items) ? rules.items.length : 0;
  connection.templateMetadataActivity?.({
    matchedCount: matching.length,
    returnedCount,
    omittedCount: matching.length - returnedCount,
    unreadableCount: 0,
  });
  return matching.length === 0
    ? result
    : { ...result, data: { ...result.data, applicableTemplates: rules } };
}

function admitted(context: ManagedMcpInvocationContext): boolean {
  return !context.signal.aborted && context.beforeEffect();
}

function readIdentity(
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): ReturnType<typeof readJiraCreateTemplateIdentity> {
  if (typeof args.projectKey !== "string" || typeof args.issueTypeId !== "string")
    return Promise.resolve({ ok: false, reason: "malformed-payload" });
  return readJiraCreateTemplateIdentity(
    requestFor(connection, context),
    args.projectKey,
    args.issueTypeId,
  );
}

/** Read the same rules the create gate will judge, without selecting another instruction skill. */
export async function withCreateTemplateMetadata(
  result: ManagedMcpToolResult,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<ManagedMcpToolResult> {
  if (result.data.outcome !== "succeeded" || connection.issueTemplates === undefined) return result;
  if (!admitted(context)) return jiraReadFailure("permission-denied");
  const initial = connection.issueTemplates();
  if (initial.unreadable > 0) return unreadableRules(connection, initial.unreadable);
  if (
    !initial.templates.some((template) =>
      template.activations.some((activation) => activation.kind === "create"),
    )
  )
    return result;
  const identity = await readIdentity(args, context, connection);
  if ("ok" in identity) return jiraReadFailure(identity.reason);
  if (!admitted(context)) return jiraReadFailure("permission-denied");
  // The rules and their references come from one current snapshot after the identity reads.
  const set = connection.issueTemplates();
  if (set.unreadable > 0) return unreadableRules(connection, set.unreadable);
  const matching = matchingJiraIssueTemplates(set.templates, {
    ...identity,
    operation: "create",
    fields: {},
  });
  const enriched = matchedRulesResult(result, matching, set, connection);
  if (!admitted(context)) return jiraReadFailure("permission-denied");
  return enriched;
}
