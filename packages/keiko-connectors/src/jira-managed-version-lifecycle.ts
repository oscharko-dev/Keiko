import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  gateJiraBulkReferenceChange,
  type JiraIssueTemplateSource,
} from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeNumericId } from "./jira-native-values.js";
import {
  readReleaseContext,
  readReleaseCollection,
  reviewedReleaseEntity,
  releaseConflict,
  releaseInvalid,
  releaseReceipt,
  releaseSnapshotMatches,
  releaseUnconfirmed,
  RELEASE_MALFORMED,
  type JiraReleaseMutationAttempt,
  type JiraReleaseMutationReceipt,
  type ReleaseContext,
  type ReleaseEntity,
  type ReleaseFailure,
  type ReleaseObservation,
} from "./jira-release-mutation-values.js";
import {
  versionLifecycleInput,
  type JiraVersionLifecycleName,
  type VersionLifecycleInput,
  type VersionMoveInput,
} from "./jira-version-lifecycle-inputs.js";

export function isJiraVersionLifecycleMutation(name: string): name is JiraVersionLifecycleName {
  return (
    name === "jira.merge-version" ||
    name === "jira.move-version" ||
    name === "jira.remove-and-swap-version"
  );
}
function sameIds(items: readonly ReleaseEntity[], ids: readonly string[]): boolean {
  return items.length === ids.length && items.every((item, index) => item.id === ids[index]);
}
function versionField(raw: unknown, id: string): boolean {
  const field = asRecord(raw);
  const schema = asRecord(field?.schema);
  if (field?.id !== `customfield_${id}` || schema === undefined) return false;
  if (
    schema.customId !== undefined &&
    schema.customId !== null &&
    jiraNativeNumericId(schema.customId) !== id
  )
    return false;
  return schema.type === "version" || (schema.type === "array" && schema.items === "version");
}
function uniqueVersionField(items: readonly unknown[], id: string): boolean {
  const matching = items.filter((raw) => asRecord(raw)?.id === `customfield_${id}`);
  return matching.length === 1 && versionField(matching[0], id);
}
async function customFields(
  request: JiraMutationRequest,
  selected: VersionLifecycleInput,
): Promise<ReleaseFailure | undefined> {
  if (selected.kind !== "swap" || selected.customFieldIds.length === 0) return undefined;
  const response = await request("field", "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return RELEASE_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const items = response.items;
  return selected.customFieldIds.every((id) => uniqueVersionField(items, id))
    ? undefined
    : releaseConflict(
        "A reviewed replacement field is not an independently observed native version field. Nothing was written.",
      );
}
async function reviewed(
  request: JiraMutationRequest,
  selected: VersionLifecycleInput,
  context: ReleaseContext,
): Promise<ReleaseObservation<readonly ReleaseEntity[]>> {
  const source = await reviewedReleaseEntity(
    request,
    "version",
    selected.selected.id,
    selected.selected.snapshot,
    context,
  );
  if (!source.ok) return source;
  for (const target of selected.targets) {
    const current = await reviewedReleaseEntity(
      request,
      "version",
      target.id,
      target.snapshot,
      context,
    );
    if (!current.ok) return current;
  }
  const fields = await customFields(request, selected);
  if (fields !== undefined) return fields;
  if (selected.kind !== "move") return { ok: true, value: [] };
  const versions = await readReleaseCollection(request, "version", context);
  if (!versions.ok) return versions;
  const current = versions.value.find((item) => item.id === selected.selected.id);
  if (
    !sameIds(versions.value, selected.expectedIds) ||
    current === undefined ||
    !releaseSnapshotMatches(current.snapshot, selected.selected.snapshot)
  )
    return releaseConflict(
      "The full native project version order or selected version metadata changed after review. Nothing was written.",
    );
  return versions;
}
function receiptFor(
  selected: VersionLifecycleInput,
  context: ReleaseContext,
): JiraReleaseMutationReceipt {
  const receipt = releaseReceipt("version", selected.selected, context);
  if (selected.kind === "merge") return { ...receipt, targetVersionId: selected.targetId };
  if (selected.kind === "swap")
    return {
      ...receipt,
      replacementVersionIds: Object.freeze(selected.targets.map((target) => target.id)),
    };
  return receipt;
}
function confirmMove(
  selected: VersionMoveInput,
  before: readonly ReleaseEntity[],
  after: readonly ReleaseEntity[],
  receipt: JiraReleaseMutationReceipt,
): JiraReleaseMutationAttempt {
  const previous = new Map(before.map((item) => [item.id, item.snapshot]));
  const metadataUnchanged = after.every((item) => {
    const snapshot = previous.get(item.id);
    return snapshot !== undefined && releaseSnapshotMatches(item.snapshot, snapshot);
  });
  return sameIds(after, selected.desiredIds) && metadataUnchanged
    ? { ok: true, receipt }
    : releaseUnconfirmed(
        "The complete native project version order and metadata did not independently match the requested move. Retain the known version ID; do not repeat the move automatically.",
        receipt,
      );
}
function confirmRemoval(
  selected: VersionLifecycleInput,
  after: readonly ReleaseEntity[],
  receipt: JiraReleaseMutationReceipt,
): ReleaseFailure {
  const sourceAbsent = !after.some((item) => item.id === selected.selected.id);
  const targetsMatch = selected.targets.every((target) =>
    after.some(
      (item) => item.id === target.id && releaseSnapshotMatches(item.snapshot, target.snapshot),
    ),
  );
  if (!sourceAbsent || !targetsMatch)
    return releaseUnconfirmed(
      "The removed version or its exact replacement metadata could not be independently established in the complete same-project collection. Do not replay or infer issue-reference reassignment.",
      receipt,
    );
  return releaseUnconfirmed(
    "The source version is absent and reviewed replacements remain visible under the same project. This does not establish every affected issue, fix-version or custom-field reference. The complete removal/reassignment result remains unconfirmed; do not replay.",
    receipt,
  );
}
async function confirm(
  request: JiraMutationRequest,
  selected: VersionLifecycleInput,
  before: readonly ReleaseEntity[],
  receipt: JiraReleaseMutationReceipt,
): Promise<JiraReleaseMutationAttempt> {
  try {
    const context = await readReleaseContext(request, selected.selected);
    if (!context.ok) return { ...context, receipt };
    const after = await readReleaseCollection(request, "version", context.value);
    if (!after.ok) return { ...after, receipt };
    return selected.kind === "move"
      ? confirmMove(selected, before, after.value, receipt)
      : confirmRemoval(selected, after.value, receipt);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
function dispatch(
  request: JiraMutationRequest,
  selected: VersionLifecycleInput,
): ReturnType<JiraMutationRequest> {
  const root = `version/${selected.selected.id}`;
  if (selected.kind === "merge")
    return request(`${root}/mergeto/${selected.targetId}`, "PUT", undefined, "none");
  const path = selected.kind === "move" ? `${root}/move` : `${root}/removeAndSwap`;
  return request(path, "POST", selected.body, "none");
}
async function dispatchAndConfirm(
  request: JiraMutationRequest,
  selected: VersionLifecycleInput,
  before: readonly ReleaseEntity[],
  receipt: JiraReleaseMutationReceipt,
): Promise<JiraReleaseMutationAttempt> {
  const response = await dispatch(request, selected);
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...RELEASE_MALFORMED, receipt };
  return confirm(request, selected, before, receipt);
}
/** VersionResource 11.3.3: move uses native position or a server-minted URI; merge/removeAndSwap
 * also mutate issue references, so collection absence alone never produces a success receipt.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/issue/VersionResource.html
 */
export async function executeJiraVersionLifecycleMutation(
  name: JiraVersionLifecycleName,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  templates?: JiraIssueTemplateSource,
  baseUrl?: string,
): Promise<JiraReleaseMutationAttempt> {
  const selected = versionLifecycleInput(name, args, baseUrl);
  if (selected === undefined)
    return releaseInvalid(
      "Review the exact actor, project, version metadata and every replacement. Moves require the complete ordered version IDs and exactly one supported position or same-project afterVersionId. Replacement body IDs must be exact safe JSON integers. Nothing was written.",
    );
  const context = await readReleaseContext(request, selected.selected);
  if (!context.ok) return context;
  const before = await reviewed(request, selected, context.value);
  if (!before.ok) return before;
  if (selected.kind !== "move") {
    const gate = await gateJiraBulkReferenceChange({
      request,
      source: templates,
      projectKey: context.value.projectKey,
      kind: "version",
    });
    if (!gate.ok)
      return {
        ...gate,
        detail: {
          messages: [
            "The complete effect of this bulk version change on saved formal issue rules cannot be established. Nothing was written. Correct affected fix-version, affected-version and custom-field references through governed jira.edit; this bulk operation remains unavailable while matching formal rules require those fields. Repair unreadable rules before continuing.",
          ],
        },
      };
  }
  const receipt = receiptFor(selected, context.value);
  if (selected.kind === "move" && sameIds(before.value, selected.desiredIds))
    return {
      ...releaseConflict(
        "The complete native project version order already matches the requested move. Nothing was written.",
      ),
      detail: { unchanged: true },
      receipt,
    };
  if (check) return { ok: true, receipt: {} };
  return dispatchAndConfirm(request, selected, before.value, receipt);
}
