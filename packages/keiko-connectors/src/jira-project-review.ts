import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedName } from "./jira-saved-configuration-values.js";

export interface JiraProjectReview { readonly id: string; readonly key: string; readonly name: string; readonly archived: boolean; readonly projectTypeKey?: string }
const REVIEW_KEYS = new Set(["id", "key", "name", "archived", "projectTypeKey"]);
/** ProjectBean explicitly exposes archived. Omitted/null is unavailable, never false. */
export function jiraProjectReview(value: unknown, exact = false): JiraProjectReview | undefined {
  const raw = asRecord(value);
  if (raw === undefined || (exact && !savedExactKeys(raw, REVIEW_KEYS))) return undefined;
  if (exact && Object.hasOwn(raw, "projectTypeKey") && !isSafeAtlassianIdentifier(raw.projectTypeKey)) return undefined;
  if (!jiraNativeId(raw.id) || !isSafeAtlassianIdentifier(raw.key) || !savedName(raw.name) || typeof raw.archived !== "boolean") return undefined;
  if (raw.projectTypeKey !== undefined && raw.projectTypeKey !== null && !isSafeAtlassianIdentifier(raw.projectTypeKey)) return undefined;
  return { id: raw.id, key: raw.key, name: raw.name, archived: raw.archived,
    ...(isSafeAtlassianIdentifier(raw.projectTypeKey) ? { projectTypeKey: raw.projectTypeKey } : {}) };
}
export function jiraProjectReviewFields(value: JiraProjectReview | undefined): CatalogJsonObject {
  return value === undefined ? {} : { reviewSnapshot: { id: value.id, key: value.key, name: value.name, archived: value.archived,
    ...(value.projectTypeKey === undefined ? {} : { projectTypeKey: value.projectTypeKey }) } };
}
export function sameProjectReview(left: JiraProjectReview, right: JiraProjectReview): boolean {
  return left.id === right.id && left.key === right.key && left.name === right.name && left.archived === right.archived && left.projectTypeKey === right.projectTypeKey;
}
