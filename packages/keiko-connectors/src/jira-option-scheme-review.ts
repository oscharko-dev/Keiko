import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedName, savedText } from "./jira-saved-configuration-values.js";
export type SchemeKind = "issue-type" | "priority";
export interface SchemeSnapshot {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly ids: readonly string[];
  readonly defaultId: string | null;
  readonly defaultScheme?: boolean;
}
export function schemeIds(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    value.every(jiraNativeId) &&
    new Set(value).size === value.length
    ? [...value]
    : undefined;
}
export function schemeDefault(value: unknown, ids: readonly string[]): value is string | null {
  return value === null || (jiraNativeId(value) && ids.includes(value));
}
function observedOptions(
  values: unknown,
  defaultId: unknown,
): Pick<SchemeSnapshot, "ids" | "defaultId"> | undefined {
  const ids = schemeIds(values);
  return ids === undefined || !schemeDefault(defaultId, ids) ? undefined : { ids, defaultId };
}
function options(
  kind: SchemeKind,
  raw: Record<string, unknown>,
  projected: CatalogJsonObject,
): Pick<SchemeSnapshot, "ids" | "defaultId" | "defaultScheme"> | undefined {
  if (kind === "priority") {
    const selected = observedOptions(
      projected.optionIds,
      raw.defaultOptionId === null ? null : projected.defaultOptionId,
    );
    return selected === undefined || typeof projected.defaultScheme !== "boolean"
      ? undefined
      : { ...selected, defaultScheme: projected.defaultScheme };
  }
  const types = asArray(projected.issueTypes);
  return observedOptions(
    types?.map((item) => asRecord(item)?.id),
    raw.defaultIssueType === null ? null : asRecord(projected.defaultIssueType)?.id,
  );
}
/** Completes the existing native projector with strict review evidence, without treating omitted
 * description/default/option facts as null, empty or inferred configuration. */
export function jiraOptionSchemeReview(
  kind: SchemeKind,
  raw: Record<string, unknown>,
  projected: CatalogJsonObject | undefined,
): SchemeSnapshot | undefined {
  if (projected === undefined || !jiraNativeId(projected.id) || !savedName(projected.name))
    return undefined;
  if (raw.description !== null && !savedText(raw.description, 32768, true)) return undefined;
  const selected = options(kind, raw, projected);
  return selected === undefined
    ? undefined
    : { id: projected.id, name: projected.name, description: raw.description, ...selected };
}
export function jiraOptionSchemeReviewFields(
  kind: SchemeKind,
  snapshot: SchemeSnapshot | undefined,
): CatalogJsonObject {
  if (snapshot === undefined) return { reviewSnapshotAvailable: false };
  const common = { id: snapshot.id, name: snapshot.name, description: snapshot.description };
  if (kind === "priority") {
    if (typeof snapshot.defaultScheme !== "boolean") return { reviewSnapshotAvailable: false };
    return {
      reviewSnapshotAvailable: true,
      reviewSnapshot: {
        ...common,
        optionIds: snapshot.ids,
        defaultOptionId: snapshot.defaultId,
        defaultScheme: snapshot.defaultScheme,
      },
    };
  }
  return {
    reviewSnapshotAvailable: true,
    reviewSnapshot: {
      ...common,
      issueTypeIds: snapshot.ids,
      defaultIssueTypeId: snapshot.defaultId,
    },
  };
}
