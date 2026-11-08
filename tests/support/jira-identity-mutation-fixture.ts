import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { settleSync } from "./jira-fixture-settle.js";
import type {
  JiraIdentityMutation,
  JiraIdentityPorts,
  JiraIdentityReceipt,
} from "../../packages/keiko-connectors/src/jira-identity-mutation-values.js";

export const IDENTITY_USER_REVIEW = {
  key: "target-user",
  name: "Target User",
  displayName: "Reviewed user",
  active: true,
} as const;
export const IDENTITY_OPERATIONS = ["USER_DISABLE", "USER_KEY_CHANGE", "USER_NAME_CHANGE"] as const;
const USER = { key: IDENTITY_USER_REVIEW.key, name: IDENTITY_USER_REVIEW.name };
const OWNER = { key: "owner-key", name: "Owner User" };
const ACTOR = "synthetic-actor";
const COMMON = { expectedActorKey: ACTOR };
const ANON = {
  ...COMMON,
  user: USER,
  newOwner: OWNER,
  expectedOperations: IDENTITY_OPERATIONS,
  confirmIrreversibleAnonymization: true,
} as const;
interface IdentityCase {
  readonly name: JiraIdentityMutation;
  readonly args: CatalogJsonObject;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body: CatalogJsonObject | undefined;
  readonly confirmed: boolean;
  readonly receipt: JiraIdentityReceipt;
}
export const IDENTITY_MUTATION_FIXTURE_CASES = [
  {
    name: "jira.create-user",
    args: {
      ...COMMON,
      name: "new-user",
      emailAddress: "new@example.invalid",
      displayName: "New user",
      acceptGeneratedPassword: true,
      acceptUnverifiedAccess: true,
    },
    method: "POST",
    path: "user",
    body: { name: "new-user", emailAddress: "new@example.invalid", displayName: "New user" },
    confirmed: false,
    receipt: {
      actorUserKey: ACTOR,
      userKey: "created-key",
      username: "new-user",
      userPresent: true,
    },
  },
  {
    name: "jira.update-user",
    args: { ...COMMON, expectedUser: IDENTITY_USER_REVIEW, displayName: "Updated user" },
    method: "PUT",
    path: "user?key=target-user",
    body: { displayName: "Updated user" },
    confirmed: true,
    receipt: {
      actorUserKey: ACTOR,
      userKey: "target-user",
      username: "Target User",
      userPresent: true,
    },
  },
  {
    name: "jira.delete-user",
    args: { ...COMMON, expectedUser: IDENTITY_USER_REVIEW, confirmIrreversibleDeletion: true },
    method: "DELETE",
    path: "user?key=target-user",
    body: undefined,
    confirmed: false,
    receipt: {
      actorUserKey: ACTOR,
      userKey: "target-user",
      username: "Target User",
      userPresent: false,
    },
  },
  {
    name: "jira.invalidate-user-session",
    args: { ...COMMON, user: USER, confirmSessionInvalidation: true },
    method: "DELETE",
    path: "user/session/Target%20User",
    body: undefined,
    confirmed: false,
    receipt: {
      actorUserKey: ACTOR,
      userKey: "target-user",
      username: "Target User",
      userSessionInvalidationRequested: true,
    },
  },
  {
    name: "jira.schedule-user-anonymization",
    args: ANON,
    method: "POST",
    path: "user/anonymization",
    body: { userKey: "target-user", newOwnerKey: "owner-key" },
    confirmed: false,
    receipt: {
      actorUserKey: ACTOR,
      userKey: "target-user",
      username: "Target User",
      newOwnerUserKey: "owner-key",
      anonymizationRequested: true,
    },
  },
  {
    name: "jira.rerun-user-anonymization",
    args: { ...ANON, oldUserKey: "before-key", oldUserName: "Before User" },
    method: "POST",
    path: "user/anonymization/rerun",
    body: {
      userKey: "target-user",
      newOwnerKey: "owner-key",
      oldUserKey: "before-key",
      oldUserName: "Before User",
    },
    confirmed: false,
    receipt: {
      actorUserKey: ACTOR,
      userKey: "target-user",
      username: "Target User",
      newOwnerUserKey: "owner-key",
      anonymizationRequested: true,
      anonymizationRerunRequested: true,
    },
  },
] as const satisfies readonly IdentityCase[];

