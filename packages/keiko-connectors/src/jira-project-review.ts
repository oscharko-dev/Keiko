import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedName } from "./jira-saved-configuration-values.js";

export interface JiraProjectReview {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly archived: boolean;
  readonly projectTypeKey?: string;
}
const REVIEW_KEYS = new Set(["id", "key", "name", "archived", "projectTypeKey"]);
function projectTypeKeyValid(raw: Record<string, unknown>, exact: boolean): boolean {
  if (exact && Object.hasOwn(raw, "projectTypeKey"))
    return isSafeAtlassianIdentifier(raw.projectTypeKey);
  return (
    raw.projectTypeKey === undefined ||
    raw.projectTypeKey === null ||
    isSafeAtlassianIdentifier(raw.projectTypeKey)
  );
}
function reviewScalars(
  raw: Record<string, unknown>,
): Pick<JiraProjectReview, "id" | "key" | "name" | "archived"> | undefined {
  return jiraNativeId(raw.id) &&
    isSafeAtlassianIdentifier(raw.key) &&
    savedName(raw.name) &&
    typeof raw.archived === "boolean"
    ? { id: raw.id, key: raw.key, name: raw.name, archived: raw.archived }
    : undefined;
}
/** ProjectBean explicitly exposes archived. Omitted/null is unavailable, never false. */
export function jiraProjectReview(value: unknown, exact = false): JiraProjectReview | undefined {
  const raw = asRecord(value);
  if (raw === undefined || (exact && !savedExactKeys(raw, REVIEW_KEYS))) return undefined;
  if (!projectTypeKeyValid(raw, exact)) return undefined;
  const scalars = reviewScalars(raw);
  if (scalars === undefined) return undefined;
  return {
    ...scalars,
    ...(isSafeAtlassianIdentifier(raw.projectTypeKey)
      ? { projectTypeKey: raw.projectTypeKey }
      : {}),
  };
}
export function jiraProjectReviewFields(value: JiraProjectReview | undefined): CatalogJsonObject {
  return value === undefined
    ? {}
    : {
        reviewSnapshot: {
          id: value.id,
          key: value.key,
          name: value.name,
          archived: value.archived,
          ...(value.projectTypeKey === undefined ? {} : { projectTypeKey: value.projectTypeKey }),
        },
      };
}
export function sameProjectReview(left: JiraProjectReview, right: JiraProjectReview): boolean {
  return (
    left.id === right.id &&
    left.key === right.key &&
    left.name === right.name &&
    left.archived === right.archived &&
    left.projectTypeKey === right.projectTypeKey
  );
}
