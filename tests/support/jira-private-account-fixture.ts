import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraHumanInputPurpose } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { settleSync } from "./jira-fixture-settle.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraPrivateIdentityPorts } from "../../packages/keiko-connectors/src/jira-private-identity-ports.js";
import type {
  JiraPrivateAccountMutation,
  JiraPrivateAccountRead,
  JiraPrivateAccountReceipt,
} from "../../packages/keiko-connectors/src/jira-private-account-values.js";

export const PRIVATE_ACCOUNT_ACTOR = {
  key: "private-actor",
  name: "private-operator",
  displayName: "Reviewed operator",
  active: true,
} as const;
const TARGET = { key: "private-target", name: "target-user" } as const;
const ACTOR_REF = { key: PRIVATE_ACCOUNT_ACTOR.key, name: PRIVATE_ACCOUNT_ACTOR.name };
const COMMON = { expectedActorKey: PRIVATE_ACCOUNT_ACTOR.key };
const SELF_RECEIPT = {
  actorUserKey: PRIVATE_ACCOUNT_ACTOR.key,
  userKey: PRIVATE_ACCOUNT_ACTOR.key,
  username: PRIVATE_ACCOUNT_ACTOR.name,
};
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
  {
    name: "jira.update-myself",
    args: { ...COMMON, expectedUser: PRIVATE_ACCOUNT_ACTOR, displayName: "Changed operator" },
    action: "update-myself",
    fields: { displayName: "Changed operator" },
    method: "PUT",
    apiRoot: "/rest/api/2",
    path: "/myself",
    confirmed: true,
    receipt: SELF_RECEIPT,
  },
  {
    name: "jira.update-my-password",
    args: { ...COMMON, user: ACTOR_REF },
    action: "update-my-password",
    fields: {},
    method: "PUT",
    apiRoot: "/rest/api/2",
    path: "/myself/password",
    confirmed: false,
    receipt: SELF_RECEIPT,
  },
  {
    name: "jira.update-user-password",
    args: { ...COMMON, user: TARGET },
    action: "update-user-password",
    fields: { userKey: TARGET.key },
    method: "PUT",
    apiRoot: "/rest/api/2",
    path: "/user/password?key=private-target",
    confirmed: false,
    receipt: {
      actorUserKey: PRIVATE_ACCOUNT_ACTOR.key,
      userKey: TARGET.key,
      username: TARGET.name,
    },
  },
  {
    name: "jira.login",
    args: COMMON,
    action: "login",
    fields: {},
    method: "POST",
    apiRoot: "/rest/auth/1",
    path: "/session",
    confirmed: true,
    receipt: { ...SELF_RECEIPT, sessionEstablished: true },
  },
  {
    name: "jira.logout",
    args: COMMON,
    action: "logout",
    fields: {},
    method: "DELETE",
    apiRoot: "/rest/auth/1",
    path: "/session",
    confirmed: false,
    receipt: SELF_RECEIPT,
  },
  {
    name: "jira.release-websudo",
    args: COMMON,
    action: "release-websudo",
    fields: {},
    method: "DELETE",
    apiRoot: "/rest/auth/1",
    path: "/websudo",
    confirmed: false,
    receipt: SELF_RECEIPT,
  },
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
  {
    name: "jira.validate-create-user-password",
    args: {
      ...COMMON,
      username: "candidate",
      displayName: "Candidate",
      emailAddress: "candidate@example.invalid",
    },
    purpose: "validate-create-user-password",
    fields: {
      username: "candidate",
      displayName: "Candidate",
      emailAddress: "candidate@example.invalid",
    },
    path: "/password/policy/createUser",
    scope: "native-password-policy-only",
  },
  {
    name: "jira.validate-update-user-password",
    args: { ...COMMON, user: TARGET },
    purpose: "validate-update-user-password",
    fields: { username: TARGET.name },
    path: "/password/policy/updateUser",
    scope: "native-password-policy-only",
  },
  {
    name: "jira.validate-license",
    args: COMMON,
    purpose: "validate-license",
    fields: {},
    path: "/licenseValidator",
    scope: "native-license-validation-only",
  },
] as const satisfies readonly PrivateReadCase[];

