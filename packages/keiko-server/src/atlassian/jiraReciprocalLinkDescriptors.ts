import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeDeclaration, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const ID = { type: "string", minLength: 1, maxLength: 19, pattern: "^[1-9][0-9]{0,18}$" };
const KEY = { ...text(128), minLength: 1 };
const NAME = { ...text(255), minLength: 1 };
const APP_ID = { type: "string", minLength: 36, maxLength: 36, pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
const DIGEST = { type: "string", minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" };
const REQUIRED = ["expectedActorKey", "expectedIssue", "expectedApplication", "remoteIssueId", "remoteIssueTitle", "sourceRelationship", "targetRelationship", "expectLocalLinkAbsent", "acceptNativeDelegatedEffect"];
export const JIRA_RECIPROCAL_LINK_DEFINITION: JiraNativeDefinition = {
  description: "Create one native reciprocal remote link through the selected local Jira's configured application-link authentication. Requires explicit instance administration authority, high-risk approval and native permissions; ordinary issue-tracker.write and Full access alone are insufficient. Review the exact local actor/issue and configured Jira application ID/name/displayUrl/rpcUrl. Fixed same-host manifest/configuration reads independently bind both application identities; credentials, auth-provider details and arbitrary destinations are never accepted or exposed. Only HTTPS configured destinations are supported. sourceRelationship describes the local link to the selected remote issue; targetRelationship describes the remote backlink to the bound local issue. Numeric issue URLs are minted from the independently observed configuration and bound Pod. Remote issue ID/title remain requested context, not independently observed identity or remote actor/permission. expectLocalLinkAbsent:true requires the complete local native list to lack the target global ID, avoiding a local replacement. acceptNativeDelegatedEffect:true explicitly accepts native remote delegation, possible remote backlink replacement and partial/local/remote consequences. A single POST can partially succeed; all ACKs remain succeeded-unconfirmed even if the local link is observed. Never infer remote completion from the response pair, local list, 404 or visible population; never replay. Local saved edit rules and current authority remain enforced; no remote rule compliance is claimed.",
  input: object({
    expectedActorKey: NAME,
    expectedIssue: object({ id: ID, key: KEY, summary: text(32768), projectId: ID, issueTypeId: ID }, ["id", "key", "summary", "projectId", "issueTypeId"]),
    expectedApplication: object({ id: APP_ID, name: NAME, displayUrl: { ...text(2048), minLength: 1 }, rpcUrl: { ...text(2048), minLength: 1 } }, ["id", "name", "displayUrl", "rpcUrl"]),
    remoteIssueId: ID, remoteIssueTitle: NAME, sourceRelationship: NAME, targetRelationship: NAME,
    expectLocalLinkAbsent: { type: "boolean", enum: [true] }, acceptNativeDelegatedEffect: { type: "boolean", enum: [true] },
  }, REQUIRED),
  result: { ...jiraNativeWriteResult({ userKey: NAME, issueId: ID, issueKey: KEY, applicationLinkId: APP_ID,
    applicationLinkDestinationDigest: DIGEST, selectedRemoteIssueId: ID, delegatedEffectRequested: { type: "boolean", enum: [true] }, linkId: ID }),
    allOf: [{ not: { properties: { outcome: { type: "string", enum: ["succeeded"] } }, required: ["outcome"] } }] },
  risk: "write", maxResultCount: 1,
};
export function jiraReciprocalLinkDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  return name === "jira.create-reciprocal-remote-link" ? jiraNativeDeclaration(name, JIRA_RECIPROCAL_LINK_DEFINITION) : undefined;
}
