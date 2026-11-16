import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const ACCEPT = { type: "boolean", enum: [true] };
const USER = object({ key: NAME, name: NAME }, ["key", "name"]);
const REVIEW = object({ key: NAME, name: NAME, displayName: NAME, active: { type: "boolean" } }, [
  "key",
  "name",
  "displayName",
  "active",
]);
const OPERATIONS = {
  type: "array",
  minItems: 1,
  maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
  uniqueItems: true,
  items: { ...text(128), minLength: 1 },
};
const COMMON =
  "Requires explicit Jira administration authority and the existing high-risk policy, native administrator/directory permissions, reviewed actor, durable journal and one-effect transport. This is not atomic CAS: native user keys and usernames must independently match before dispatch. Missing metadata is unknown, never an empty/default user. No password, current/new password, license text, cookie, session token, arbitrary URL or header can be supplied by a model or returned in a result. Existing credential-floor and body-free log owners remain authoritative. Never replay an unknown or acknowledged-unconfirmed effect or replace the target with a same-name user in another directory.";
function definition(
  description: string,
  input: CatalogJsonObject,
  extra: CatalogJsonObject,
  mayConfirmMetadata = false,
): JiraNativeDefinition {
  const result = jiraNativeWriteResult({
    actorUserKey: NAME,
    userKey: NAME,
    username: NAME,
    ...extra,
  });
  return {
    description: `${description} ${COMMON}`,
    input,
    result: {
      ...result,
      allOf: [
        {
          not: {
            properties: { outcome: { type: "string", enum: ["succeeded"] } },
            required: mayConfirmMetadata ? ["outcome", "userActive"] : ["outcome"],
          },
        },
      ],
    },
    risk: "write",
    maxResultCount: 1,
  };
}
const ANON = {
  expectedActorKey: NAME,
  user: USER,
  newOwner: USER,
  expectedOperations: OPERATIONS,
  confirmIrreversibleAnonymization: ACCEPT,
};
const ANON_REQUIRED = [
  "expectedActorKey",
  "user",
  "newOwner",
  "expectedOperations",
  "confirmIrreversibleAnonymization",
];
const ANON_RECEIPT = { newOwnerUserKey: NAME, anonymizationRequested: ACCEPT };
const ANON_RULE =
  "Schedule only after the exact current target and a different active new owner have both been independently bound by key and username. Reuse native validation for this exact operation: require explicit success, deleted:false, businessLogicValidationFailed:false, complete empty errors and warnings, and exactly the reviewed native handler set. Missing diagnostics do not become empty. Historical rerun selectors are explicit, never reconstructed from names. The 202 acknowledgement only schedules irreversible work; extended validation may still fail. Never follow Location/progress URLs, invent a task ID or attribute active-or-latest progress to this invocation. Always unconfirmed; no completion or global ownership migration claim.";
export const JIRA_IDENTITY_WRITE_DEFINITIONS = {
  "jira.create-user": definition(
    "Create a native user with name, emailAddress and displayName only. acceptGeneratedPassword:true explicitly accepts Jira's documented randomly generated password when the field is omitted; the generated secret is never read or returned. No applicationKeys or email-notification override is sent, and no default access/notification delivery is claimed. acceptUnverifiedAccess:true is required. A native key and exact name must be present in the ACK and independently rebound; missing ACK never triggers name-based reconciliation. Even observed creation remains unconfirmed for credentials, directory defaults and effective access.",
    object(
      {
        expectedActorKey: NAME,
        name: NAME,
        emailAddress: { ...text(254), minLength: 1 },
        displayName: NAME,
        acceptGeneratedPassword: ACCEPT,
        acceptUnverifiedAccess: ACCEPT,
      },
      [
        "expectedActorKey",
        "name",
        "emailAddress",
        "displayName",
        "acceptGeneratedPassword",
        "acceptUnverifiedAccess",
      ],
    ),
    { userPresent: ACCEPT },
  ),
  "jira.update-user": definition(
    "Update only displayName and/or active on the exact reviewed native key; username/key/email/password/application assignment cannot be changed by this operation. expectedUser includes complete observed displayName and active, preserving explicit false. At least one target field is required. Active changes additionally require acceptUnverifiedAccess:true and remain unconfirmed for aggregate access/session/license effects. A displayName-only update may confirm the independently read same-user metadata. Readonly directories and native permissions remain real refusals.",
    {
      ...object(
        {
          expectedActorKey: NAME,
          expectedUser: REVIEW,
          displayName: NAME,
          active: { type: "boolean" },
          acceptUnverifiedAccess: ACCEPT,
        },
        ["expectedActorKey", "expectedUser"],
      ),
      allOf: [
        { anyOf: [{ required: ["displayName"] }, { required: ["active"] }] },
        { anyOf: [{ not: { required: ["active"] } }, { required: ["acceptUnverifiedAccess"] }] },
      ],
    },
    { userPresent: ACCEPT, userActive: { type: "boolean" } },
    true,
  ),
  "jira.delete-user": definition(
    "Delete only the reviewed native user key after independently binding the separate username and complete displayName/active snapshot. confirmIrreversibleDeletion:true is required. Native deletion may remove global references while a same-name shadowing user remains in another directory. No 404/search result proves those consequences. Every acknowledged deletion remains unconfirmed; userPresent:false is the requested target only.",
    object({ expectedActorKey: NAME, expectedUser: REVIEW, confirmIrreversibleDeletion: ACCEPT }, [
      "expectedActorKey",
      "expectedUser",
      "confirmIrreversibleDeletion",
    ]),
    { userPresent: { type: "boolean", enum: [false] } },
  ),
  "jira.invalidate-user-session": definition(
    "Request session invalidation for one independently bound user, using the exact native username in one fixed encoded path segment. Unsupported encoded separator/percent/dot/control selectors refuse before reads. confirmSessionInvalidation:true is required. No cookie is read, generated, exported or changed locally; a PAT is not a browser session. Native acknowledgement cannot prove every browser session was removed, so userSessionInvalidationRequested:true remains an unconfirmed request.",
    object({ expectedActorKey: NAME, user: USER, confirmSessionInvalidation: ACCEPT }, [
      "expectedActorKey",
      "user",
      "confirmSessionInvalidation",
    ]),
    { userSessionInvalidationRequested: ACCEPT },
  ),
  "jira.schedule-user-anonymization": definition(
    ANON_RULE,
    object(ANON, ANON_REQUIRED),
    ANON_RECEIPT,
  ),
  "jira.rerun-user-anonymization": definition(
    ANON_RULE,
    object({ ...ANON, oldUserKey: NAME, oldUserName: NAME }, ANON_REQUIRED),
    { ...ANON_RECEIPT, anonymizationRerunRequested: ACCEPT },
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraIdentityMutationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_IDENTITY_WRITE_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
