import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraAvatarMutation } from "./jira-managed-avatar-mutations.js";
import type { JiraAvatarMutation, JiraAvatarPorts, JiraAvatarSession, JiraAvatarTarget, JiraAvatarTemporarySnapshot } from "./jira-avatar-mutation-values.js";
import { AVATAR_MUTATION_FIXTURE_CASES, avatarFixtureRows } from "../../../tests/support/jira-avatar-mutation-fixture.js";

const ACTOR = "synthetic-actor";
const TARGET = { kind: "project", id: "100", key: "SYN" } as const;
const ROWS = [{ id: "41", category: "system", selected: true }, { id: "42", category: "custom", owner: "100", selected: false }];
const CROP = { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 32 };
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const FILE = { name: "avatar.png", sizeBytes: BYTES.byteLength, sha256: createHash("sha256").update(BYTES).digest("hex") };
const TEMP = { uploadSha256: FILE.sha256, uploadBytes: FILE.sizeBytes, crop: CROP, needsCropping: false };
function args(target: JiraAvatarTarget = TARGET): CatalogJsonObject {
  return { expectedActorKey: ACTOR, target: { ...target }, avatarId: "42", expectedAvatars: ROWS.map((row) => ({ ...row })) };
}
function uploadArgs(target: JiraAvatarTarget = TARGET): CatalogJsonObject {
  return { expectedActorKey: ACTOR, target: { ...target }, source: { kind: "connected-file", path: "images/avatar.png" }, expectedFile: { ...FILE }, acceptTemporaryReplacement: true };
}
function createArgs(target: JiraAvatarTarget = TARGET): CatalogJsonObject {
  return { expectedActorKey: ACTOR, target: { ...target }, expectedTemporary: { ...TEMP, crop: { ...CROP } }, crop: { ...CROP }, expectedAvatars: ROWS.map((row) => ({ ...row })) };
}
function harness(target: JiraAvatarTarget = TARGET) {
  const state = { rows: avatarFixtureRows(target).map((row) => ({ ...row })), effect: undefined as AtlassianWriteHttpOutcome | undefined, writes: 0,
    temporary: undefined as JiraAvatarTemporarySnapshot | undefined, readbackFailure: false, throwAfterAck: false };
  const request = vi.fn<JiraMutationRequest>(async (path, method = "GET", body) => {
    if (method !== "GET") {
      state.writes++;
      if (method === "PUT") state.rows = state.rows.map((row) => ({ ...row, selected: row.id === "42" }));
      if (method === "DELETE") state.rows = state.rows.filter((row) => row.id !== "42");
      return state.effect ?? { ok: true, status: method === "POST" ? 201 : 204, body: method === "POST" ? { id: "43", owner: "100", selected: false } : undefined };
    }
    if (state.writes > 0 && state.throwAfterAck) throw new TypeError("synthetic readback defect");
    if (state.writes > 0 && state.readbackFailure) return { ok: false, reason: "permission-denied" };
    if (path === "myself") return { ok: true, status: 200, body: { key: ACTOR, name: "synthetic-user" } };
    if (path === "project/100") return { ok: true, status: 200, body: { id: "100", key: "SYN", name: "Synthetic" } };
    if (path === "issuetype/7") return { ok: true, status: 200, body: { id: "7", name: "Story", description: null, subtask: false, avatarId: "41" } };
    if (target.kind === "user" && (path === `user?username=${target.name}` || path === `user?key=${target.key}`))
      return { ok: true, status: 200, body: { key: target.key, name: target.name } };
    if (path === "project/100/avatars" || path === "universal_avatar/type/issuetype/owner/7" || path === "user/avatars?username=target-user") return { ok: true, status: 200, body: {
      system: state.rows.filter((row) => row.category === "system"), custom: state.rows.filter((row) => row.category === "custom"),
    } };
    throw new TypeError(`Unexpected synthetic route: ${method} ${path} ${String(body)}`);
  });
  const upload = vi.fn<JiraAvatarSession["upload"]>(async () => {
    expect(state.temporary).toBeUndefined();
    state.writes++;
    return state.effect ?? { ok: true, status: 201, body: { ...CROP, needsCropping: false, url: "https://invalid.example/never-follow" } };
  });
  const session: JiraAvatarSession = { request, upload, temporary: () => state.temporary, rememberTemporary: (value) => { state.temporary = value; } };
  const source = vi.fn<NonNullable<JiraAvatarPorts["source"]>>().mockResolvedValue({ ok: true, content: { name: FILE.name, bytes: BYTES, sha256: FILE.sha256 } });
  const inspectImage = vi.fn<NonNullable<JiraAvatarPorts["inspectImage"]>>().mockResolvedValue({ ok: true, value: { mimeType: "image/png" } });
  const withSession = vi.fn<NonNullable<JiraAvatarPorts["withSession"]>>(async (_actor, execute) => execute(session));
  const ports: JiraAvatarPorts = { request, source, inspectImage, withSession, legacyTemporaryRelease: "10.4" };
  return { state, request, upload, source, inspectImage, withSession, ports, session };
}
describe("fixed avatar selection and deletion", () => {
  it("confirms only independently observed same-parent selection metadata", async () => {
    const h = harness();
    expect(await executeJiraAvatarMutation("jira.set-project-avatar", args(), h.ports)).toEqual({ ok: true, receipt: {
      actorUserKey: ACTOR, avatarType: "project", projectId: "100", projectKey: "SYN", avatarId: "42", avatarSelected: true,
    } });
    expect(h.request).toHaveBeenCalledWith("project/100/avatar", "PUT", { id: "42" }, "none");
    expect(h.state.writes).toBe(1);
  });
  it("keeps deletion acknowledged but unconfirmed, including complete same-parent absence", async () => {
    const h = harness();
    expect(await executeJiraAvatarMutation("jira.delete-project-avatar", args(), h.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: { avatarId: "42", avatarPresent: false } });
    expect(h.state.writes).toBe(1);
  });
  it("admits exact observed selection no-op without dispatch", async () => {
    const h = harness();
    expect(await executeJiraAvatarMutation("jira.set-project-avatar", { ...args(), avatarId: "41" }, h.ports)).toMatchObject({ ok: false, detail: { unchanged: true } });
    expect(h.state.writes).toBe(0);
  });
  it.each([null, "false", undefined])("never invents a selected flag from %s", async (selected) => {
    const h = harness();
    const malformed = { ...args(), expectedAvatars: [{ id: "42", category: "custom", owner: "100", ...(selected === undefined ? {} : { selected }) }] };
    expect(await executeJiraAvatarMutation("jira.set-project-avatar", malformed, h.ports)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(h.request).not.toHaveBeenCalled();
  });
  it("refuses stale collection and cross-parent owner evidence", async () => {
    const h = harness(); h.state.rows[1] = { id: "42", category: "custom", owner: "101", selected: false };
    expect(await executeJiraAvatarMutation("jira.set-project-avatar", args(), h.ports)).toMatchObject({ ok: false, reason: "malformed-payload" });
    expect(h.state.writes).toBe(0);
  });
  it("retains known IDs after ACK and unreadable readback without replay", async () => {
    const h = harness(); h.state.readbackFailure = true;
    expect(await executeJiraAvatarMutation("jira.set-project-avatar", args(), h.ports)).toMatchObject({ ok: false, reason: "permission-denied", receipt: { avatarId: "42" } });
    expect(h.state.writes).toBe(1);
  });
  it("preserves an acknowledged receipt through a programming defect", async () => {
    const h = harness(); h.state.throwAfterAck = true;
    await expect(executeJiraAvatarMutation("jira.set-project-avatar", args(), h.ports)).rejects.toMatchObject({ receipt: { avatarId: "42" } });
    expect(h.state.writes).toBe(1);
  });
});
describe("independent fifteen-operation avatar source matrix", () => {
  it.each(AVATAR_MUTATION_FIXTURE_CASES)("binds $name to its native effect or fixed upload port exactly once", async (item) => {
    const h = harness(item.target);
    h.state.temporary = { actorKey: ACTOR, target: item.target, ...TEMP };
    const result = await executeJiraAvatarMutation(item.name, item.args, h.ports);
    expect(h.state.writes).toBe(1);
    if ("confirmed" in item) expect(result).toMatchObject({ ok: true, receipt: { avatarSelected: true } });
    else expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    if ("upload" in item) {
      expect(h.upload).toHaveBeenCalledWith(item.name, item.target, FILE, "image/png", BYTES);
      expect(h.request.mock.calls.every((call) => (call[1] ?? "GET") === "GET")).toBe(true);
    } else {
      const effects = h.request.mock.calls.filter((call) => (call[1] ?? "GET") !== "GET");
      expect(effects).toHaveLength(1);
      expect(effects[0]?.slice(0, 2)).toEqual([item.path, item.method]);
    }
  });
});
describe("session-owned temporary avatars", () => {
  it("requires the real private session port before any native request", async () => {
    const h = harness();
    expect(await executeJiraAvatarMutation("jira.upload-project-avatar", uploadArgs(), { ...h.ports, withSession: undefined })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(h.request).not.toHaveBeenCalled(); expect(h.upload).not.toHaveBeenCalled();
  });
  it("requires admitted actual bytes, and does not treat expectedFile as source authority", async () => {
    const h = harness(); h.source.mockResolvedValue({ ok: false, reason: "effect-denied" });
    expect(await executeJiraAvatarMutation("jira.upload-project-avatar", uploadArgs(), h.ports)).toMatchObject({ ok: false, reason: "effect-denied" });
    expect(h.upload).not.toHaveBeenCalled();
  });
  it("check-only previews do not replace the existing temporary slot", async () => {
    const h = harness(); const prior = Object.freeze({ actorKey: ACTOR, target: TARGET, ...TEMP }); h.state.temporary = prior;
    expect(await executeJiraAvatarMutation("jira.upload-project-avatar", uploadArgs(), h.ports, true)).toMatchObject({ ok: true });
    expect(h.state.temporary).toBe(prior); expect(h.upload).not.toHaveBeenCalled();
  });
  it("records only bounded crop metadata after upload, and never confirms image assignment", async () => {
    const h = harness();
    const result = await executeJiraAvatarMutation("jira.upload-project-avatar", uploadArgs(), h.ports);
    expect(result).toMatchObject({ ok: false, reason: "unavailable", receipt: { uploadSha256: FILE.sha256, temporaryNeedsCropping: false, temporaryCrop: CROP } });
    expect(JSON.stringify(result)).not.toContain("never-follow");
    expect(h.state.temporary).toEqual({ actorKey: ACTOR, target: TARGET, ...TEMP });
    expect(h.upload).toHaveBeenCalledTimes(1);
  });
  it("invalidates a previous temporary slot before a lost upload acknowledgement", async () => {
    const h = harness(); h.state.temporary = { actorKey: ACTOR, target: TARGET, ...TEMP };
    h.state.effect = { ok: false, reason: "network-error" };
    expect(await executeJiraAvatarMutation("jira.upload-project-avatar", uploadArgs(), h.ports)).toMatchObject({ ok: false, reason: "network-error" });
    expect(h.state.temporary).toBeUndefined(); expect(h.upload).toHaveBeenCalledTimes(1);
  });
  it.each(["actor", "target", "digest", "bytes", "crop"])("refuses a stale private temporary %s binding", async (kind) => {
    const h = harness();
    h.state.temporary = { actorKey: kind === "actor" ? "other" : ACTOR, target: kind === "target" ? { ...TARGET, id: "101" } : TARGET,
      uploadSha256: kind === "digest" ? "f".repeat(64) : TEMP.uploadSha256, uploadBytes: kind === "bytes" ? 99 : TEMP.uploadBytes,
      crop: kind === "crop" ? { ...CROP, cropperWidth: 31 } : CROP, needsCropping: false };
    expect(await executeJiraAvatarMutation("jira.create-project-avatar", createArgs(), h.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(h.state.writes).toBe(0);
  });
  it("consumes the temp slot once and retains the observed new resource ID without claiming selection", async () => {
    const h = harness(); h.state.temporary = { actorKey: ACTOR, target: TARGET, ...TEMP };
    expect(await executeJiraAvatarMutation("jira.create-project-avatar", createArgs(), h.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: { avatarId: "43", avatarPresent: true } });
    expect(h.state.temporary).toBeUndefined(); expect(h.state.writes).toBe(1);
    expect(await executeJiraAvatarMutation("jira.create-project-avatar", createArgs(), h.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(h.state.writes).toBe(1);
  });
  it("does not silently claim legacy generic avatar endpoints on11.3", async () => {
    const h = harness();
    expect(await executeJiraAvatarMutation("jira.upload-temporary-avatar", uploadArgs({ kind: "session", avatarType: "user" }), { ...h.ports, legacyTemporaryRelease: undefined })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(h.withSession).not.toHaveBeenCalled();
  });
  it.each(["jira.upload-project-avatar", "jira.create-project-avatar"] satisfies readonly JiraAvatarMutation[])("keeps malformed source/target inputs before effects: %s", async (operation) => {
    const h = harness();
    expect(await executeJiraAvatarMutation(operation, { ...uploadArgs(), url: "https://invalid.example/image" }, h.ports)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(h.request).not.toHaveBeenCalled();
  });
});
