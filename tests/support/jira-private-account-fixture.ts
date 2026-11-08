import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraHumanInputPurpose } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraPrivateIdentityPorts } from "../../packages/keiko-connectors/src/jira-private-identity-ports.js";
import type { JiraPrivateAccountMutation, JiraPrivateAccountRead, JiraPrivateAccountReceipt } from "../../packages/keiko-connectors/src/jira-private-account-values.js";

export const PRIVATE_ACCOUNT_ACTOR = { key: "private-actor", name: "private-operator", displayName: "Reviewed operator", active: true } as const;
const TARGET = { key: "private-target", name: "target-user" } as const;
const ACTOR_REF = { key: PRIVATE_ACCOUNT_ACTOR.key, name: PRIVATE_ACCOUNT_ACTOR.name };
const COMMON = { expectedActorKey: PRIVATE_ACCOUNT_ACTOR.key };
const SELF_RECEIPT = { actorUserKey: PRIVATE_ACCOUNT_ACTOR.key, userKey: PRIVATE_ACCOUNT_ACTOR.key, username: PRIVATE_ACCOUNT_ACTOR.name };
interface PrivateWriteCase {
  readonly name: JiraPrivateAccountMutation;
  readonly args: CatalogJsonObject;
  readonly action: JiraHumanInputPurpose | "logout" | "release-websudo";
  readonly fields: CatalogJsonObject;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly apiRoot: "/rest/api/2" | "/rest/auth/1";
  readonly path: string;
  readonly confirmed: boolean;
  readonly receipt: JiraPrivateAccountReceipt;
}
export const PRIVATE_ACCOUNT_WRITE_CASES = [
  { name: "jira.update-myself", args: { ...COMMON, expectedUser: PRIVATE_ACCOUNT_ACTOR, displayName: "Changed operator" }, action: "update-myself", fields: { displayName: "Changed operator" }, method: "PUT", apiRoot: "/rest/api/2", path: "/myself", confirmed: true, receipt: SELF_RECEIPT },
  { name: "jira.update-my-password", args: { ...COMMON, user: ACTOR_REF }, action: "update-my-password", fields: {}, method: "PUT", apiRoot: "/rest/api/2", path: "/myself/password", confirmed: false, receipt: SELF_RECEIPT },
  { name: "jira.update-user-password", args: { ...COMMON, user: TARGET }, action: "update-user-password", fields: { userKey: TARGET.key }, method: "PUT", apiRoot: "/rest/api/2", path: "/user/password?key=private-target", confirmed: false, receipt: { actorUserKey: PRIVATE_ACCOUNT_ACTOR.key, userKey: TARGET.key, username: TARGET.name } },
  { name: "jira.login", args: COMMON, action: "login", fields: {}, method: "POST", apiRoot: "/rest/auth/1", path: "/session", confirmed: true, receipt: { ...SELF_RECEIPT, sessionEstablished: true } },
  { name: "jira.logout", args: COMMON, action: "logout", fields: {}, method: "DELETE", apiRoot: "/rest/auth/1", path: "/session", confirmed: false, receipt: SELF_RECEIPT },
  { name: "jira.release-websudo", args: COMMON, action: "release-websudo", fields: {}, method: "DELETE", apiRoot: "/rest/auth/1", path: "/websudo", confirmed: false, receipt: SELF_RECEIPT },
] as const satisfies readonly PrivateWriteCase[];
interface PrivateReadCase {
  readonly name: JiraPrivateAccountRead;
  readonly args: CatalogJsonObject;
  readonly purpose: JiraHumanInputPurpose;
  readonly fields: CatalogJsonObject;
  readonly path: string;
  readonly scope: "native-password-policy-only" | "native-license-validation-only";
}
export const PRIVATE_ACCOUNT_READ_CASES = [
  { name: "jira.validate-create-user-password", args: { ...COMMON, username: "candidate", displayName: "Candidate", emailAddress: "candidate@example.invalid" }, purpose: "validate-create-user-password", fields: { username: "candidate", displayName: "Candidate", emailAddress: "candidate@example.invalid" }, path: "/password/policy/createUser", scope: "native-password-policy-only" },
  { name: "jira.validate-update-user-password", args: { ...COMMON, user: TARGET }, purpose: "validate-update-user-password", fields: { username: TARGET.name }, path: "/password/policy/updateUser", scope: "native-password-policy-only" },
  { name: "jira.validate-license", args: COMMON, purpose: "validate-license", fields: {}, path: "/licenseValidator", scope: "native-license-validation-only" },
] as const satisfies readonly PrivateReadCase[];

