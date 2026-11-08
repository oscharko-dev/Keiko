import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { bindIdentityUser } from "./jira-identity-mutation-observations.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { jiraIssueTypeReviewSnapshot } from "./jira-issue-type-values.js";
import { projectJiraAvatar, jiraAvatarGroups } from "./jira-managed-avatar-reads.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { readSavedActor, savedName } from "./jira-saved-configuration-values.js";
import { avatarCrop, avatarReviews, type AvatarInput } from "./jira-avatar-mutation-input.js";
import {
  AVATAR_MALFORMED,
  avatarConflict,
  avatarFailure,
  type AvatarFailure,
  type AvatarObservation,
  type JiraAvatarReview,
  type JiraAvatarTarget,
} from "./jira-avatar-mutation-values.js";

export function avatarCollectionPath(target: JiraAvatarTarget): string | undefined {
  switch (target.kind) {
    case "session":
      return undefined;
    case "project":
      return `project/${target.id}/avatars`;
    case "issuetype":
      return `universal_avatar/type/issuetype/owner/${target.id}`;
    case "user":
      return `user/avatars?${new URLSearchParams({ username: target.name })}`;
  }
}
async function bindProject(
  request: JiraMutationRequest,
  target: Extract<JiraAvatarTarget, { kind: "project" }>,
): Promise<AvatarFailure | undefined> {
  const current = await readJiraBoundProject(request, target.id);
  if (!current.ok) return avatarFailure(current);
  return current.project.projectId === target.id && current.project.projectKey === target.key
    ? undefined
    : avatarConflict(
        "The reviewed project identity changed. Read and review its canonical ID and key before changing an avatar.",
      );
}
async function bindType(
  request: JiraMutationRequest,
  id: string,
): Promise<AvatarFailure | undefined> {
  const response = await request(`issuetype/${id}`, "GET", undefined, "json");
  if (!response.ok) return avatarFailure(dispatchFailure(response));
  const current = response.status === 200 ? jiraIssueTypeReviewSnapshot(response.body) : undefined;
  return current?.id === id ? undefined : AVATAR_MALFORMED;
}
export async function bindAvatarTarget(
  request: JiraMutationRequest,
  target: JiraAvatarTarget,
): Promise<AvatarFailure | undefined> {
  if (target.kind === "session") return undefined;
  if (target.kind === "project") return bindProject(request, target);
  if (target.kind === "issuetype") return bindType(request, target.id);
  const current = await bindIdentityUser(request, target);
  return current.ok ? undefined : avatarFailure(current);
}
function ownerMatches(row: JiraAvatarReview, target: JiraAvatarTarget): boolean {
  if (row.category === "system" || row.owner === undefined) return true;
  if (target.kind === "session") return false;
  return row.owner === (target.kind === "user" ? target.key : target.id);
}
function nativeReview(value: unknown, category: "system" | "custom"): unknown {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  if (
    category === "custom" &&
    raw.owner !== undefined &&
    raw.owner !== null &&
    !savedName(raw.owner)
  )
    return undefined;
  return projectJiraAvatar(value, category);
}
export async function readAvatarCollection(
  request: JiraMutationRequest,
  target: JiraAvatarTarget,
): Promise<AvatarObservation<readonly JiraAvatarReview[]>> {
  const path = avatarCollectionPath(target);
  if (path === undefined) return AVATAR_MALFORMED;
  const response = await request(path, "GET", undefined, "json");
  if (!response.ok) return avatarFailure(dispatchFailure(response));
  if (response.status !== 200) return AVATAR_MALFORMED;
  const count = [response.body?.system, response.body?.custom].reduce<number>(
    (total, items) => total + (Array.isArray(items) ? items.length : 0),
    0,
  );
  if (count > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const grouped = jiraAvatarGroups(response.body, false);
  if (grouped === undefined) return AVATAR_MALFORMED;
  // Reuse the ordinary metadata projection, then require explicit selected flags for reviewed writes.
  const rows = avatarReviews(grouped.map((item) => nativeReview(item.value, item.category)));
  return rows?.every((row) => ownerMatches(row, target))
    ? { ok: true, value: rows }
    : AVATAR_MALFORMED;
}
export function sameAvatarRows(
  left: readonly JiraAvatarReview[],
  right: readonly JiraAvatarReview[],
): boolean {
  return (
    left.length === right.length &&
    left.every((row) =>
      right.some(
        (other) =>
          row.id === other.id &&
          row.category === other.category &&
          row.selected === other.selected &&
          row.owner === other.owner,
      ),
    )
  );
}
export function sameAvatarTarget(left: JiraAvatarTarget, right: JiraAvatarTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "session":
      return right.kind === "session" && left.avatarType === right.avatarType;
    case "user":
      return right.kind === "user" && left.key === right.key && left.name === right.name;
    case "project":
      return right.kind === "project" && left.id === right.id && left.key === right.key;
    case "issuetype":
      return right.kind === "issuetype" && left.id === right.id;
  }
}
export async function admitAvatarInput(
  request: JiraMutationRequest,
  input: AvatarInput,
): Promise<AvatarFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return avatarFailure(actor);
  const bound = await bindAvatarTarget(request, input.target);
  if (bound !== undefined) return bound;
  if (input.kind === "upload" || input.kind === "crop") return undefined;
  const current = await readAvatarCollection(request, input.target);
  if (!current.ok) return current;
  return sameAvatarRows(current.value, input.expectedAvatars)
    ? undefined
    : avatarConflict(
        "The complete native avatar collection changed or its selected/owner facts are unavailable. Review the current same-parent collection before any change; a missing fact is not false or an empty list.",
      );
}
/** Native crop URLs are not part of the projection, and are never fetched or used as a target. */
export function avatarCropAcknowledgement(value: unknown):
  | {
      readonly crop: {
        readonly cropperOffsetX: number;
        readonly cropperOffsetY: number;
        readonly cropperWidth: number;
      };
      readonly needsCropping: boolean;
    }
  | undefined {
  const raw = asRecord(value);
  if (raw === undefined || typeof raw.needsCropping !== "boolean") return undefined;
  const crop = avatarCrop({
    cropperOffsetX: raw.cropperOffsetX,
    cropperOffsetY: raw.cropperOffsetY,
    cropperWidth: raw.cropperWidth,
  });
  return crop === undefined ? undefined : { crop, needsCropping: raw.needsCropping };
}