interface IdentityControls {
  lostAck: boolean;
  missingAckIdentity: boolean;
  wrongUser: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  staleUser: boolean;
  refused: boolean;
  shadowDeletedUser: boolean;
  wrongReadback: boolean;
}
interface IdentityState {
  readonly selected: IdentityCase;
  readonly actor: { key: string; name: string };
  readonly user: Record<string, unknown>;
  readonly owner: Record<string, unknown>;
  readonly created: Record<string, unknown>;
  readonly validation: Record<string, unknown>;
  readonly calls: { path: string; method: string; body: unknown; expect: unknown }[];
  readonly controls: IdentityControls;
  effects: number;
  deleted: boolean;
  sessionInvalidated: boolean;
  scheduled: boolean;
}
export interface IdentityMutationFixture {
  readonly request: JiraMutationRequest;
  readonly ports: JiraIdentityPorts;
  readonly actor: IdentityState["actor"];
  readonly user: Record<string, unknown>;
  readonly owner: Record<string, unknown>;
  readonly validation: Record<string, unknown>;
  readonly created: Record<string, unknown>;
  readonly calls: IdentityState["calls"];
  readonly controls: IdentityControls;
  snapshot(): {
    effects: number;
    user: Record<string, unknown>;
    deleted: boolean;
    sessionInvalidated: boolean;
    scheduled: boolean;
  };
}

function identityOk(body: Record<string, unknown>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: structuredClone(body) };
}

function identityAnonymizationRead(state: IdentityState, url: URL): AtlassianWriteHttpOutcome {
  assert.equal(url.searchParams.get("userKey"), "target-user");
  if (url.pathname.endsWith("/rerun")) {
    assert.equal(url.searchParams.get("oldUserKey"), "before-key");
    assert.equal(url.searchParams.get("oldUserName"), "Before User");
  }
  return identityOk(state.validation);
}

function identityDirectoryUser(
  state: IdentityState,
  key: string | null,
  name: string | null,
): AtlassianWriteHttpOutcome | undefined {
  const { owner, created } = state;
  if (key === owner.key || name === owner.name) return identityOk(owner);
  if (key === created.key || name === created.name) return identityOk(created);
  return undefined;
}

function identityReviewedUser(state: IdentityState): AtlassianWriteHttpOutcome {
  const { controls, user } = state;
  if (state.deleted && !controls.shadowDeletedUser)
    return { ok: false, reason: "not-found", httpStatus: 404 };
  return identityOk({
    ...user,
    ...(controls.wrongUser || (state.deleted && controls.shadowDeletedUser)
      ? { key: "shadow-key" }
      : {}),
    ...(controls.staleUser ? { displayName: "Concurrent user" } : {}),
  });
}

function identityUserRead(state: IdentityState, url: URL): AtlassianWriteHttpOutcome {
  assert.equal(url.pathname, "/user");
  const key = url.searchParams.get("key");
  const name = url.searchParams.get("username");
  const known = identityDirectoryUser(state, key, name);
  if (known !== undefined) return known;
  assert.ok(key === IDENTITY_USER_REVIEW.key || name === IDENTITY_USER_REVIEW.name);
  return identityReviewedUser(state);
}

