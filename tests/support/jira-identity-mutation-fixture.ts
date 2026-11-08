import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
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

/** Synthetic native identity state, deliberately independent from the production plans. */
export function identityMutationFixture(selected: IdentityCase) {
  const actor = { key: ACTOR, name: "operator" };
  const user: Record<string, unknown> = { ...IDENTITY_USER_REVIEW };
  const owner: Record<string, unknown> = { ...OWNER, displayName: "New owner", active: true };
  const created: Record<string, unknown> = {
    key: "created-key",
    name: "new-user",
    displayName: "New user",
    active: true,
  };
  const validation: Record<string, unknown> = {
    userKey: "target-user",
    userName: "Target User",
    deleted: false,
    success: true,
    businessLogicValidationFailed: false,
    operations: [...IDENTITY_OPERATIONS],
    errors: {},
    warnings: {},
  };
  const calls: { path: string; method: string; body: unknown; expect: unknown }[] = [];
  const controls = {
    lostAck: false,
    missingAckIdentity: false,
    wrongUser: false,
    denyReadback: false,
    throwReadback: false,
    staleUser: false,
    refused: false,
    shadowDeletedUser: false,
    wrongReadback: false,
  };
  let effects = 0;
  let deleted = false;
  let sessionInvalidated = false;
  let scheduled = false;
  const ok = (body: Record<string, unknown>): AtlassianWriteHttpOutcome => ({
    ok: true,
    status: 200,
    body: structuredClone(body),
  });
  function read(path: string): AtlassianWriteHttpOutcome {
    if (effects > 0 && controls.throwReadback)
      throw new TypeError("Synthetic identity readback fault");
    if (effects > 0 && controls.denyReadback)
      return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (path === "myself") return ok(actor);
    const url = new URL(path, "https://fixture.invalid/");
    if (url.pathname.startsWith("/user/anonymization")) {
      assert.equal(url.searchParams.get("userKey"), "target-user");
      if (url.pathname.endsWith("/rerun")) {
        assert.equal(url.searchParams.get("oldUserKey"), "before-key");
        assert.equal(url.searchParams.get("oldUserName"), "Before User");
      }
      return ok(validation);
    }
    assert.equal(url.pathname, "/user");
    const key = url.searchParams.get("key");
    const name = url.searchParams.get("username");
    if (key === owner.key || name === owner.name) return ok(owner);
    if (key === created.key || name === created.name) return ok(created);
    assert.ok(key === IDENTITY_USER_REVIEW.key || name === IDENTITY_USER_REVIEW.name);
    if (deleted && !controls.shadowDeletedUser)
      return { ok: false, reason: "not-found", httpStatus: 404 };
    return ok({
      ...user,
      ...(controls.wrongUser || (deleted && controls.shadowDeletedUser)
        ? { key: "shadow-key" }
        : {}),
      ...(controls.staleUser ? { displayName: "Concurrent user" } : {}),
    });
  }
  function apply(body: Parameters<JiraMutationRequest>[2]): void {
    if (selected.name === "jira.delete-user") deleted = true;
    if (selected.name === "jira.invalidate-user-session") sessionInvalidated = true;
    if (
      selected.name === "jira.schedule-user-anonymization" ||
      selected.name === "jira.rerun-user-anonymization"
    )
      scheduled = true;
    if (selected.name === "jira.update-user" && !controls.wrongReadback) Object.assign(user, body);
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect = "json") => {
    calls.push({ path, method, body: structuredClone(body), expect });
    if (method === "GET") return read(path);
    assert.equal(path, selected.path);
    assert.equal(method, selected.method);
    assert.deepEqual(body, selected.body);
    assert.equal(expect, selected.name === "jira.create-user" ? "json" : "none");
    if (controls.refused) return { ok: false, reason: "permission-denied", httpStatus: 403 };
    assert.equal(++effects, 1);
    apply(body);
    if (controls.lostAck) return { ok: false, reason: "timeout" };
    if (selected.name === "jira.create-user")
      return {
        ok: true,
        status: 201,
        body: controls.missingAckIdentity ? {} : { key: created.key, name: created.name },
      };
    return { ok: true, status: scheduled ? 202 : 204, body: undefined };
  };
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
    actor,
    user,
    owner,
    validation,
    created,
    calls,
    controls,
    snapshot: () => ({
      effects,
      user: structuredClone(user),
      deleted,
      sessionInvalidated,
      scheduled,
    }),
  };
}