interface PrivateAccountControls {
  denyReadback: boolean;
  throwReadback: boolean;
  wrongReadback: boolean;
  shadowUser: boolean;
  staleActorBeforeDispatch: boolean;
  wrongSessionIdentity: boolean;
  missingSessionProof: boolean;
}
interface PrivateAccountState {
  readonly actor: Record<string, unknown>;
  readonly target: Record<string, unknown>;
  readonly reads: string[];
  readonly calls: { action: string; fields: CatalogJsonObject; expectedActorKey?: string }[];
  readonly controls: PrivateAccountControls;
  readonly validation: Record<string, unknown>;
  privateCalls: number;
  outcome: AtlassianWriteHttpOutcome | undefined;
}
export interface PrivateAccountFixture {
  readonly actor: Record<string, unknown>;
  readonly target: Record<string, unknown>;
  readonly reads: string[];
  readonly calls: PrivateAccountState["calls"];
  readonly controls: PrivateAccountControls;
  readonly validation: Record<string, unknown>;
  readonly request: JiraMutationRequest;
  readonly ports: JiraPrivateIdentityPorts;
  setOutcome(value: AtlassianWriteHttpOutcome): void;
  snapshot(): {
    privateCalls: number;
    actor: Record<string, unknown>;
    target: Record<string, unknown>;
  };
}
function privateReadbackFailure(state: PrivateAccountState): AtlassianWriteHttpOutcome | undefined {
  if (state.privateCalls > 0 && state.controls.throwReadback)
    throw new TypeError("Synthetic private-account readback defect");
  if (state.privateCalls > 0 && state.controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  return undefined;
}
function privateAccountRead(state: PrivateAccountState, path: string): AtlassianWriteHttpOutcome {
  const { actor, controls } = state;
  state.reads.push(path);
  const failure = privateReadbackFailure(state);
  if (failure !== undefined) return failure;
  if (path === "myself") {
    const changed = controls.staleActorBeforeDispatch && state.reads.length > 1;
    return {
      ok: true,
      status: 200,
      body: { ...actor, ...(changed ? { key: "changed-actor" } : {}) },
    };
  }
  const url = new URL(path, "https://fixture.invalid/");
  assert.equal(url.pathname, "/user");
  const selected =
    url.searchParams.get("key") === actor.key || url.searchParams.get("username") === actor.name
      ? actor
      : state.target;
  return {
    ok: true,
    status: 200,
    body: { ...selected, ...(controls.shadowUser ? { key: "shadow-key" } : {}) },
  };
}
function privateLoginOutcome(state: PrivateAccountState): AtlassianWriteHttpOutcome {
  const { actor, controls } = state;
  return {
    ok: true,
    status: 200,
    body: controls.missingSessionProof
      ? {}
      : {
          sessionEstablished: true,
          userKey: controls.wrongSessionIdentity ? "different-user" : actor.key,
          username: actor.name,
        },
  };
}
function privateAccountPerform(
  state: PrivateAccountState,
  purpose: JiraHumanInputPurpose,
  fields: CatalogJsonObject,
): AtlassianWriteHttpOutcome {
  state.calls.push({ action: purpose, fields: structuredClone(fields) });
  state.privateCalls += 1;
  if (purpose === "update-myself" && !state.controls.wrongReadback)
    state.actor.displayName = fields.displayName;
  if (state.outcome !== undefined) return state.outcome;
  if (purpose.startsWith("validate-"))
    return { ok: true, status: 200, body: { ...state.validation } };
  if (purpose === "login") return privateLoginOutcome(state);
  return { ok: true, status: 204, body: undefined };
}
function privateAccountSession(
  state: PrivateAccountState,
  action: string,
  expectedActorKey: string,
): AtlassianWriteHttpOutcome {
  state.calls.push({ action, fields: {}, expectedActorKey });
  state.privateCalls += 1;
  assert.equal(expectedActorKey, PRIVATE_ACCOUNT_ACTOR.key);
  return state.outcome ?? { ok: true, status: 204, body: undefined };
}
function privateAccountState(): PrivateAccountState {
  return {
    actor: { ...PRIVATE_ACCOUNT_ACTOR },
    target: { ...TARGET, displayName: "Reviewed target", active: true },
    reads: [],
    calls: [],
    controls: {
      denyReadback: false,
      throwReadback: false,
      wrongReadback: false,
      shadowUser: false,
      staleActorBeforeDispatch: false,
      wrongSessionIdentity: false,
      missingSessionProof: false,
    },
    validation: { accepted: true, violationCount: 0 },
    privateCalls: 0,
    outcome: undefined,
  };
}
/** Independent public-state fixture. The private port is a custody boundary, not a fake secret
 * source: this fixture neither stores credentials nor reconstructs secret HTTP bodies. */
export function privateAccountFixture(): PrivateAccountFixture {
  const state = privateAccountState();
  const request: JiraMutationRequest = (path, method = "GET") =>
    settleSync(() => {
      assert.equal(method, "GET");
      return privateAccountRead(state, path);
    });
  const ports: JiraPrivateIdentityPorts = {
    perform: (purpose, fields) => settleSync(() => privateAccountPerform(state, purpose, fields)),
    unlock: () =>
      settleSync(() => {
        throw new TypeError("Unlock has its separate task/attestation fixture");
      }),
    session: (action, expectedActorKey) =>
      settleSync(() => privateAccountSession(state, action, expectedActorKey)),
  };
  return {
    actor: state.actor,
    target: state.target,
    reads: state.reads,
    calls: state.calls,
    controls: state.controls,
    validation: state.validation,
    request,
    ports,
    setOutcome(value: AtlassianWriteHttpOutcome): void {
      state.outcome = value;
    },
    snapshot: () => ({
      privateCalls: state.privateCalls,
      actor: structuredClone(state.actor),
      target: structuredClone(state.target),
    }),
  };
}