function identityReadbackFault(state: IdentityState): AtlassianWriteHttpOutcome | undefined {
  if (state.effects === 0) return undefined;
  if (state.controls.throwReadback) throw new TypeError("Synthetic identity readback fault");
  if (state.controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  return undefined;
}

function identityRead(state: IdentityState, path: string): AtlassianWriteHttpOutcome {
  const fault = identityReadbackFault(state);
  if (fault !== undefined) return fault;
  if (path === "myself") return identityOk(state.actor);
  const url = new URL(path, "https://fixture.invalid/");
  return url.pathname.startsWith("/user/anonymization")
    ? identityAnonymizationRead(state, url)
    : identityUserRead(state, url);
}

function applyIdentityEffect(state: IdentityState, body: Parameters<JiraMutationRequest>[2]): void {
  const { name } = state.selected;
  if (name === "jira.delete-user") state.deleted = true;
  if (name === "jira.invalidate-user-session") state.sessionInvalidated = true;
  if (name === "jira.schedule-user-anonymization" || name === "jira.rerun-user-anonymization")
    state.scheduled = true;
  if (name === "jira.update-user" && !state.controls.wrongReadback) Object.assign(state.user, body);
}

function identityEffect(
  state: IdentityState,
  path: string,
  method: string,
  body: Parameters<JiraMutationRequest>[2],
  expect: unknown,
): AtlassianWriteHttpOutcome {
  const { selected, controls, created } = state;
  assert.equal(path, selected.path);
  assert.equal(method, selected.method);
  assert.deepEqual(body, selected.body);
  assert.equal(expect, selected.name === "jira.create-user" ? "json" : "none");
  if (controls.refused) return { ok: false, reason: "permission-denied", httpStatus: 403 };
  assert.equal(++state.effects, 1);
  applyIdentityEffect(state, body);
  if (controls.lostAck) return { ok: false, reason: "timeout" };
  if (selected.name === "jira.create-user")
    return {
      ok: true,
      status: 201,
      body: controls.missingAckIdentity ? {} : { key: created.key, name: created.name },
    };
  return { ok: true, status: state.scheduled ? 202 : 204, body: undefined };
}

function identityState(selected: IdentityCase): IdentityState {
  return {
    selected,
    actor: { key: ACTOR, name: "operator" },
    user: { ...IDENTITY_USER_REVIEW },
    owner: { ...OWNER, displayName: "New owner", active: true },
    created: { key: "created-key", name: "new-user", displayName: "New user", active: true },
    validation: {
      userKey: "target-user",
      userName: "Target User",
      deleted: false,
      success: true,
      businessLogicValidationFailed: false,
      operations: [...IDENTITY_OPERATIONS],
      errors: {},
      warnings: {},
    },
    calls: [],
    controls: {
      lostAck: false,
      missingAckIdentity: false,
      wrongUser: false,
      denyReadback: false,
      throwReadback: false,
      staleUser: false,
      refused: false,
      shadowDeletedUser: false,
      wrongReadback: false,
    },
    effects: 0,
    deleted: false,
    sessionInvalidated: false,
    scheduled: false,
  };
}

/** Synthetic native identity state, deliberately independent from the production plans. */
export function identityMutationFixture(selected: IdentityCase): IdentityMutationFixture {
  const state = identityState(selected);
  const request: JiraMutationRequest = (path, method = "GET", body, expect = "json") =>
    settleSync(() => {
      state.calls.push({ path, method, body: structuredClone(body), expect });
      return method === "GET"
        ? identityRead(state, path)
        : identityEffect(state, path, method, body, expect);
    });
  const ports: JiraIdentityPorts = {
    user: (method, key, body) =>
      request(
        key === undefined ? "user" : `user?${new URLSearchParams({ key }).toString()}`,
        method,
        body,
        method === "POST" ? "json" : "none",
      ),
  };
  return {
    request,
    ports,
    actor: state.actor,
    user: state.user,
    owner: state.owner,
    validation: state.validation,
    created: state.created,
    calls: state.calls,
    controls: state.controls,
    snapshot: () => ({
      effects: state.effects,
      user: structuredClone(state.user),
      deleted: state.deleted,
      sessionInvalidated: state.sessionInvalidated,
      scheduled: state.scheduled,
    }),
  };
}
