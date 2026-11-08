import { JIRA_AVATAR_MUTATIONS, type JiraAvatarMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeDeclaration, jiraNativeIdentitySchema as ID, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const TRUE = { type: "boolean", enum: [true] };
const TYPE = { type: "string", enum: ["user", "project", "issuetype"] };
const SHA = { type: "string", minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" };
const BYTES = { type: "integer", minimum: 1, maximum: 20 * 1024 * 1024 };
const COORDINATE = { type: "integer", minimum: 0, maximum: 2147483647 };
const CROP = object({ cropperOffsetX: COORDINATE, cropperOffsetY: COORDINATE, cropperWidth: { ...COORDINATE, minimum: 1 } }, ["cropperOffsetX", "cropperOffsetY", "cropperWidth"]);
const ROW = object({ id: ID, category: { type: "string", enum: ["system", "custom"] }, owner: NAME, selected: { type: "boolean" } }, ["id", "category", "selected"]);
const ROWS = { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: ROW };
const TARGETS = {
  session: object({ kind: { type: "string", enum: ["session"] }, avatarType: TYPE }, ["kind", "avatarType"]),
  project: object({ kind: { type: "string", enum: ["project"] }, id: ID, key: NAME }, ["kind", "id", "key"]),
  issuetype: object({ kind: { type: "string", enum: ["issuetype"] }, id: ID }, ["kind", "id"]),
  user: object({ kind: { type: "string", enum: ["user"] }, key: NAME, name: NAME }, ["kind", "key", "name"]),
} as const;
const OWNED = { anyOf: [TARGETS.project, TARGETS.issuetype] };
const TEMPORARY = object({ uploadSha256: SHA, uploadBytes: BYTES, crop: CROP, needsCropping: { type: "boolean" } }, ["uploadSha256", "uploadBytes", "crop", "needsCropping"]);
const RECEIPT = {
  actorUserKey: NAME, avatarType: TYPE, projectId: ID, projectKey: NAME, issueTypeId: ID, userKey: NAME,
  avatarId: ID, avatarPresent: { type: "boolean" }, avatarSelected: { type: "boolean" }, temporaryAvatar: TRUE,
  uploadSha256: SHA, uploadBytes: BYTES, temporaryCrop: CROP, temporaryNeedsCropping: { type: "boolean" },
};
const COMMON = "Explicit issue-tracker.admin authority is separate from native Jira permissions. Bind the current actor and exact resource owner, preserve one native effect and never replay uncertainty. No arbitrary URL, path, header, cookie, credential or image bytes enter model arguments. Readback is limited to native resource metadata; it cannot prove image-byte identity. Known ACK IDs stay known, missing IDs stay missing. Complete reviewed avatar collections require each explicit selected flag and reject contradictory supplied ownership; missing is not false. Native URLs are never followed or emitted.";
const TEMP_GUIDANCE = "Native temporary images occupy one slot per user session. The existing private custody owner must supply an exclusive session bound to connector generation and actor; PAT credential binding alone is insufficient. The source/approval owner grants access, never expectedFile alone. The server captures an immutable actual-byte snapshot in allowed mode; review-required mode uses its existing reviewed file approval, without adding a new per-action requirement. Upload invalidates the previous slot before dispatch; crop/create consume it once before dispatch. ACK metadata may support the next review but does not independently confirm persistence or assignment.";
function write(description: string, input: CatalogJsonObject): JiraNativeDefinition {
  return { description: `${description} ${COMMON}`, input, result: jiraNativeWriteResult(RECEIPT), risk: "write", maxResultCount: 1 };
}
function upload(target: CatalogJsonObject): CatalogJsonObject {
  return object({ expectedActorKey: NAME, target,
    source: object({ kind: { type: "string", enum: ["connected-file"] }, path: { ...text(1024), minLength: 1 } }, ["kind", "path"]),
    expectedFile: object({ name: { ...text(255), minLength: 1 }, sizeBytes: BYTES, sha256: SHA }, ["name", "sizeBytes", "sha256"]),
    acceptTemporaryReplacement: TRUE }, ["expectedActorKey", "target", "source", "expectedFile", "acceptTemporaryReplacement"]);
}
function crop(target: CatalogJsonObject, create: boolean): CatalogJsonObject {
  return object({ expectedActorKey: NAME, target, expectedTemporary: TEMPORARY, crop: CROP,
    ...(create ? { expectedAvatars: ROWS } : {}) }, ["expectedActorKey", "target", "expectedTemporary", "crop", ...(create ? ["expectedAvatars"] : [])]);
}
function selection(target: CatalogJsonObject): CatalogJsonObject {
  return object({ expectedActorKey: NAME, target, avatarId: ID, expectedAvatars: ROWS }, ["expectedActorKey", "target", "avatarId", "expectedAvatars"]);
}
const UPLOAD = `Upload an admitted PNG/JPEG connected file as raw image bytes through a fixed native upload endpoint, with exact filename and byte count. Other image/document formats are refused by the existing image/content floor. Always unconfirmed; no avatar resource or assignment is claimed. ${TEMP_GUIDANCE}`;
const CREATE = `Create an avatar resource from the exact current session-owned temporary image and reviewed crop coordinates. A new native resource ID comes only from the acknowledgement and may not have existed in the reviewed collection. Read the same bound owner again. Always unconfirmed: metadata presence does not prove pixel content or selection. ${TEMP_GUIDANCE}`;
const SET = "Select one exact avatar from the complete reviewed native owner collection. A fresh same-owner collection must preserve every ID/category/owner and explicitly select exactly the requested ID. This confirms selection metadata only; no image-byte equivalence is claimed. An independently observed exact existing selection returns an explicit pre-dispatch unchanged result.";
const DELETE = "Delete one exact custom avatar in the reviewed owner collection; system avatars are not deletable through this adapter. Read the still-bound owner and complete avatar collection after acknowledgement. Always unconfirmed: bare404, disappearance or an ACK does not establish all image-reference/selection consequences. No fallback avatar is guessed.";
export const JIRA_AVATAR_WRITE_DEFINITIONS = {
  "jira.upload-temporary-avatar": write(`${UPLOAD} Legacy native POST avatar/{type}/temporary is retained for10.3/10.4 only; it is absent from pinned11.3. A server-owned compatible release binding is mandatory. This generic endpoint binds actor session and type only, never an invented project/issue-type owner.`, upload(TARGETS.session)),
  "jira.crop-temporary-avatar": write(`Update legacy temporary crop instructions; this is not final-avatar creation. ${TEMP_GUIDANCE} Published retained10.3/10.4 only, absent from pinned11.3, with mandatory server-owned compatible release binding.`, crop(TARGETS.session, false)),
  "jira.upload-issue-type-avatar": write(UPLOAD, upload(TARGETS.issuetype)),
  "jira.create-issue-type-avatar": write(CREATE, crop(TARGETS.issuetype, true)),
  "jira.upload-project-avatar": write(UPLOAD, upload(TARGETS.project)),
  "jira.create-project-avatar": write(CREATE, crop(TARGETS.project, true)),
  "jira.set-project-avatar": write(SET, selection(TARGETS.project)),
  "jira.delete-project-avatar": write(DELETE, selection(TARGETS.project)),
  "jira.upload-owned-avatar": write(UPLOAD, upload(OWNED)),
  "jira.create-owned-avatar": write(CREATE, crop(OWNED, true)),
  "jira.delete-owned-avatar": write(DELETE, selection(OWNED)),
  "jira.upload-user-avatar": write(`${UPLOAD} The target username and key must independently identify the same native user; actor and target are distinct.`, upload(TARGETS.user)),
  "jira.create-user-avatar": write(CREATE, crop(TARGETS.user, true)),
  "jira.set-user-avatar": write(SET, selection(TARGETS.user)),
  "jira.delete-user-avatar": write(DELETE, selection(TARGETS.user)),
} as const satisfies Readonly<Record<JiraAvatarMutation, JiraNativeDefinition>>;
export function jiraAvatarMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const operation = JIRA_AVATAR_MUTATIONS.find((candidate) => candidate === name);
  return operation === undefined ? undefined : jiraNativeDeclaration(operation, JIRA_AVATAR_WRITE_DEFINITIONS[operation]);
}
