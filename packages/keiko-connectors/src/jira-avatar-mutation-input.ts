import {
  JIRA_ATTACHMENT_MAX_BYTES,
  isJiraAttachmentPreview,
  type JiraAttachmentPreview,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedName } from "./jira-saved-configuration-values.js";
import type {
  JiraAvatarCrop,
  JiraAvatarMutation,
  JiraAvatarReview,
  JiraAvatarTarget,
  JiraAvatarTemporarySnapshot,
} from "./jira-avatar-mutation-values.js";

interface AvatarBase {
  readonly actor: string;
  readonly target: JiraAvatarTarget;
}
export interface AvatarUploadInput extends AvatarBase {
  readonly kind: "upload";
  readonly path: string;
  readonly expectedFile: JiraAttachmentPreview;
}
export type AvatarCropInput = AvatarBase & {
  readonly expectedTemporary: Omit<JiraAvatarTemporarySnapshot, "actorKey" | "target">;
  readonly crop: JiraAvatarCrop;
  readonly expectedAvatars: readonly JiraAvatarReview[];
} & ({ readonly kind: "crop" } | { readonly kind: "create" });
export type AvatarSelectionInput = AvatarBase & {
  readonly avatarId: string;
  readonly expectedAvatars: readonly JiraAvatarReview[];
} & ({ readonly kind: "set" } | { readonly kind: "delete" });
export type AvatarInput = AvatarUploadInput | AvatarCropInput | AvatarSelectionInput;
const FIELDS: Readonly<Record<JiraAvatarMutation, JiraAvatarTarget["kind"] | "owned">> = {
  "jira.upload-temporary-avatar": "session",
  "jira.crop-temporary-avatar": "session",
  "jira.upload-issue-type-avatar": "issuetype",
  "jira.create-issue-type-avatar": "issuetype",
  "jira.upload-project-avatar": "project",
  "jira.create-project-avatar": "project",
  "jira.set-project-avatar": "project",
  "jira.delete-project-avatar": "project",
  "jira.upload-owned-avatar": "owned",
  "jira.create-owned-avatar": "owned",
  "jira.delete-owned-avatar": "owned",
  "jira.upload-user-avatar": "user",
  "jira.create-user-avatar": "user",
  "jira.set-user-avatar": "user",
  "jira.delete-user-avatar": "user",
};
function exact(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function nativeType(value: unknown): value is "user" | "project" | "issuetype" {
  return value === "user" || value === "project" || value === "issuetype";
}
function projectTarget(raw: Record<string, unknown>): JiraAvatarTarget | undefined {
  return exact(raw, ["kind", "id", "key"]) && jiraNativeId(raw.id) && savedName(raw.key)
    ? { kind: "project", id: raw.id, key: raw.key }
    : undefined;
}
function userTarget(raw: Record<string, unknown>): JiraAvatarTarget | undefined {
  return exact(raw, ["kind", "key", "name"]) && savedName(raw.key) && savedName(raw.name)
    ? { kind: "user", key: raw.key, name: raw.name }
    : undefined;
}
function typeTarget(raw: Record<string, unknown>): JiraAvatarTarget | undefined {
  return exact(raw, ["kind", "id"]) && jiraNativeId(raw.id)
    ? { kind: "issuetype", id: raw.id }
    : undefined;
}
function sessionTarget(raw: Record<string, unknown>): JiraAvatarTarget | undefined {
  return exact(raw, ["kind", "avatarType"]) && nativeType(raw.avatarType)
    ? { kind: "session", avatarType: raw.avatarType }
    : undefined;
}
function targetValue(value: unknown): JiraAvatarTarget | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  switch (raw.kind) {
    case "project":
      return projectTarget(raw);
    case "issuetype":
      return typeTarget(raw);
    case "user":
      return userTarget(raw);
    case "session":
      return sessionTarget(raw);
    default:
      return undefined;
  }
}
function expectedTarget(
  operation: JiraAvatarMutation,
  value: unknown,
): JiraAvatarTarget | undefined {
  const target = targetValue(value);
  if (target === undefined) return undefined;
  const kind = FIELDS[operation];
  if (kind === "owned") {
    if (target.kind === "project" || target.kind === "issuetype") {
      return target;
    }
    return undefined;
  }
  if (target.kind === kind) {
    return target;
  }
  return undefined;
}
function coordinate(value: unknown, positive = false): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= (positive ? 1 : 0) &&
    value <= 2147483647
  );
}
export function avatarCrop(value: unknown): JiraAvatarCrop | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !exact(raw, ["cropperOffsetX", "cropperOffsetY", "cropperWidth"]))
    return undefined;
  return coordinate(raw.cropperOffsetX) &&
    coordinate(raw.cropperOffsetY) &&
    coordinate(raw.cropperWidth, true)
    ? {
        cropperOffsetX: raw.cropperOffsetX,
        cropperOffsetY: raw.cropperOffsetY,
        cropperWidth: raw.cropperWidth,
      }
    : undefined;
}
export function avatarReview(value: unknown): JiraAvatarReview | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !exact(raw, ["id", "category", "selected", "owner"])) return undefined;
  if (
    !jiraNativeId(raw.id) ||
    typeof raw.selected !== "boolean" ||
    (raw.category !== "system" && raw.category !== "custom")
  )
    return undefined;
  if (raw.owner !== undefined && !savedName(raw.owner)) return undefined;
  return {
    id: raw.id,
    category: raw.category,
    selected: raw.selected,
    ...(typeof raw.owner === "string" ? { owner: raw.owner } : {}),
  };
}
export function avatarReviews(value: unknown): readonly JiraAvatarReview[] | undefined {
  if (!Array.isArray(value) || value.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const rows: JiraAvatarReview[] = [];
  for (const item of value) {
    const row = avatarReview(item);
    if (row === undefined || rows.some((prior) => prior.id === row.id)) return undefined;
    rows.push(row);
  }
  return rows.filter((row) => row.selected).length <= 1 ? rows : undefined;
}
function upload(args: CatalogJsonObject, base: AvatarBase): AvatarUploadInput | undefined {
  if (
    !exact(args, [
      "expectedActorKey",
      "target",
      "source",
      "expectedFile",
      "acceptTemporaryReplacement",
    ]) ||
    args.acceptTemporaryReplacement !== true
  )
    return undefined;
  const source = asRecord(args.source);
  if (
    source === undefined ||
    !exact(source, ["kind", "path"]) ||
    source.kind !== "connected-file" ||
    !isPortableWorkspaceRelativePath(source.path)
  )
    return undefined;
  const expectedFile = args.expectedFile;
  if (
    !isJiraAttachmentPreview(expectedFile) ||
    !exact(expectedFile, ["name", "sizeBytes", "sha256"])
  )
    return undefined;
  return {
    ...base,
    kind: "upload",
    path: source.path,
    expectedFile: {
      name: expectedFile.name,
      sizeBytes: expectedFile.sizeBytes,
      sha256: expectedFile.sha256,
    },
  };
}
function sha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
function uploadByteCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= JIRA_ATTACHMENT_MAX_BYTES
  );
}
function temporary(value: unknown): AvatarCropInput["expectedTemporary"] | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !exact(raw, ["uploadSha256", "uploadBytes", "crop", "needsCropping"]))
    return undefined;
  const crop = avatarCrop(raw.crop);
  if (
    crop === undefined ||
    !sha256Hex(raw.uploadSha256) ||
    !uploadByteCount(raw.uploadBytes) ||
    typeof raw.needsCropping !== "boolean"
  )
    return undefined;
  return {
    uploadSha256: raw.uploadSha256,
    uploadBytes: raw.uploadBytes,
    crop,
    needsCropping: raw.needsCropping,
  };
}
/** Private persisted session data uses the exact model-review codecs; possession of this
 * parsed value is not authority and does not replace the custody owner's session binding. */
