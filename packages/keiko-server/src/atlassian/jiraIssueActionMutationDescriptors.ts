import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeIdentitySchema as ID, jiraNativeProjectSchema as KEY, jiraNativeDeclaration, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const DIGEST = { ...text(64), minLength: 64, pattern: "^[a-f0-9]{64}$" };
const PARENT = { expectedActorKey: NAME, issueId: ID, issueKey: KEY };
const RECEIPT = { userKey: NAME, issueId: ID, issueKey: KEY };
const USER = object({ key: NAME, name: NAME }, ["key", "name"]);
const VISIBILITY = object({ type: { type: "string", enum: ["group", "role"] }, value: NAME }, ["type", "value"]);
const COMMON = "Existing authority, selected connection, mode-derived approval, durable intent, ACK observation, readback and replay-refusal owners remain authoritative. Requires ordinary issue-tracker.write; a local grant never substitutes for native Jira permissions. Exact actor and issue ID/key are independently read before dispatch. At most one fixed native effect and no automatic replay after uncertainty. All known receipts fit the existing 16 KiB bound before native requests; bodies, usernames and destinations are never audit fields. These calls do not rewrite issue fields or activate a prose skill as enforcement.";
function write(description: string, input: CatalogJsonObject, fields: CatalogJsonObject, neverConfirmed = false): JiraNativeDefinition {
  const result = jiraNativeWriteResult({ ...RECEIPT, ...fields });
  return { description: `${description} ${COMMON}`, input, result: neverConfirmed
    ? { ...result, allOf: [{ not: { properties: { outcome: { type: "string", enum: ["succeeded"] } }, required: ["outcome"] } }] } : result,
    risk: "write", maxResultCount: 1 };
}
export const JIRA_ISSUE_ACTION_WRITE_DEFINITIONS = {
  "jira.pin-comment": write("Pin exactly one comment using the native JSON Boolean true (not a string/object). Read the exact comment with same-parent self binding, reviewed expectedBody and visibility before and after the effect. Omit expectedVisibility only for an unrestricted comment; null is not an omission. Read the complete bounded native pinned array through the existing comment projection. Already observed pinning is an explicit no-effect conflict. Confirmation requires the same actor, issue, comment body/visibility and exact native pinned entry; a comment404 may mean absent or forbidden, never successful pinning. Unpin is not exposed by this constrained operation.",
    object({ ...PARENT, commentId: ID, expectedBody: text(32768), expectedVisibility: VISIBILITY }, ["expectedActorKey", "issueId", "issueKey", "commentId", "expectedBody"]),
    { commentId: ID, commentPinned: { type: "boolean", enum: [true] } }),
  "jira.notify-issue": write("Request one Jira notification email with confirmEmailSend:true, a one-line subject and plain textBody. Select 1–50 explicit users with exact key and native username, bound independently through both lookup namespaces. Wire recipients use native usernames; raw email addresses, HTML, dynamic groups/watchers/assignee/voter/reporter expansion and arbitrary restriction/transport fields are unsupported here. Jira may reject disabled outgoing email or missing SMTP. Even a readable204 acknowledges the notification request only: there is no independent recipient-delivery proof. Every acknowledged outcome remains unconfirmed; never resend after uncertainty. The private digest binds the exact notification payload and recipientUserKeys are requested principals, not delivered-recipient counts.",
    object({ ...PARENT, subject: NAME, textBody: { ...text(32768), minLength: 1 }, users: { type: "array", minItems: 1, maxItems: 50, items: USER }, confirmEmailSend: { type: "boolean", enum: [true] } },
      ["expectedActorKey", "issueId", "issueKey", "subject", "textBody", "users", "confirmEmailSend"]),
    { notificationDigest: DIGEST, recipientUserKeys: { type: "array", minItems: 1, maxItems: Math.min(50, TOOL_CATALOG_LIMITS.maxArrayItems), items: NAME } }, true),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraIssueActionMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_ISSUE_ACTION_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