/** Independent public-state fixture. The private port is a custody boundary, not a fake secret
 * source: this fixture neither stores credentials nor reconstructs secret HTTP bodies. */
export function privateAccountFixture() {
  const actor: Record<string, unknown> = { ...PRIVATE_ACCOUNT_ACTOR };
  const target: Record<string, unknown> = { ...TARGET, displayName: "Reviewed target", active: true };
  const reads: string[] = [];
  const calls: { action: string; fields: CatalogJsonObject; expectedActorKey?: string }[] = [];
  const controls = { denyReadback: false, throwReadback: false, wrongReadback: false, shadowUser: false,
    staleActorBeforeDispatch: false, wrongSessionIdentity: false, missingSessionProof: false };
  let privateCalls = 0;
  let outcome: AtlassianWriteHttpOutcome | undefined;
  const validation: Record<string, unknown> = { accepted: true, violationCount: 0 };
  const request: JiraMutationRequest = async (path, method = "GET") => {
    assert.equal(method, "GET"); reads.push(path);
    if (privateCalls > 0 && controls.throwReadback) throw new TypeError("Synthetic private-account readback defect");
    if (privateCalls > 0 && controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (path === "myself") {
      const changed = controls.staleActorBeforeDispatch && reads.length > 1;
      return { ok: true, status: 200, body: { ...actor, ...(changed ? { key: "changed-actor" } : {}) } };
    }
    const url = new URL(path, "https://fixture.invalid/");
    assert.equal(url.pathname, "/user");
    const selected = url.searchParams.get("key") === actor.key || url.searchParams.get("username") === actor.name ? actor : target;
    return { ok: true, status: 200, body: { ...selected, ...(controls.shadowUser ? { key: "shadow-key" } : {}) } };
  };
  async function perform(purpose: JiraHumanInputPurpose, fields: CatalogJsonObject): Promise<AtlassianWriteHttpOutcome> {
    calls.push({ action: purpose, fields: structuredClone(fields) }); privateCalls += 1;
    if (purpose === "update-myself" && !controls.wrongReadback) actor.displayName = fields.displayName;
    if (outcome !== undefined) return outcome;
    if (purpose.startsWith("validate-")) return { ok: true, status: 200, body: { ...validation } };
    if (purpose === "login") return { ok: true, status: 200, body: controls.missingSessionProof ? {} : {
      sessionEstablished: true, userKey: controls.wrongSessionIdentity ? "different-user" : actor.key, username: actor.name,
    } };
    return { ok: true, status: 204, body: undefined };
  }
  const ports: JiraPrivateIdentityPorts = {
    perform,
    unlock: async () => { throw new TypeError("Unlock has its separate task/attestation fixture"); },
    session: async (action, expectedActorKey) => {
      calls.push({ action, fields: {}, expectedActorKey }); privateCalls += 1;
      assert.equal(expectedActorKey, PRIVATE_ACCOUNT_ACTOR.key);
      return outcome ?? { ok: true, status: 204, body: undefined };
    },
  };
  return { actor, target, reads, calls, controls, validation, request, ports,
    setOutcome(value: AtlassianWriteHttpOutcome) { outcome = value; },
    snapshot: () => ({ privateCalls, actor: structuredClone(actor), target: structuredClone(target) }) };
}
