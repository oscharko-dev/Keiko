import {
  isSafeAtlassianConnectorBaseUrl,
  type JiraReleaseLifecycleMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord, atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";
import {
  releaseExactFields,
  releaseNativeNumber,
  releaseSelection,
  releaseSnapshot,
  type ReleaseSelection,
} from "./jira-release-mutation-values.js";

export type JiraVersionLifecycleName = Exclude<
  JiraReleaseLifecycleMutation,
  "jira.delete-component"
>;
export interface VersionReplacement {
  readonly id: string;
  readonly snapshot: CatalogJsonObject;
}
interface Common {
  readonly selected: ReleaseSelection;
  readonly targets: readonly VersionReplacement[];
}
export interface VersionMergeInput extends Common {
  readonly kind: "merge";
  readonly targetId: string;
}
export interface VersionMoveInput extends Common {
  readonly kind: "move";
  readonly expectedIds: readonly string[];
  readonly desiredIds: readonly string[];
  readonly body: CatalogJsonObject;
}
export interface VersionSwapInput extends Common {
  readonly kind: "swap";
  readonly body: CatalogJsonObject;
  readonly customFieldIds: readonly string[];
}
export type VersionLifecycleInput = VersionMergeInput | VersionMoveInput | VersionSwapInput;
const BASE_FIELDS = [
  "versionId",
  "expectedProjectId",
  "expectedActorKey",
  "expectedVersionSnapshot",
];
const MERGE_FIELDS = new Set([...BASE_FIELDS, "moveIssuesTo", "expectedTargetSnapshot"]);
const MOVE_FIELDS = new Set([...BASE_FIELDS, "expectedVersionIds", "position", "afterVersionId"]);
const SWAP_FIELDS = new Set([
  ...BASE_FIELDS,
  "moveFixIssuesTo",
  "moveAffectedIssuesTo",
  "customFieldReplacementList",
  "expectedReplacementVersions",
]);
const POSITIONS = new Set(["First", "Last", "Earlier", "Later"]);

function merge(args: CatalogJsonObject, selected: ReleaseSelection): VersionMergeInput | undefined {
  const snapshot = releaseSnapshot("version", args.expectedTargetSnapshot);
  if (
    !releaseExactFields(args, MERGE_FIELDS) ||
    !jiraNativeId(args.moveIssuesTo) ||
    args.moveIssuesTo === selected.id ||
    snapshot === undefined
  )
    return undefined;
  return {
    kind: "merge",
    selected,
    targetId: args.moveIssuesTo,
    targets: [{ id: args.moveIssuesTo, snapshot }],
  };
}
function versionIds(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > TOOL_CATALOG_LIMITS.maxArrayItems
  )
    return undefined;
  const ids: unknown[] = value;
  if (!ids.every(jiraNativeId)) return undefined;
  return new Set(ids).size === ids.length ? ids : undefined;
}
function positionIndex(position: string, index: number, length: number): number {
  switch (position) {
    case "First":
      return 0;
    case "Last":
      return length - 1;
    case "Earlier":
      return Math.max(0, index - 1);
    default:
      return Math.min(length - 1, index + 1);
  }
}
function afterBody(after: unknown, baseUrl: string | undefined): CatalogJsonObject | undefined {
  if (!jiraNativeId(after) || baseUrl === undefined || !isSafeAtlassianConnectorBaseUrl(baseUrl))
    return undefined;
  return {
    after: atlassianApiUrl(atlassianApiEndpointsFor(baseUrl, "/rest/api/2/"), `version/${after}`),
  };
}
function moveDestination(
  args: CatalogJsonObject,
  selected: ReleaseSelection,
  expectedIds: readonly string[],
  baseUrl: string | undefined,
): { readonly body: CatalogJsonObject; readonly index: number } | undefined {
  if (Object.hasOwn(args, "position")) {
    if (
      Object.hasOwn(args, "afterVersionId") ||
      typeof args.position !== "string" ||
      !POSITIONS.has(args.position)
    )
      return undefined;
    return {
      body: { position: args.position },
      index: positionIndex(args.position, expectedIds.indexOf(selected.id), expectedIds.length),
    };
  }
  const after = args.afterVersionId;
  const body = afterBody(after, baseUrl);
  if (!jiraNativeId(after) || after === selected.id || body === undefined) return undefined;
  const index = expectedIds.filter((id) => id !== selected.id).indexOf(after);
  return index < 0 ? undefined : { body, index: index + 1 };
}
function move(
  args: CatalogJsonObject,
  selected: ReleaseSelection,
  baseUrl: string | undefined,
): VersionMoveInput | undefined {
  if (!releaseExactFields(args, MOVE_FIELDS)) return undefined;
  const expectedIds = versionIds(args.expectedVersionIds);
  if (!expectedIds?.includes(selected.id)) return undefined;
  const desiredIds = expectedIds.filter((id) => id !== selected.id);
  const destination = moveDestination(args, selected, expectedIds, baseUrl);
  if (destination === undefined) return undefined;
  desiredIds.splice(destination.index, 0, selected.id);
  return { kind: "move", selected, targets: [], expectedIds, desiredIds, body: destination.body };
}
function nativeReplacement(value: unknown, selectedId: string): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === selectedId) {
    return undefined;
  }
  return releaseNativeNumber(value);
}
interface CustomReplacements {
  readonly body: readonly CatalogJsonObject[];
  readonly fieldIds: readonly string[];
  readonly targetIds: ReadonlySet<string>;
}
function customReplacement(
  value: unknown,
  selectedId: string,
):
  | { readonly fieldId: string; readonly targetId?: string; readonly body: CatalogJsonObject }
  | undefined {
  const item = asRecord(value);
  if (
    item === undefined ||
    Object.keys(item).length !== 2 ||
    !Object.hasOwn(item, "customFieldId") ||
    !Object.hasOwn(item, "moveTo")
  )
    return undefined;
  if (!jiraNativeId(item.customFieldId)) return undefined;
  const customFieldId = releaseNativeNumber(item.customFieldId);
  const moveTo = nativeReplacement(item.moveTo, selectedId);
  if (customFieldId === undefined || moveTo === undefined) return undefined;
  return {
    fieldId: item.customFieldId,
    body: { customFieldId, moveTo },
    ...(typeof item.moveTo === "string" ? { targetId: item.moveTo } : {}),
  };
}
function customReplacements(value: unknown, selectedId: string): CustomReplacements | undefined {
  if (!Array.isArray(value) || value.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const body: CatalogJsonObject[] = [];
  const fieldIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const raw of value) {
    const item = customReplacement(raw, selectedId);
    if (item === undefined || fieldIds.has(item.fieldId)) return undefined;
    fieldIds.add(item.fieldId);
    if (item.targetId !== undefined) targetIds.add(item.targetId);
    body.push(item.body);
  }
  return { body, fieldIds: [...fieldIds], targetIds };
}
function replacementSnapshot(value: unknown): VersionReplacement | undefined {
  const item = asRecord(value);
  if (
    item === undefined ||
    Object.keys(item).length !== 2 ||
    !Object.hasOwn(item, "versionId") ||
    !Object.hasOwn(item, "expectedVersionSnapshot")
  )
    return undefined;
  if (!jiraNativeId(item.versionId)) return undefined;
  const snapshot = releaseSnapshot("version", item.expectedVersionSnapshot);
  return snapshot === undefined ? undefined : { id: item.versionId, snapshot };
}
function replacementSnapshots(
  value: unknown,
  targetIds: ReadonlySet<string>,
): readonly VersionReplacement[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== targetIds.size ||
    value.length > TOOL_CATALOG_LIMITS.maxArrayItems
  )
    return undefined;
  const seen = new Set<string>();
  const targets: VersionReplacement[] = [];
  for (const raw of value) {
    const item = replacementSnapshot(raw);
    if (item === undefined || !targetIds.has(item.id) || seen.has(item.id)) return undefined;
    seen.add(item.id);
    targets.push(item);
  }
  return targets;
}
function swap(args: CatalogJsonObject, selected: ReleaseSelection): VersionSwapInput | undefined {
  if (!releaseExactFields(args, SWAP_FIELDS)) return undefined;
  const moveFixIssuesTo = nativeReplacement(args.moveFixIssuesTo, selected.id);
  const moveAffectedIssuesTo = nativeReplacement(args.moveAffectedIssuesTo, selected.id);
  const custom = customReplacements(args.customFieldReplacementList, selected.id);
  if (moveFixIssuesTo === undefined || moveAffectedIssuesTo === undefined || custom === undefined)
    return undefined;
  const targetIds = new Set(custom.targetIds);
  if (typeof args.moveFixIssuesTo === "string") targetIds.add(args.moveFixIssuesTo);
  if (typeof args.moveAffectedIssuesTo === "string") targetIds.add(args.moveAffectedIssuesTo);
  const targets = replacementSnapshots(args.expectedReplacementVersions, targetIds);
  return targets === undefined
    ? undefined
    : {
        kind: "swap",
        selected,
        targets,
        customFieldIds: custom.fieldIds,
        body: {
          moveFixIssuesTo,
          moveAffectedIssuesTo,
          customFieldReplacementList: [...custom.body],
        },
      };
}
export function versionLifecycleInput(
  name: JiraVersionLifecycleName,
  args: CatalogJsonObject,
  baseUrl: string | undefined,
): VersionLifecycleInput | undefined {
  const selected = releaseSelection("version", args);
  if (selected === undefined) return undefined;
  switch (name) {
    case "jira.merge-version":
      return merge(args, selected);
    case "jira.move-version":
      return move(args, selected, baseUrl);
    case "jira.remove-and-swap-version":
      return swap(args, selected);
  }
}
