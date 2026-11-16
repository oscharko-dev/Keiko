import { createHash } from "node:crypto";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { IDENTITY_MUTATION_FIXTURE_CASES } from "./jira-identity-mutation-fixture.js";
import {
  PRIVATE_ACCOUNT_WRITE_CASES,
  PRIVATE_ACCOUNT_READ_CASES,
} from "./jira-private-account-fixture.js";
import {
  AVATAR_MUTATION_FIXTURE_CASES,
  avatarFixtureRows,
} from "./jira-avatar-mutation-fixture.js";
import { ANONYMIZATION_UNLOCK_CASE } from "./jira-anonymization-unlock-fixture.js";

export const PRIVATE_NATIVE_ACTOR = {
  key: "synthetic-key",
  name: "synthetic-user",
  displayName: "Reviewed operator",
  active: true,
} as const;
// The complete existing connected-image admission fixture, rather than its eight-byte signature.
export const PRIVATE_NATIVE_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE0sAAAAASUVORK5CYII=",
  "base64",
);
const PRIVATE_NATIVE_FILE = {
  name: "avatar.png",
  sizeBytes: PRIVATE_NATIVE_IMAGE.byteLength,
  sha256: createHash("sha256").update(PRIVATE_NATIVE_IMAGE).digest("hex"),
};
export const PRIVATE_NATIVE_CROP = { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 1 };
export const PRIVATE_NATIVE_TEMP = {
  uploadSha256: PRIVATE_NATIVE_FILE.sha256,
  uploadBytes: PRIVATE_NATIVE_FILE.sizeBytes,
  crop: PRIVATE_NATIVE_CROP,
  needsCropping: false,
};
export const PRIVATE_NATIVE_PASSWORD = "synthetic human-provided native fixture password";
export const PRIVATE_NATIVE_LICENSE = "synthetic human-provided native fixture license";
export const PRIVATE_NATIVE_COOKIE = {
  name: "JSESSIONID",
  value: "synthetic-native-fixture-session-cookie",
};

type PrivateNativeTool =
  | (typeof IDENTITY_MUTATION_FIXTURE_CASES)[number]["name"]
  | (typeof PRIVATE_ACCOUNT_WRITE_CASES)[number]["name"]
  | (typeof PRIVATE_ACCOUNT_READ_CASES)[number]["name"]
  | (typeof AVATAR_MUTATION_FIXTURE_CASES)[number]["name"]
  | typeof ANONYMIZATION_UNLOCK_CASE.name;
