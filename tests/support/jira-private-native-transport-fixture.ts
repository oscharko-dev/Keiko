import { expect } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "@oscharko-dev/keiko-connectors";
import { identityMutationFixture, IDENTITY_MUTATION_FIXTURE_CASES } from "./jira-identity-mutation-fixture.js";
import { privateAccountFixture, PRIVATE_ACCOUNT_WRITE_CASES, PRIVATE_ACCOUNT_READ_CASES } from "./jira-private-account-fixture.js";
import { anonymizationUnlockFixture } from "./jira-anonymization-unlock-fixture.js";
import { AVATAR_MUTATION_FIXTURE_CASES } from "./jira-avatar-mutation-fixture.js";
import { PRIVATE_NATIVE_ACTOR as ACTOR, PRIVATE_NATIVE_COOKIE as COOKIE, PRIVATE_NATIVE_PASSWORD as PASSWORD,
  PRIVATE_NATIVE_LICENSE as LICENSE, PRIVATE_NATIVE_IMAGE, PRIVATE_NATIVE_CROP, privateAvatarRows,
  privateNativeCase, type PrivateNativeCase } from "./jira-private-native-cases.js";

const API = "/context/rest/api/2/";
const AUTH = "/context/rest/auth/1/";
const IDENTITY_READS = new Set([
  "myself", "user?key=target-user", "user?username=Target+User", "user?key=owner-key", "user?username=Owner+User",
  "user?key=created-key", "user?username=new-user", "user/anonymization?userKey=target-user",
  "user/anonymization/rerun?userKey=target-user&oldUserKey=before-key&oldUserName=Before+User",
]);
const ACCOUNT_READS = new Set(["myself", "user?key=synthetic-key", "user?username=synthetic-user", "user?key=private-target", "user?username=target-user"]);
const AVATAR_READS = new Set(["myself", "project/100", "issuetype/7", "user?key=synthetic-target", "user?username=target-user",
  "project/100/avatars", "universal_avatar/type/issuetype/owner/7", "user/avatars?username=target-user"]);
