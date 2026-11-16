import { createHash } from "node:crypto";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  JiraAvatarMutation,
  JiraAvatarTarget,
} from "../../packages/keiko-connectors/src/jira-avatar-mutation-values.js";

const AVATAR_FIXTURE_ACTOR = "synthetic-actor";
const AVATAR_FIXTURE_CROP = { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 32 };
export const AVATAR_FIXTURE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export const AVATAR_FIXTURE_FILE = {
  name: "avatar.png",
  sizeBytes: AVATAR_FIXTURE_BYTES.byteLength,
  sha256: createHash("sha256").update(AVATAR_FIXTURE_BYTES).digest("hex"),
};
const AVATAR_FIXTURE_TEMP = {
  uploadSha256: AVATAR_FIXTURE_FILE.sha256,
  uploadBytes: AVATAR_FIXTURE_FILE.sizeBytes,
  crop: AVATAR_FIXTURE_CROP,
  needsCropping: false,
};
const PROJECT = { kind: "project", id: "100", key: "SYN" } as const;
const USER = { kind: "user", key: "synthetic-target", name: "target-user" } as const;
const TYPE = { kind: "issuetype", id: "7" } as const;
const SESSION = { kind: "session", avatarType: "user" } as const;
export function avatarFixtureRows(target: JiraAvatarTarget): readonly CatalogJsonObject[] {
  const owner =
    target.kind === "user"
      ? target.key
      : target.kind === "session"
        ? AVATAR_FIXTURE_ACTOR
        : target.id;
  return [
    { id: "41", category: "system", selected: true },
    { id: "42", category: "custom", owner, selected: false },
  ];
}
function upload(target: JiraAvatarTarget): CatalogJsonObject {
  return {
    expectedActorKey: AVATAR_FIXTURE_ACTOR,
    target: { ...target },
    source: { kind: "connected-file", path: "images/avatar.png" },
    expectedFile: { ...AVATAR_FIXTURE_FILE },
    acceptTemporaryReplacement: true,
  };
}
function crop(target: JiraAvatarTarget, create = true): CatalogJsonObject {
  return {
    expectedActorKey: AVATAR_FIXTURE_ACTOR,
    target: { ...target },
    expectedTemporary: { ...AVATAR_FIXTURE_TEMP, crop: { ...AVATAR_FIXTURE_CROP } },
    crop: { ...AVATAR_FIXTURE_CROP },
    ...(create ? { expectedAvatars: [...avatarFixtureRows(target)] } : {}),
  };
}
function select(target: JiraAvatarTarget): CatalogJsonObject {
  return {
    expectedActorKey: AVATAR_FIXTURE_ACTOR,
    target: { ...target },
    avatarId: "42",
    expectedAvatars: [...avatarFixtureRows(target)],
  };
}
interface AvatarCase {
  readonly name: JiraAvatarMutation;
  readonly args: CatalogJsonObject;
  readonly target: JiraAvatarTarget;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly upload?: true;
  readonly confirmed?: true;
}
/** Independent literal native contracts, never generated from the operation registry. Image bytes
 * are a synthetic port fixture; real content admission has its separate existing-owner tests. */
export const AVATAR_MUTATION_FIXTURE_CASES = [
  {
    name: "jira.upload-temporary-avatar",
    args: upload(SESSION),
    target: SESSION,
    method: "POST",
    path: "avatar/user/temporary?filename=avatar.png&size=8",
    upload: true,
  },
  {
    name: "jira.crop-temporary-avatar",
    args: crop(SESSION, false),
    target: SESSION,
    method: "POST",
    path: "avatar/user/temporaryCrop",
  },
  {
    name: "jira.upload-issue-type-avatar",
    args: upload(TYPE),
    target: TYPE,
    method: "POST",
    path: "issuetype/7/avatar/temporary?filename=avatar.png&size=8",
    upload: true,
  },
  {
    name: "jira.create-issue-type-avatar",
    args: crop(TYPE),
    target: TYPE,
    method: "POST",
    path: "issuetype/7/avatar",
  },
  {
    name: "jira.upload-project-avatar",
    args: upload(PROJECT),
    target: PROJECT,
    method: "POST",
    path: "project/100/avatar/temporary?filename=avatar.png&size=8",
    upload: true,
  },
  {
    name: "jira.create-project-avatar",
    args: crop(PROJECT),
    target: PROJECT,
    method: "POST",
    path: "project/100/avatar",
  },
  {
    name: "jira.set-project-avatar",
    args: select(PROJECT),
    target: PROJECT,
    method: "PUT",
    path: "project/100/avatar",
    confirmed: true,
  },
  {
    name: "jira.delete-project-avatar",
    args: select(PROJECT),
    target: PROJECT,
    method: "DELETE",
    path: "project/100/avatar/42",
  },
  {
    name: "jira.upload-owned-avatar",
    args: upload(TYPE),
    target: TYPE,
    method: "POST",
    path: "universal_avatar/type/issuetype/owner/7/temp?filename=avatar.png&size=8",
    upload: true,
  },
  {
    name: "jira.create-owned-avatar",
    args: crop(TYPE),
    target: TYPE,
    method: "POST",
    path: "universal_avatar/type/issuetype/owner/7/avatar",
  },
  {
    name: "jira.delete-owned-avatar",
    args: select(TYPE),
    target: TYPE,
    method: "DELETE",
    path: "universal_avatar/type/issuetype/owner/7/avatar/42",
  },
  {
    name: "jira.upload-user-avatar",
    args: upload(USER),
    target: USER,
    method: "POST",
    path: "user/avatar/temporary?username=target-user&filename=avatar.png&size=8",
    upload: true,
  },
  {
    name: "jira.create-user-avatar",
    args: crop(USER),
    target: USER,
    method: "POST",
    path: "user/avatar?username=target-user",
  },
  {
    name: "jira.set-user-avatar",
    args: select(USER),
    target: USER,
    method: "PUT",
    path: "user/avatar?username=target-user",
    confirmed: true,
  },
  {
    name: "jira.delete-user-avatar",
    args: select(USER),
    target: USER,
    method: "DELETE",
    path: "user/avatar/42?username=target-user",
  },
] as const satisfies readonly AvatarCase[];