export function parseJiraAvatarTemporarySnapshot(
  value: unknown,
): JiraAvatarTemporarySnapshot | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !exact(raw, ["actorKey", "target", "uploadSha256", "uploadBytes", "crop", "needsCropping"]) ||
    !savedName(raw.actorKey)
  )
    return undefined;
  const target = targetValue(raw.target);
  const image = temporary({
    uploadSha256: raw.uploadSha256,
    uploadBytes: raw.uploadBytes,
    crop: raw.crop,
    needsCropping: raw.needsCropping,
  });
  return target === undefined || image === undefined
    ? undefined
    : Object.freeze({
        actorKey: raw.actorKey,
        target: Object.freeze(target),
        ...image,
        crop: Object.freeze(image.crop),
      });
}
function cropping(
  operation: JiraAvatarMutation,
  args: CatalogJsonObject,
  base: AvatarBase,
): AvatarCropInput | undefined {
  const kind = operation === "jira.crop-temporary-avatar" ? "crop" : "create";
  const allowed = [
    "expectedActorKey",
    "target",
    "expectedTemporary",
    "crop",
    ...(kind === "create" ? ["expectedAvatars"] : []),
  ];
  if (!exact(args, allowed)) return undefined;
  const expectedTemporary = temporary(args.expectedTemporary);
  const crop = avatarCrop(args.crop);
  const expectedAvatars = kind === "crop" ? [] : avatarReviews(args.expectedAvatars);
  return expectedTemporary === undefined || crop === undefined || expectedAvatars === undefined
    ? undefined
    : { ...base, kind, expectedTemporary, crop, expectedAvatars };
}
function selection(
  operation: JiraAvatarMutation,
  args: CatalogJsonObject,
  base: AvatarBase,
): AvatarInput | undefined {
  if (
    !exact(args, ["expectedActorKey", "target", "avatarId", "expectedAvatars"]) ||
    !jiraNativeId(args.avatarId)
  )
    return undefined;
  const expectedAvatars = avatarReviews(args.expectedAvatars);
  if (expectedAvatars === undefined) return undefined;
  const selected = expectedAvatars.find((row) => row.id === args.avatarId);
  if (selected === undefined) return undefined;
  const kind = operation.startsWith("jira.set-") ? "set" : "delete";
  return kind === "delete" && selected.category !== "custom"
    ? undefined
    : { ...base, kind, avatarId: args.avatarId, expectedAvatars };
}
export function parseJiraAvatarMutation(
  operation: JiraAvatarMutation,
  args: CatalogJsonObject,
): AvatarInput | undefined {
  if (!savedName(args.expectedActorKey)) return undefined;
  const target = expectedTarget(operation, args.target);
  if (target === undefined) return undefined;
  const base: AvatarBase = { actor: args.expectedActorKey, target };
  if (operation.startsWith("jira.upload-")) return upload(args, base);
  if (operation.startsWith("jira.create-") || operation === "jira.crop-temporary-avatar")
    return cropping(operation, args, base);
  return selection(operation, args, base);
}