const PRIVATE_NATIVE_PAT = ["synthetic", "private", "pat"].join("-");
const EXPERIMENTAL_USER_WRITES = new Set(["jira.create-user", "jira.update-user", "jira.delete-user"]);
function response(value: AtlassianWriteHttpOutcome): Response {
  if (!value.ok) return Response.json({}, { status: value.httpStatus ?? 503 });
  return value.status === 204 ? new Response(null, { status: 204 }) : Response.json(value.items ?? value.body ?? {}, { status: value.status });
}
function exactEffect(request: Request, selected: PrivateNativeCase): void {
  const url = new URL(request.url);
  expect(request.method).toBe(selected.method);
  expect(url.pathname + url.search).toBe(`/context${selected.apiRoot}/${selected.path.replace(/^\//u, "")}`);
}
function authentication(request: Request, session: boolean, anonymous = false): void {
  expect(request.headers.get("authorization")).toBe(session || anonymous ? null : `Bearer ${PRIVATE_NATIVE_PAT}`);
  expect(request.headers.get("cookie")).toBe(session ? `${COOKIE.name}=${COOKIE.value}` : null);
}
function emptyBody(request: Request): Promise<void> {
  return request.clone().text().then((body) => { expect(body).toBe(""); });
}
interface NativeController {
  readonly handle: (request: Request) => Promise<Response>;
  readonly snapshot: () => object;
}
function identityController(selected: PrivateNativeCase): NativeController | undefined {
  const item = IDENTITY_MUTATION_FIXTURE_CASES.find((row) => row.name === selected.tool);
  if (item === undefined) return undefined;
  const native = identityMutationFixture(item); Object.assign(native.actor, ACTOR);
  return {
    snapshot: native.snapshot,
    async handle(request) {
      authentication(request, false);
      const url = new URL(request.url); const path = url.pathname.slice(API.length) + url.search;
      if (request.method === "GET") {
        expect(url.pathname.startsWith(API)).toBe(true); expect(IDENTITY_READS.has(path)).toBe(true);
        await emptyBody(request); return response(await native.request(path, "GET", undefined, "json"));
      }
      exactEffect(request, selected);
      expect(request.headers.get("x-experimentalapi")).toBe(EXPERIMENTAL_USER_WRITES.has(selected.tool) ? "true" : null);
      expect(await request.clone().text()).toBe(item.body === undefined ? "" : JSON.stringify(item.body));
      return response(await native.request(item.path, item.method, item.body, item.name === "jira.create-user" ? "json" : "none"));
    },
  };
}
function accountNativeBody(tool: string): unknown {
  switch (tool) {
    case "jira.update-myself": return { displayName: "Changed operator", password: PASSWORD };
    case "jira.update-my-password": return { currentPassword: PASSWORD, password: PASSWORD };
    case "jira.update-user-password": return { password: PASSWORD };
    case "jira.login": return { username: ACTOR.name, password: PASSWORD };
    case "jira.validate-create-user-password": return { username: "candidate", displayName: "Candidate", emailAddress: "candidate@example.invalid", password: PASSWORD };
    case "jira.validate-update-user-password": return { username: "target-user", newPassword: PASSWORD, oldPassword: PASSWORD };
    case "jira.validate-license": return LICENSE;
    default: return undefined;
  }
}
async function assertAccountEffect(request: Request, selected: PrivateNativeCase): Promise<void> {
  exactEffect(request, selected);
  const body = accountNativeBody(selected.tool);
  expect(await request.clone().text()).toBe(body === undefined ? "" : JSON.stringify(body));
  expect(request.headers.get("x-experimentalapi")).toBe(selected.tool === "jira.update-user-password" ? "true" : null);
  expect(request.headers.get("content-type")).toBe(body === undefined ? null : "application/json");
}
function validationResponse(tool: string): Response {
  return tool === "jira.validate-license" ? Response.json({ errors: {}, licenseString: LICENSE }) : Response.json([]);
}
function accountController(selected: PrivateNativeCase): NativeController | undefined {
  const write = PRIVATE_ACCOUNT_WRITE_CASES.find((row) => row.name === selected.tool);
  const read = PRIVATE_ACCOUNT_READ_CASES.find((row) => row.name === selected.tool);
  if (write === undefined && read === undefined) return undefined;
  const native = privateAccountFixture(); Object.assign(native.actor, ACTOR);
  let effects = 0; let validations = 0; let sessionActive = true;
  async function readAccount(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await emptyBody(request);
    if (url.pathname === `${AUTH}session`) {
      expect(request.headers.has("cookie")).toBe(true); expect(url.search).toBe("");
      return Response.json({ name: ACTOR.name });
    }
    const path = url.pathname.slice(API.length) + url.search;
    expect(url.pathname.startsWith(API)).toBe(true); expect(ACCOUNT_READS.has(path)).toBe(true);
    return response(await native.request(path, "GET", undefined, "json"));
  }
  return {
    snapshot: () => read === undefined ? { effects, profileName: native.actor.displayName, sessionActive } : { validations },
    async handle(request) {
      const session = request.headers.has("cookie");
      authentication(request, session, selected.tool === "jira.login" && request.method === "POST");
      if (request.method === "GET") return readAccount(request);
      await assertAccountEffect(request, selected);
      if (read !== undefined) {
        expect(++validations).toBe(1);
        return validationResponse(selected.tool);
      }
      if (write === undefined) throw new TypeError("Missing native private-account fixture");
      expect(++effects).toBe(1);
      if (write.action === "logout" || write.action === "release-websudo") {
        expect(session).toBe(true); if (write.action === "logout") sessionActive = false;
        return new Response(null, { status: 204 });
      }
      const result = await native.ports.perform(write.action, write.fields);
      return write.action === "login" ? Response.json({ session: COOKIE }) : response(result);
    },
  };
}
function avatarRead(path: string, rows: readonly CatalogJsonObject[]): Response {
  expect(AVATAR_READS.has(path)).toBe(true);
  if (path === "myself") return Response.json(ACTOR);
  if (path === "project/100") return Response.json({ id: "100", key: "SYN", name: "Synthetic project" });
  if (path === "issuetype/7") return Response.json({ id: "7", name: "Story", description: null, subtask: false, avatarId: "41" });
  if (path.startsWith("user?")) return Response.json({ key: "synthetic-target", name: "target-user" });
  return Response.json({ system: rows.filter((row) => row.category === "system"), custom: rows.filter((row) => row.category === "custom") });
}
function avatarController(selected: PrivateNativeCase): NativeController | undefined {
  const item = AVATAR_MUTATION_FIXTURE_CASES.find((row) => row.name === selected.tool);
  if (item === undefined) return undefined;
  const target = item.target;
  let rows: readonly CatalogJsonObject[] = privateAvatarRows(selected.tool);
  let effects = 0; let rawUploadBytes = 0;
  async function write(request: Request): Promise<Response> {
    exactEffect(request, selected); expect(++effects).toBe(1);
    if ("upload" in item) {
      expect(request.headers.get("content-type")).toBe("image/png"); expect(request.headers.get("x-atlassian-token")).toBe("no-check");
      const bytes = new Uint8Array(await request.arrayBuffer()); expect(bytes).toEqual(new Uint8Array(PRIVATE_NATIVE_IMAGE));
      rawUploadBytes = bytes.byteLength; return Response.json({ ...PRIVATE_NATIVE_CROP, needsCropping: false }, { status: 201 });
    }
    if (item.method === "POST") {
      expect(await request.text()).toBe(JSON.stringify(PRIVATE_NATIVE_CROP));
      if (item.name === "jira.crop-temporary-avatar") return Response.json({ ...PRIVATE_NATIVE_CROP, needsCropping: false });
      const owner = target.kind === "user" ? target.key : target.kind === "session" ? ACTOR.key : target.id;
      const created = { id: "43", category: "custom", owner, selected: false }; rows = [...rows, created];
      return Response.json(created, { status: 201 });
    }
    if (item.method === "PUT") {
      expect(await request.text()).toBe('{"id":"42"}'); rows = rows.map((row) => ({ ...row, selected: row.id === "42" }));
    } else { await emptyBody(request); rows = rows.filter((row) => row.id !== "42"); }
    return new Response(null, { status: 204 });
  }
  return {
    snapshot: () => ({ effects, avatarIds: rows.map((row) => row.id), selectedAvatarId: rows.find((row) => row.selected)?.id, rawUploadBytes }),
    async handle(request) {
      const session = item.method === "POST";
      // The factory uses PAT only for its independent initial actor lookup; all session reads/effects use cookies.
      authentication(request, request.method === "GET" ? request.headers.has("cookie") : session);
      const url = new URL(request.url);
      if (url.pathname === `${AUTH}session` && request.method === "GET") {
        expect(request.headers.has("cookie")).toBe(true); await emptyBody(request); return Response.json({ name: ACTOR.name });
      }
      if (request.method !== "GET") return write(request);
      expect(url.pathname.startsWith(API)).toBe(true); await emptyBody(request);
      return avatarRead(url.pathname.slice(API.length) + url.search, rows);
    },
  };
}
function unlockController(selected: PrivateNativeCase): NativeController | undefined {
  if (selected.tool !== "jira.unlock-user-anonymization") return undefined;
  const native = anonymizationUnlockFixture(); Object.assign(native.actor, ACTOR);
  return {
    snapshot: () => ({ effects: native.effects.length, unlockRequested: native.effects.length === 1 }),
    async handle(request) {
      authentication(request, false); await emptyBody(request);
      if (request.method === "GET") {
        const url = new URL(request.url); const path = url.pathname.slice(API.length) + url.search;
        expect(url.pathname.startsWith(API)).toBe(true); expect(new Set(["myself", "user/anonymization/progress"]).has(path)).toBe(true);
        return response(await native.request(path, "GET", undefined, "json"));
      }
      exactEffect(request, selected); expect(request.headers.get("content-type")).toBeNull();
      return response(await native.ports.unlock(ACTOR.key));
    },
  };
}
/** Native wire emulator only. No private capability/session/source is returned from this fixture. */
export function privateNativeTransportController(tool: string | undefined): NativeController | undefined {
  const selected = privateNativeCase(tool); if (selected === undefined) return undefined;
  return identityController(selected) ?? accountController(selected) ?? avatarController(selected) ?? unlockController(selected);
}
