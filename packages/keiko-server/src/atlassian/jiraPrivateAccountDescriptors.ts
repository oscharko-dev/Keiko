import type {
  JiraManagedReadToolName,
  JiraPrivateAccountMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeReadResult,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
type PrivateAccountRead = Extract<
  JiraManagedReadToolName,
  | "jira.validate-create-user-password"
  | "jira.validate-update-user-password"
  | "jira.validate-license"
>;
const BOOL = { type: "boolean" };
const TRUE = { type: "boolean", enum: [true] };
const ACTOR = { expectedActorKey: NAME };
const USER = object({ key: NAME, name: NAME }, ["key", "name"]);
const REVIEW = object({ key: NAME, name: NAME, displayName: NAME, active: BOOL }, [
  "key",
  "name",
  "displayName",
  "active",
]);
const RECEIPT = { actorUserKey: NAME, userKey: NAME, username: NAME };
const COMMON =
  "Use only the existing server-bound protected human-input/session channel; model arguments never contain passwords, current passwords, license text, cookies, tokens, headers, input request IDs or private selection handles. Existing authority, native permission checks, credential floor and body-free logs remain authoritative. Required review and allowed policy keep their existing semantics. A PAT alone is not a cookie session. Readonly previews do not consume protected input or establish a session. Each write uses the durable journal and one-effect transport; never replay uncertainty or silently reconnect.";
function write(
  description: string,
  input: CatalogJsonObject,
  confirmation: "profile" | "login" | "none",
): JiraNativeDefinition {
  const required = [
    "outcome",
    "actorUserKey",
    "userKey",
    "username",
    ...(confirmation === "login" ? ["sessionEstablished"] : []),
  ];
  const fields = { ...RECEIPT, ...(confirmation === "login" ? { sessionEstablished: TRUE } : {}) };
  const success = { properties: { outcome: { type: "string", enum: ["succeeded"] } }, required };
  return {
    description: `${description} ${COMMON}`,
    input,
    result: jiraNativeWriteResult(fields, confirmation === "none" ? false : success),
    risk: "write",
    maxResultCount: 1,
  };
}
export const JIRA_PRIVATE_ACCOUNT_WRITE_DEFINITIONS = {
  "jira.update-myself": write(
    "Update only the connected user's displayName after exact observed key/name/displayName/active review. The native API requires the current password, supplied only through protected input. Email and active state are not editable here. Exact unchanged metadata is a pre-effect no-op; a changed displayName confirms only after an independent same-user readback. Ordinary issue-tracker.write authority and high-risk policy apply.",
    object({ ...ACTOR, expectedUser: REVIEW, displayName: NAME }, [
      "expectedActorKey",
      "expectedUser",
      "displayName",
    ]),
    "profile",
  ),
  "jira.update-my-password": write(
    "Change only the connected user's password through protected current/new-password input. The reviewed user key and username must independently match the actor. Native acknowledgement cannot prove credentials, session continuity or all authentication effects; always unconfirmed. Ordinary issue-tracker.write authority and high-risk policy apply.",
    object({ ...ACTOR, user: USER }, ["expectedActorKey", "user"]),
    "none",
  ),
  "jira.update-user-password": write(
    "Request an administrator password change for the exact independently bound user key and username. New password input remains private. Explicit issue-tracker.admin authority, high-risk policy and native administrator/directory permission are required. Always unconfirmed after acknowledgement; no credential success or session invalidation claim.",
    object({ ...ACTOR, user: USER }, ["expectedActorKey", "user"]),
    "none",
  ),
  "jira.login": write(
    "Establish a private native Jira session for the already bound connected actor through protected input. Success requires the custody owner's independent cookie-only myself and auth-session identity checks; no PAT fallback or secret response is exposed. sessionEstablished:true describes this private session only, never all browser sessions or elevated rights. Ordinary issue-tracker.write authority and high-risk policy apply.",
    object(ACTOR, ["expectedActorKey"]),
    "login",
  ),
  "jira.logout": write(
    "Request logout only for the current private session bound to the reviewed actor, through the existing custody owner. No arbitrary cookie or session selector is accepted. Acknowledgement remains unconfirmed, with no assertion about other sessions or PAT access. Ordinary issue-tracker.write authority and high-risk policy apply.",
    object(ACTOR, ["expectedActorKey"]),
    "none",
  ),
  "jira.release-websudo": write(
    "Request release of websudo for the current private session bound to the reviewed actor. It does not change application roles or global permissions. Native acknowledgement remains unconfirmed for session-wide elevation state. Ordinary issue-tracker.write authority and high-risk policy apply.",
    object(ACTOR, ["expectedActorKey"]),
    "none",
  ),
} as const satisfies Readonly<Record<JiraPrivateAccountMutation, JiraNativeDefinition>>;

function validation(
  description: string,
  input: CatalogJsonObject,
  scope: "native-password-policy-only" | "native-license-validation-only",
  target: CatalogJsonObject,
): JiraNativeDefinition {
  const fields = {
    actorUserKey: NAME,
    validationScope: { type: "string", enum: [scope] },
    accepted: BOOL,
    violationCount: { type: "integer", minimum: 0, maximum: TOOL_CATALOG_LIMITS.maxArrayItems },
    ...target,
  };
  return {
    description: `${description} ${COMMON}`,
    input,
    risk: "read",
    maxResultCount: 1,
    result: {
      ...jiraNativeReadResult(fields),
      allOf: [
        {
          anyOf: [
            {
              properties: { outcome: { type: "string", enum: ["failed"] } },
              required: ["outcome"],
            },
            {
              properties: {
                outcome: { type: "string", enum: ["succeeded"] },
                accepted: { type: "boolean", enum: [true] },
                violationCount: { type: "integer", enum: [0] },
              },
              required: ["outcome", ...Object.keys(fields)],
            },
            {
              properties: {
                outcome: { type: "string", enum: ["succeeded"] },
                accepted: { type: "boolean", enum: [false] },
                violationCount: { type: "integer", minimum: 1 },
              },
              required: ["outcome", ...Object.keys(fields)],
            },
          ],
        },
      ],
    },
  };
}
export const JIRA_PRIVATE_ACCOUNT_READ_DEFINITIONS = {
  "jira.validate-create-user-password": validation(
    "Run the documented native POST password-policy validation for a prospective user's public username/displayName/email context. Password input stays private. It creates no user, checks no username availability and proves no authentication. Only accepted and bounded violationCount are returned; reflected native text is withheld. This is an ordinary read/low-risk operation despite its HTTP method.",
    object(
      { ...ACTOR, username: NAME, displayName: NAME, emailAddress: { ...text(254), minLength: 1 } },
      ["expectedActorKey", "username", "displayName", "emailAddress"],
    ),
    "native-password-policy-only",
    { username: NAME },
  ),
  "jira.validate-update-user-password": validation(
    "Run native POST password-policy validation for one independently bound existing key/username. Protected input supplies passwords; this does not change the password or validate the old password. Return only accepted and violationCount, never native reflected text. This is an ordinary read/low-risk operation despite its HTTP method.",
    object({ ...ACTOR, user: USER }, ["expectedActorKey", "user"]),
    "native-password-policy-only",
    { userKey: NAME, username: NAME },
  ),
  "jira.validate-license": validation(
    "Validate protected license text through the fixed native POST without activating or updating a license. The native echoed license and error messages never enter a result. accepted describes validation only, not ownership, entitlement or installation state. Explicit issue-tracker.admin authority and high-risk approval policy apply even though this is a read operation.",
    object(ACTOR, ["expectedActorKey"]),
    "native-license-validation-only",
    {},
  ),
} as const satisfies Readonly<Record<PrivateAccountRead, JiraNativeDefinition>>;

const DEFINITIONS: Readonly<Record<string, JiraNativeDefinition>> = {
  ...JIRA_PRIVATE_ACCOUNT_WRITE_DEFINITIONS,
  ...JIRA_PRIVATE_ACCOUNT_READ_DEFINITIONS,
};
export function jiraPrivateAccountDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const selected = Object.hasOwn(DEFINITIONS, name) ? DEFINITIONS[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
