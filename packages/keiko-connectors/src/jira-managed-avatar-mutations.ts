import { createHash } from "node:crypto";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeNumericId } from "./jira-native-values.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import { jiraServerCompatibility } from "./jira-connection-verification.js";
import { parseJiraAvatarMutation, type AvatarInput, type AvatarCropInput, type AvatarSelectionInput, type AvatarUploadInput } from "./jira-avatar-mutation-input.js";
import { admitAvatarInput, avatarCropAcknowledgement, bindAvatarTarget, readAvatarCollection, sameAvatarRows, sameAvatarTarget } from "./jira-avatar-mutation-observations.js";
import { AVATAR_MALFORMED, avatarFailure, avatarConflict, avatarInvalid, avatarTypeOf, avatarUnavailable,
  type AvatarFailure, type AvatarObservation, type JiraAvatarAttempt, type JiraAvatarMutation, type JiraAvatarPorts,
  type JiraAvatarReceipt, type JiraAvatarReview, type JiraAvatarSession, type JiraAvatarTarget, type JiraAvatarTemporarySnapshot } from "./jira-avatar-mutation-values.js";
export { JIRA_AVATAR_MUTATIONS, isJiraAvatarMutation, type JiraAvatarMutation } from "./jira-avatar-mutation-values.js";

