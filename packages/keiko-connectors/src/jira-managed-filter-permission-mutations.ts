import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  projectJiraFilterPermission,
  projectJiraFilterPermissions,
} from "./jira-managed-saved-views.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import {
  bindFilterPermissionRecipient,
  filterPermissionBody,
  filterPermissionMatches,
  filterPermissionSnapshots,
  filterPermissionTarget,
  reviewableFilterPermission,
  sameFilterPermissions,
  type FilterPermissionTarget,
} from "./jira-filter-permission-values.js";
import {
  bindSavedFilterOwner,
  readSavedPermissions,
  savedConflict,
  savedExactKeys,
  savedInvalid,
  savedText,
  savedUnchanged,
  savedUnconfirmed,
  SAVED_MALFORMED,
  type JiraSavedConfigurationAttempt,
  type JiraSavedConfigurationReceipt,
} from "./jira-saved-configuration-values.js";

type PermissionMutation = "jira.add-filter-permission" | "jira.delete-filter-permission";
interface Input {
  readonly filterId: string;
  readonly actorKey: string;
  readonly expected: readonly CatalogJsonObject[];
  readonly target?: FilterPermissionTarget;
  readonly permissionId?: string;
}
const FIELDS = new Set([
  "filterId",
  "expectedOwnerKey",
  "expectedPermissions",
  "permission",
  "permissionId",
  "acceptGlobalReplacement",
]);
function input(operation: PermissionMutation, args: CatalogJsonObject): Input | undefined {
  if (
    !savedExactKeys(args, FIELDS) ||
    !jiraNativeId(args.filterId) ||
    !savedText(args.expectedOwnerKey, 255)
  )
    return undefined;
  const expected = filterPermissionSnapshots(args.expectedPermissions);
  if (expected === undefined) return undefined;
  const base = { filterId: args.filterId, actorKey: args.expectedOwnerKey, expected };
  const replacement = requestedPermission(operation, args);
  return replacement === undefined ? undefined : { ...base, ...replacement };
}
function requestedPermission(operation: PermissionMutation, args: CatalogJsonObject): Pick<Input, "permissionId" | "target"> | undefined {
  if (operation === "jira.delete-filter-permission")
    return jiraNativeId(args.permissionId) &&
      args.permission === undefined &&
      args.acceptGlobalReplacement === undefined
      ? { permissionId: args.permissionId }
      : undefined;
  if (args.permissionId !== undefined) return undefined;
  const target = filterPermissionTarget(args.permission);
  if (target === undefined) return undefined;
  if (
    target.type === "global"
      ? args.acceptGlobalReplacement !== true
      : args.acceptGlobalReplacement !== undefined
  )
    return undefined;
  return { target };
}
function removedPermissionRefusal(
  selected: Input,
  permissions: readonly CatalogJsonObject[],
  receipt: JiraSavedConfigurationReceipt,
): JiraSavedConfigurationAttempt | undefined {
  const permissionId = selected.permissionId;
  if (permissionId === undefined)
    return savedInvalid(
      "Select an exact reviewed permission ID before requesting removal. Nothing was written.",
    );
  return permissions.some((permission) => permission.id === permissionId)
    ? undefined
    : savedUnchanged(
        "The reviewed permission is already absent from the complete owned-filter permission collection. Nothing was written.",
        { ...receipt, permissionId },
      );
}
function existingRecipientRefusal(
  target: FilterPermissionTarget,
  permissions: readonly CatalogJsonObject[],
  receipt: JiraSavedConfigurationReceipt,
): JiraSavedConfigurationAttempt | undefined {
  const existing = permissions.filter((permission) =>
    filterPermissionMatches(permission, target, false),
  );
  if (existing.length === 0) return undefined;
  if (
    existing.length === 1 &&
    existing[0] !== undefined &&
    filterPermissionMatches(existing[0], target)
  ) {
    if (target.type === "global" && permissions.length !== 1) return undefined;
    return savedUnchanged(
      "This exact recipient already has the reviewed requested sharing rights. Nothing was written.",
      {
        ...receipt,
        ...(typeof existing[0].id === "string" ? { permissionId: existing[0].id } : {}),
      },
    );
  }
  return savedConflict(
    "This recipient already has a different or ambiguous permission. Review and remove the exact existing permission before adding a different one. No implicit rights escalation was performed.",
  );
}
function beforeEffect(
  selected: Input,
  permissions: readonly CatalogJsonObject[],
): JiraSavedConfigurationAttempt | undefined {
  const receipt = { filterId: selected.filterId, userKey: selected.actorKey };
  if (!sameFilterPermissions(permissions, selected.expected))
    return savedConflict(
      "The complete filter sharing list changed after review. Review every current permission before changing sharing. Nothing was written.",
    );
  if (!permissions.every(reviewableFilterPermission))
    return savedInvalid(
      "The native sharing list contains an unknown recipient or omitted view/edit rights. Its full effect cannot be reviewed; no sharing permission was changed.",
    );
  return selected.target === undefined
    ? removedPermissionRefusal(selected, permissions, receipt)
    : existingRecipientRefusal(selected.target, permissions, receipt);
}
function changedPermissions(
  selected: Input,
  actual: readonly CatalogJsonObject[],
  receipt: JiraSavedConfigurationReceipt,
): JiraSavedConfigurationAttempt {
  if (selected.target === undefined) {
    const remaining = selected.expected.filter(
      (permission) => permission.id !== selected.permissionId,
    );
    return sameFilterPermissions(actual, remaining)
      ? { ok: true, receipt }
      : savedUnconfirmed(
          "The same-parent complete permission list did not prove removal of only the reviewed permission. Do not replay.",
          receipt,
        );
  }
  const target = selected.target;
  const matches = actual.filter((permission) => filterPermissionMatches(permission, target));
  const added = matches.length === 1 ? matches[0] : undefined;
  if (added === undefined || typeof added.id !== "string")
    return savedUnconfirmed(
      "The actual sharing list does not contain one unambiguous exact recipient and requested rights. Do not replay the change.",
      receipt,
    );
  const retained = actual.filter((permission) => permission.id !== added.id);
  const expectedRetained = target.type === "global" ? [] : selected.expected;
  if (!sameFilterPermissions(retained, expectedRetained))
    return savedUnconfirmed(
      "Other filter permissions changed during the operation. The known permission ID is retained, but the reviewed sharing change is not independently confirmed.",
      { ...receipt, permissionId: added.id },
    );
  return { ok: true, receipt: { ...receipt, permissionId: added.id } };
}
function acknowledgedPermission(
  response: Extract<AtlassianWriteHttpOutcome, { readonly ok: true }>,
  target: FilterPermissionTarget | undefined,
): string | undefined {
  if (target === undefined) return undefined;
  const single = projectJiraFilterPermission(response.body);
  const permissions =
    response.items === undefined
      ? single === undefined
        ? []
        : [single]
      : projectJiraFilterPermissions(response.items);
  if (permissions === undefined) return undefined;
  const matches = permissions.filter((permission) => filterPermissionMatches(permission, target));
  const id = matches.length === 1 ? matches[0]?.id : undefined;
  return typeof id === "string" ? id : undefined;
}
async function write(
  request: JiraMutationRequest,
  selected: Input,
  receipt: JiraSavedConfigurationReceipt,
): Promise<JiraSavedConfigurationAttempt> {
  const path = `filter/${selected.filterId}/permission${selected.permissionId === undefined ? "" : `/${selected.permissionId}`}`;
  const response = await request(
    path,
    selected.target === undefined ? "DELETE" : "POST",
    selected.target === undefined ? undefined : filterPermissionBody(selected.target),
    selected.target === undefined ? "none" : "json-object-or-array",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...SAVED_MALFORMED, receipt };
  const permissionId = acknowledgedPermission(response, selected.target);
  receipt = permissionId === undefined ? receipt : { ...receipt, permissionId };
  return JiraAcknowledgedMutationError.observe(receipt, async () => {
    const rebound = await bindSavedFilterOwner(request, selected);
    if (!rebound.ok) return { ...rebound, receipt };
    if (selected.target !== undefined) {
      const recipient = await bindFilterPermissionRecipient(request, selected.target);
      if (!recipient.ok) return { ...recipient, receipt };
    }
    const current = await readSavedPermissions(request, selected.filterId);
    return current.ok
      ? changedPermissions(selected, current.value, receipt)
      : { ...current, receipt };
  });
}
export function isJiraFilterPermissionMutation(name: string): name is PermissionMutation {
  return name === "jira.add-filter-permission" || name === "jira.delete-filter-permission";
}
export async function executeJiraFilterPermissionMutation(
  operation: PermissionMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraSavedConfigurationAttempt> {
  const current = await bindSavedFilterOwner(
    request,
    input(operation, args),
    readSavedPermissions,
    "Review the owned filter and its complete permission rows. Add uses one closed recipient with explicit view/edit booleans; global requires acceptGlobalReplacement:true because Jira removes all prior shares. Delete names one exact permission ID. Nothing was written.",
  );
  if (!current.ok) return current;
  const { selected } = current;
  const refusal = beforeEffect(selected, current.value);
  if (refusal !== undefined) return refusal;
  if (selected.target !== undefined) {
    const recipient = await bindFilterPermissionRecipient(request, selected.target);
    if (!recipient.ok) return recipient;
  }
  if (check) return { ok: true, receipt: {} };
  const receipt: JiraSavedConfigurationReceipt = {
    filterId: selected.filterId,
    userKey: selected.actorKey,
    ...(selected.permissionId === undefined ? {} : { permissionId: selected.permissionId }),
  };
  return write(request, selected, receipt);
}