export interface PrivateNativeCase {
  readonly tool: PrivateNativeTool;
  readonly args: CatalogJsonObject;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly apiRoot: "/rest/api/2" | "/rest/auth/1";
  readonly path: string;
  readonly receipt?: CatalogJsonObject;
  readonly outcome: "succeeded" | "succeeded-unconfirmed";
  readonly state: object;
}
type AvatarCase = (typeof AVATAR_MUTATION_FIXTURE_CASES)[number];
function avatarTargetReceipt(target: AvatarCase["target"]): CatalogJsonObject {
  if (target.kind === "project") return { projectId: target.id, projectKey: target.key };
  if (target.kind === "issuetype") return { issueTypeId: target.id };
  return target.kind === "user" ? { userKey: target.key } : {};
}
function avatarReceipt(selected: AvatarCase): CatalogJsonObject {
  const target = selected.target;
  const avatarType = target.kind === "session" ? target.avatarType : target.kind;
  const known: CatalogJsonObject = {
    actorUserKey: PRIVATE_NATIVE_ACTOR.key,
    avatarType,
    ...avatarTargetReceipt(target),
  };
  const file = {
    uploadSha256: PRIVATE_NATIVE_FILE.sha256,
    uploadBytes: PRIVATE_NATIVE_FILE.sizeBytes,
  };
  if ("upload" in selected || selected.name === "jira.crop-temporary-avatar")
    return {
      ...known,
      ...file,
      temporaryAvatar: true,
      temporaryCrop: PRIVATE_NATIVE_CROP,
      temporaryNeedsCropping: false,
    };
  if (selected.name.startsWith("jira.create-"))
    return { ...known, ...file, avatarId: "43", avatarPresent: true };
  return {
    ...known,
    avatarId: "42",
    ...(selected.method === "DELETE" ? { avatarPresent: false } : { avatarSelected: true }),
  };
}
function avatarState(selected: AvatarCase): object {
  return {
    effects: 1,
    avatarIds:
      selected.method === "DELETE"
        ? ["41"]
        : selected.name.startsWith("jira.create-")
          ? ["41", "42", "43"]
          : ["41", "42"],
    selectedAvatarId: selected.method === "PUT" ? "42" : "41",
    rawUploadBytes: "upload" in selected ? PRIVATE_NATIVE_FILE.sizeBytes : 0,
  };
}
function avatarCase(selected: AvatarCase): PrivateNativeCase {
  const upload = "upload" in selected;
  const create = selected.name.startsWith("jira.create-");
  const crop = selected.name === "jira.crop-temporary-avatar";
  return {
    tool: selected.name,
    method: selected.method,
    apiRoot: "/rest/api/2",
    path: upload
      ? selected.path.replace(/size=8$/u, `size=${String(PRIVATE_NATIVE_FILE.sizeBytes)}`)
      : selected.path,
    args: {
      ...selected.args,
      expectedActorKey: PRIVATE_NATIVE_ACTOR.key,
      ...(upload ? { expectedFile: PRIVATE_NATIVE_FILE } : {}),
      ...(create || crop
        ? { expectedTemporary: PRIVATE_NATIVE_TEMP, crop: PRIVATE_NATIVE_CROP }
        : {}),
    },
    receipt: avatarReceipt(selected),
    outcome: "confirmed" in selected ? "succeeded" : "succeeded-unconfirmed",
    state: avatarState(selected),
  };
}
const identityCases: readonly PrivateNativeCase[] = IDENTITY_MUTATION_FIXTURE_CASES.map(
  (selected) => ({
    tool: selected.name,
    args: { ...selected.args, expectedActorKey: PRIVATE_NATIVE_ACTOR.key },
    method: selected.method,
    apiRoot: "/rest/api/2",
    path: selected.path,
    receipt: { ...selected.receipt, actorUserKey: PRIVATE_NATIVE_ACTOR.key },
    outcome: selected.confirmed ? "succeeded" : "succeeded-unconfirmed",
    state: {
      effects: 1,
      user: {
        key: "target-user",
        name: "Target User",
        displayName: selected.name === "jira.update-user" ? "Updated user" : "Reviewed user",
        active: true,
      },
      deleted: selected.name === "jira.delete-user",
      sessionInvalidated: selected.name === "jira.invalidate-user-session",
      scheduled:
        selected.name === "jira.schedule-user-anonymization" ||
        selected.name === "jira.rerun-user-anonymization",
    },
  }),
);
const accountCases: readonly PrivateNativeCase[] = PRIVATE_ACCOUNT_WRITE_CASES.map((selected) => ({
  tool: selected.name,
  method: selected.method,
  apiRoot: selected.apiRoot,
  path: selected.path,
  args: {
    ...selected.args,
    expectedActorKey: PRIVATE_NATIVE_ACTOR.key,
    ...(selected.name === "jira.update-myself" ? { expectedUser: PRIVATE_NATIVE_ACTOR } : {}),
    ...(selected.name === "jira.update-my-password"
      ? { user: { key: PRIVATE_NATIVE_ACTOR.key, name: PRIVATE_NATIVE_ACTOR.name } }
      : {}),
  },
  receipt: {
    ...selected.receipt,
    actorUserKey: PRIVATE_NATIVE_ACTOR.key,
    ...(selected.name === "jira.update-user-password"
      ? {}
      : { userKey: PRIVATE_NATIVE_ACTOR.key, username: PRIVATE_NATIVE_ACTOR.name }),
  },
  outcome: selected.confirmed ? "succeeded" : "succeeded-unconfirmed",
  state: {
    effects: 1,
    profileName: selected.name === "jira.update-myself" ? "Changed operator" : "Reviewed operator",
    sessionActive: selected.name !== "jira.logout",
  },
}));
const validationCases: readonly PrivateNativeCase[] = PRIVATE_ACCOUNT_READ_CASES.map(
  (selected) => ({
    tool: selected.name,
    method: "POST",
    apiRoot: "/rest/api/2",
    path: selected.path,
    args: { ...selected.args, expectedActorKey: PRIVATE_NATIVE_ACTOR.key },
    outcome: "succeeded",
    state: { validations: 1 },
  }),
);
/** All expectations originate in literal native fixtures; no production registry or projector is used. */
export const PRIVATE_NATIVE_CASES: readonly PrivateNativeCase[] = [
  ...identityCases,
  ...accountCases,
  ...validationCases,
  ...AVATAR_MUTATION_FIXTURE_CASES.map(avatarCase),
  {
    tool: ANONYMIZATION_UNLOCK_CASE.name,
    method: "DELETE",
    apiRoot: "/rest/api/2",
    path: "user/anonymization/unlock",
    args: { ...ANONYMIZATION_UNLOCK_CASE.args, expectedActorKey: PRIVATE_NATIVE_ACTOR.key },
    receipt: { ...ANONYMIZATION_UNLOCK_CASE.receipt, actorUserKey: PRIVATE_NATIVE_ACTOR.key },
    outcome: "succeeded-unconfirmed",
    state: { effects: 1, unlockRequested: true },
  },
];
export function privateNativeCase(tool: string | undefined): PrivateNativeCase | undefined {
  return PRIVATE_NATIVE_CASES.find((selected) => selected.tool === tool);
}
export function privateAvatarRows(tool: string): readonly CatalogJsonObject[] {
  const selected = AVATAR_MUTATION_FIXTURE_CASES.find((row) => row.name === tool);
  if (selected === undefined) throw new TypeError("Missing independent avatar case");
  return avatarFixtureRows(selected.target);
}