function targetContext(target: JiraAvatarTarget): Pick<JiraAvatarReceipt, "projectId" | "projectKey" | "issueTypeId" | "userKey"> {
  if (target.kind === "project") return { projectId: target.id, projectKey: target.key };
  if (target.kind === "issuetype") return { issueTypeId: target.id };
  return target.kind === "user" ? { userKey: target.key } : {};
}
function receipt(input: AvatarInput, avatarId?: string): JiraAvatarReceipt {
  const common: JiraAvatarReceipt = { actorUserKey: input.actor, avatarType: avatarTypeOf(input.target), ...targetContext(input.target), ...(avatarId === undefined ? {} : { avatarId }) };
  if (input.kind === "set") return { ...common, avatarSelected: true };
  if (input.kind === "delete") return { ...common, avatarPresent: false };
  const file = input.kind === "upload" ? { uploadSha256: input.expectedFile.sha256, uploadBytes: input.expectedFile.sizeBytes } : input.expectedTemporary;
  return { ...common, uploadSha256: file.uploadSha256, uploadBytes: file.uploadBytes,
    ...(input.kind === "create" ? { avatarPresent: true } : { temporaryAvatar: true }) };
}
function acknowledged(outcome: AtlassianWriteHttpOutcome): boolean {
  const status = outcome.ok ? outcome.status : outcome.httpStatus;
  return status !== undefined && status >= 200 && status < 300;
}
function unconfirmed(known: JiraAvatarReceipt): AvatarFailure {
  return avatarUnavailable("Jira acknowledged this avatar operation. Exact image contents, temporary-image persistence and any subsequent assignment are not independently confirmed. Known identities are retained; do not replay an uncertain operation. Resource presence and selected flags do not prove byte equality.", known);
}
function effectPath(operation: JiraAvatarMutation, target: JiraAvatarTarget, id?: string): string | undefined {
  if (target.kind === "session") return `avatar/${target.avatarType}/temporaryCrop`;
  if (operation === "jira.create-owned-avatar" || operation === "jira.delete-owned-avatar") {
    return target.kind === "user" ? undefined : `universal_avatar/type/${target.kind}/owner/${target.id}/avatar${id === undefined ? "" : `/${id}`}`;
  }
  if (target.kind === "project") return `project/${target.id}/avatar${id === undefined ? "" : `/${id}`}`;
  if (target.kind === "issuetype") return `issuetype/${target.id}/avatar`;
  return `user/avatar${id === undefined ? "" : `/${id}`}?${new URLSearchParams({ username: target.name })}`;
}
async function observedAfter(request: JiraMutationRequest, input: AvatarInput): Promise<AvatarObservation<readonly JiraAvatarReview[]>> {
  const actor = await readSavedActor(request, input.actor); if (!actor.ok) return avatarFailure(actor);
  const bound = await bindAvatarTarget(request, input.target); if (bound !== undefined) return bound;
  return readAvatarCollection(request, input.target);
}
async function confirmSelection(request: JiraMutationRequest, input: AvatarSelectionInput, known: JiraAvatarReceipt): Promise<JiraAvatarAttempt> {
  try {
    const current = await observedAfter(request, input); if (!current.ok) return { ...current, receipt: known };
    if (input.kind === "delete") return unconfirmed(known);
    const expected = input.expectedAvatars.map((row) => ({ ...row, selected: row.id === input.avatarId }));
    return sameAvatarRows(current.value, expected) ? { ok: true, receipt: known } : unconfirmed(known);
  } catch (error) { throw new JiraAcknowledgedMutationError(error, known); }
}
async function selectAvatar(operation: JiraAvatarMutation, input: AvatarSelectionInput, request: JiraMutationRequest, check: boolean): Promise<JiraAvatarAttempt> {
  const refused = await admitAvatarInput(request, input); if (refused !== undefined) return refused;
  const known = Object.freeze(receipt(input, input.avatarId));
  if (input.kind === "set" && input.expectedAvatars.some((row) => row.id === input.avatarId && row.selected))
    return { ok: false, reason: "conflict", receipt: known, detail: { unchanged: true, messages: ["The exact reviewed avatar is already selected for the bound native owner; no effect was dispatched."] } };
  if (check) return { ok: true, receipt: known };
  const path = effectPath(operation, input.target, input.kind === "delete" ? input.avatarId : undefined);
  if (path === undefined) return AVATAR_MALFORMED;
  const current = await admitAvatarInput(request, input); if (current !== undefined) return current;
  const response = await request(path, input.kind === "delete" ? "DELETE" : "PUT", input.kind === "set" ? { id: input.avatarId } : undefined, "none");
  if (!acknowledged(response)) return response.ok ? { ...AVATAR_MALFORMED, receipt: known } : { ...dispatchFailure(response), receipt: known };
  return confirmSelection(request, input, known);
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
async function imageBytes(ports: JiraAvatarPorts, input: AvatarUploadInput): Promise<AvatarObservation<{ readonly bytes: Uint8Array; readonly mimeType: "image/png" | "image/jpeg" }>> {
  if (ports.source === undefined || ports.inspectImage === undefined) return avatarUnavailable("The existing governed connected-file image source and image admission are unavailable. A model-supplied file digest does not grant source access.");
  const source = await ports.source({ kind: "connected-file", path: input.path, maxBytes: JIRA_ATTACHMENT_MAX_BYTES, purpose: "jira-avatar-image" });
  if (!source.ok) return source;
  if (source.content.bytes.byteLength === 0 || source.content.bytes.byteLength > JIRA_ATTACHMENT_MAX_BYTES) return { ok: false, reason: "bounds-exceeded" };
  const bytes = Uint8Array.from(source.content.bytes);
  if (source.content.name !== input.expectedFile.name || bytes.byteLength !== input.expectedFile.sizeBytes || digest(bytes) !== input.expectedFile.sha256)
    return avatarConflict("The actual connected image bytes no longer match the reviewed file name, size and SHA-256. Review the current source before uploading; nothing was sent.");
  const inspected = await ports.inspectImage(bytes);
  if (!inspected.ok) return inspected;
  const owned = Uint8Array.from(bytes);
  return digest(owned) === input.expectedFile.sha256 ? { ok: true, value: { bytes: owned, mimeType: inspected.value.mimeType } }
    : avatarConflict("Image admission changed the reviewed source bytes; no upload was sent.");
}
function snapshot(input: AvatarUploadInput, observed: NonNullable<ReturnType<typeof avatarCropAcknowledgement>>): JiraAvatarTemporarySnapshot {
  return Object.freeze({ actorKey: input.actor, target: Object.freeze({ ...input.target }), uploadSha256: input.expectedFile.sha256,
    uploadBytes: input.expectedFile.sizeBytes, crop: Object.freeze({ ...observed.crop }), needsCropping: observed.needsCropping });
}
async function uploadAvatar(operation: JiraAvatarMutation, input: AvatarUploadInput, ports: JiraAvatarPorts, session: JiraAvatarSession, check: boolean): Promise<JiraAvatarAttempt> {
  const content = await imageBytes(ports, input); if (!content.ok) return content;
  const refused = await admitAvatarInput(session.request, input); if (refused !== undefined) return refused;
  const known = Object.freeze(receipt(input)); if (check) return { ok: true, receipt: known };
  // Jira stores one temporary avatar per session. Invalidate before dispatch, including lost ACK.
  session.rememberTemporary(undefined);
  const response = await session.upload(operation, input.target, input.expectedFile, content.value.mimeType, content.value.bytes);
  if (!acknowledged(response)) return response.ok ? { ...AVATAR_MALFORMED, receipt: known } : { ...dispatchFailure(response), receipt: known };
  const observed = response.ok ? avatarCropAcknowledgement(response.body) : undefined;
  if (observed === undefined) return unconfirmed(known);
  try {
    session.rememberTemporary(snapshot(input, observed));
    return unconfirmed({ ...known, temporaryCrop: observed.crop, temporaryNeedsCropping: observed.needsCropping });
  } catch (error) { throw new JiraAcknowledgedMutationError(error, known); }
}
function sameCrop(left: JiraAvatarTemporarySnapshot["crop"], right: JiraAvatarTemporarySnapshot["crop"]): boolean {
  return left.cropperOffsetX === right.cropperOffsetX && left.cropperOffsetY === right.cropperOffsetY && left.cropperWidth === right.cropperWidth;
}
function matchesTemporary(current: JiraAvatarTemporarySnapshot | undefined, input: AvatarCropInput): boolean {
  const expected = input.expectedTemporary;
  return current !== undefined && current.actorKey === input.actor && sameAvatarTarget(current.target, input.target) &&
    current.uploadSha256 === expected.uploadSha256 && current.uploadBytes === expected.uploadBytes &&
    current.needsCropping === expected.needsCropping && sameCrop(current.crop, expected.crop);
}
async function createdAvatar(session: JiraAvatarSession, input: AvatarCropInput, response: AtlassianWriteHttpOutcome, known: JiraAvatarReceipt): Promise<JiraAvatarAttempt> {
  const id = response.ok ? jiraNativeNumericId(response.body?.id) : undefined;
  if (id === undefined) return unconfirmed(known);
  const identified = Object.freeze({ ...known, avatarId: id });
  if (input.expectedAvatars.some((row) => row.id === id)) return unconfirmed(identified);
  try {
    const current = await observedAfter(session.request, input);
    return current.ok ? unconfirmed(identified) : { ...current, receipt: identified };
  } catch (error) { throw new JiraAcknowledgedMutationError(error, identified); }
}
async function cropAvatar(operation: JiraAvatarMutation, input: AvatarCropInput, session: JiraAvatarSession, check: boolean): Promise<JiraAvatarAttempt> {
  if (!matchesTemporary(session.temporary(), input)) return avatarConflict("The reviewed temporary image is not the current server-owned snapshot in this exact actor session and target. It may have been replaced, consumed or lost; obtain a fresh governed upload rather than replaying a crop.");
  const refused = await admitAvatarInput(session.request, input); if (refused !== undefined) return refused;
  const known = Object.freeze(receipt(input)); if (check) return { ok: true, receipt: known };
  const path = effectPath(operation, input.target); if (path === undefined) return AVATAR_MALFORMED;
  if (!matchesTemporary(session.temporary(), input)) return avatarConflict("The private temporary-image snapshot changed before dispatch.");
  session.rememberTemporary(undefined);
  const response = await session.request(path, "POST", { ...input.crop }, "json");
  if (!acknowledged(response)) return response.ok ? { ...AVATAR_MALFORMED, receipt: known } : { ...dispatchFailure(response), receipt: known };
  if (input.kind === "create") return createdAvatar(session, input, response, known);
  const observed = response.ok ? avatarCropAcknowledgement(response.body) : undefined;
  if (observed === undefined) return unconfirmed(known);
  try {
    session.rememberTemporary(Object.freeze({ actorKey: input.actor, target: Object.freeze({ ...input.target }),
      uploadSha256: input.expectedTemporary.uploadSha256, uploadBytes: input.expectedTemporary.uploadBytes,
      crop: Object.freeze({ ...observed.crop }), needsCropping: observed.needsCropping }));
    return unconfirmed({ ...known, temporaryCrop: observed.crop, temporaryNeedsCropping: observed.needsCropping });
  } catch (error) { throw new JiraAcknowledgedMutationError(error, known); }
}
async function legacyReleaseAdmission(ports: JiraAvatarPorts): Promise<AvatarFailure | undefined> {
  const expected = ports.legacyTemporaryRelease;
  if (expected === undefined) return avatarUnavailable("These legacy temporary-avatar endpoints require a current verified Jira10.3/10.4 connection. The selected connection does not supply that release binding; no avatar request was sent.");
  const response = await ports.request("serverInfo", "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const observed = response.status === 200 && response.body !== undefined ? jiraServerCompatibility(response.body) : undefined;
  if (observed?.status !== "ok" || observed.compatibility.versionNumbers[0] !== 10 ||
      observed.compatibility.versionNumbers[1] !== (expected === "10.3" ? 3 : 4))
    return avatarUnavailable("The current native Jira release does not match the verified10.3/10.4 binding for this legacy endpoint. Reverify the connection; no avatar request was sent.");
  return undefined;
}
/** Fixed avatar APIs only. Temporary uploads/crops require the composing owner's existing,
 * exclusive cookie-session custody; credentials, paths, bytes and session tokens are not model input. */
export async function executeJiraAvatarMutation(operation: JiraAvatarMutation, args: CatalogJsonObject, ports: JiraAvatarPorts, check = false): Promise<JiraAvatarAttempt> {
  const input = parseJiraAvatarMutation(operation, args);
  if (input === undefined) return avatarInvalid("Review the exact actor and target identity, complete native avatar metadata, and explicit selected flags. Uploads require a governed connected PNG/JPEG source with actual file digest/size and acknowledgement that the session's temporary image is replaced. Crop/create requires the current private session snapshot; never supply remote URLs or image bytes.");
  if (input.kind === "set" || input.kind === "delete") return selectAvatar(operation, input, ports.request, check);
  if (input.target.kind === "session") {
    const refused = await legacyReleaseAdmission(ports); if (refused !== undefined) return refused;
  }
  const withSession = ports.withSession;
  if (withSession === undefined) return avatarUnavailable("A private Jira session bound to this connector generation and the reviewed actor is unavailable. Native temporary images are session-owned; a credential or model-provided snapshot cannot substitute for that session.");
  return withSession(input.actor, (session) => input.kind === "upload" ? uploadAvatar(operation, input, ports, session, check) : cropAvatar(operation, input, session, check));
}
