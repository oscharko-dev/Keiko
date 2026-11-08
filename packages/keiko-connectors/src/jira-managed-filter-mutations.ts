import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import { filterPermissionMatches } from "./jira-filter-permission-values.js";
import {
  readOwnedFilter,
  readSavedActor,
  readSavedPermissions,
  readSavedShareScope,
  sameSavedFilter,
  savedConflict,
  savedExactKeys,
  savedInvalid,
  savedName,
  savedShareScope,
  savedText,
  savedUnchanged,
  savedUnconfirmed,
  SAVED_MALFORMED,
  type DefaultShareScope,
  type JiraSavedConfigurationAttempt,
  type JiraSavedConfigurationReceipt,
  type SavedFilter,
  type SavedObservation,
} from "./jira-saved-configuration-values.js";

const OPERATIONS = [
  "jira.create-filter",
  "jira.update-filter",
  "jira.delete-filter",
  "jira.set-filter-share-scope",
] as const;
type FilterMutation = (typeof OPERATIONS)[number];
interface CreateInput {
  readonly actorKey: string;
  readonly scope: DefaultShareScope;
  readonly name: string;
  readonly jql: string;
  readonly description?: string;
}
interface ExistingInput {
  readonly expected: SavedFilter;
  readonly changes: Readonly<Partial<Pick<SavedFilter, "name" | "jql" | "description">>>;
}
const CREATE_FIELDS = new Set([
  "expectedActorKey",
  "expectedDefaultShareScope",
  "acceptDefaultSharing",
  "name",
  "jql",
  "description",
]);
const EXISTING_FIELDS = new Set([
  "filterId",
  "expectedOwnerKey",
  "expectedName",
  "expectedJql",
  "expectedDescription",
  "name",
  "jql",
  "description",
]);
const SCOPE_FIELDS = new Set(["expectedActorKey", "expectedScope", "scope"]);
function createInput(args: CatalogJsonObject): CreateInput | undefined {
  if (!savedExactKeys(args, CREATE_FIELDS) || args.acceptDefaultSharing !== true) return undefined;
  if (!savedText(args.expectedActorKey, 255) || !savedShareScope(args.expectedDefaultShareScope))
    return undefined;
  if (!savedName(args.name) || !savedText(args.jql, 2048)) return undefined;
  if (args.description !== undefined && !savedText(args.description, 32768, true)) return undefined;
  return {
    actorKey: args.expectedActorKey,
    scope: args.expectedDefaultShareScope,
    name: args.name,
    jql: args.jql,
    ...(args.description === undefined ? {} : { description: args.description }),
  };
}
function expectedFilter(args: CatalogJsonObject): SavedFilter | undefined {
  if (!jiraNativeId(args.filterId) || !savedText(args.expectedOwnerKey, 255)) return undefined;
  if (!savedName(args.expectedName) || !savedText(args.expectedJql, 2048)) return undefined;
  if (args.expectedDescription !== null && !savedText(args.expectedDescription, 32768, true))
    return undefined;
  return {
    id: args.filterId,
    ownerKey: args.expectedOwnerKey,
    name: args.expectedName,
    jql: args.expectedJql,
    description: args.expectedDescription,
  };
}
function filterChanges(args: CatalogJsonObject): ExistingInput["changes"] | undefined {
  if (args.name !== undefined && !savedName(args.name)) return undefined;
  if (args.jql !== undefined && !savedText(args.jql, 2048)) return undefined;
  if (args.description !== undefined && !savedText(args.description, 32768, true)) return undefined;
  return {
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.jql === undefined ? {} : { jql: args.jql }),
    ...(args.description === undefined ? {} : { description: args.description }),
  };
}
function existingInput(
  operation: FilterMutation,
  args: CatalogJsonObject,
): ExistingInput | undefined {
  if (!savedExactKeys(args, EXISTING_FIELDS)) return undefined;
  const expected = expectedFilter(args);
  const changes = filterChanges(args);
  if (expected === undefined || changes === undefined) return undefined;
  const changed = Object.keys(changes).length > 0;
  return changed === (operation === "jira.update-filter") ? { expected, changes } : undefined;
}
async function preflightFilter(
  request: JiraMutationRequest,
  expected: SavedFilter,
): Promise<SavedObservation<SavedFilter>> {
  const actor = await readSavedActor(request, expected.ownerKey);
  if (!actor.ok) return actor;
  const current = await readOwnedFilter(request, expected.id, actor.value.key);
  if (!current.ok) return current;
  return sameSavedFilter(current.value, expected)
    ? current
    : savedConflict(
        "The filter metadata changed after review. Read and review its current name, JQL, description and owner before requesting this change. Nothing was written.",
      );
}
async function confirmExisting(
  request: JiraMutationRequest,
  target: SavedFilter,
  remove: boolean,
  receipt: JiraSavedConfigurationReceipt,
): Promise<JiraSavedConfigurationAttempt> {
  try {
    const actor = await readSavedActor(request, target.ownerKey);
    if (!actor.ok) return { ...actor, receipt };
    const current = await readOwnedFilter(request, target.id, target.ownerKey);
    // Favourite filters are not a complete collection of owned filters. Neither their absence nor
    // this selected GET's 404 independently proves deletion of the reviewed filter.
    if (remove)
      return savedUnconfirmed(
        "Jira acknowledged the filter deletion. Its API provides no complete owned-filter collection to prove removal; an inaccessible selected filter is not absence evidence. The filter ID is retained. Do not replay.",
        receipt,
      );
    if (!current.ok) return { ...current, receipt };
    return sameSavedFilter(current.value, target)
      ? { ok: true, receipt }
      : savedUnconfirmed(
          "The independent filter read did not match the requested metadata. The known filter ID is retained and this write must not be replayed.",
          receipt,
        );
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
async function sendExisting(
  request: JiraMutationRequest,
  target: SavedFilter,
  changes: ExistingInput["changes"] | undefined,
  receipt: JiraSavedConfigurationReceipt,
): Promise<JiraSavedConfigurationAttempt> {
  const remove = changes === undefined;
  const response = await request(`filter/${target.id}`, remove ? "DELETE" : "PUT", changes, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...SAVED_MALFORMED, receipt };
  return confirmExisting(request, target, remove, receipt);
}
async function changeExisting(
  operation: FilterMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check: boolean,
): Promise<JiraSavedConfigurationAttempt> {
  const selected = existingInput(operation, args);
  if (selected === undefined)
    return savedInvalid(
      "Review the filter ID, owner key, name, JQL and description (null means not supplied). Update supports only name, JQL and description; deletion accepts no new metadata. Nothing was written.",
    );
  const prior = await preflightFilter(request, selected.expected);
  if (!prior.ok) return prior;
  const target = { ...prior.value, ...selected.changes };
  const receipt = { filterId: target.id, userKey: target.ownerKey };
  const remove = operation === "jira.delete-filter";
  if (!remove && sameSavedFilter(prior.value, target))
    return savedUnchanged(
      "The filter already has the requested metadata. Nothing was written.",
      receipt,
    );
  if (check) return { ok: true, receipt: {} };
  return sendExisting(request, target, remove ? undefined : selected.changes, receipt);
}
async function createAdmission(
  request: JiraMutationRequest,
  selected: CreateInput,
): Promise<SavedObservation<DefaultShareScope>> {
  const actor = await readSavedActor(request, selected.actorKey);
  if (!actor.ok) return actor;
  const scope = await readSavedShareScope(request);
  if (!scope.ok) return scope;
  return scope.value === selected.scope
    ? scope
    : savedConflict(
        "The native default sharing scope changed after review. Review the new scope before creating a filter. Nothing was written.",
      );
}
function matchingDefaultPermissions(
  scope: DefaultShareScope,
  permissions: readonly CatalogJsonObject[],
): boolean {
  if (scope === "PRIVATE") return permissions.length === 0;
  if (permissions.length !== 1) return false;
  const permission = permissions[0];
  return (
    permission !== undefined &&
    filterPermissionMatches(permission, {
      type: scope === "GLOBAL" ? "global" : "authenticated",
      view: true,
      edit: false,
    })
  );
}
async function confirmCreated(
  request: JiraMutationRequest,
  selected: CreateInput,
  receipt: JiraSavedConfigurationReceipt,
): Promise<JiraSavedConfigurationAttempt> {
  try {
    if (receipt.filterId === undefined) return { ...SAVED_MALFORMED, receipt };
    const actor = await readSavedActor(request, selected.actorKey);
    if (!actor.ok) return { ...actor, receipt };
    const current = await readOwnedFilter(request, receipt.filterId, selected.actorKey);
    if (!current.ok) return { ...current, receipt };
    const expected: SavedFilter = {
      id: receipt.filterId,
      ownerKey: selected.actorKey,
      name: selected.name,
      jql: selected.jql,
      description: selected.description ?? current.value.description,
    };
    if (!sameSavedFilter(current.value, expected))
      return savedUnconfirmed(
        "The new filter's independent metadata did not match the reviewed creation. Its known ID is retained. Do not replay.",
        receipt,
      );
    const permissions = await readSavedPermissions(request, receipt.filterId);
    if (!permissions.ok) return { ...permissions, receipt };
    if (!matchingDefaultPermissions(selected.scope, permissions.value))
      return savedUnconfirmed(
        "The filter's actual sharing did not match the reviewed default scope. Jira does not atomically bind creation to the observed default. The known filter ID is retained; inspect its permissions and do not replay creation.",
        receipt,
      );
    return { ok: true, receipt: { ...receipt, observedShareScope: selected.scope } };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
async function sendCreate(
  request: JiraMutationRequest,
  selected: CreateInput,
): Promise<JiraSavedConfigurationAttempt> {
  const response = await request(
    "filter",
    "POST",
    {
      name: selected.name,
      jql: selected.jql,
      ...(selected.description === undefined ? {} : { description: selected.description }),
    },
    "json",
  );
  if (!response.ok) return dispatchFailure(response);
  const receipt: JiraSavedConfigurationReceipt = {
    userKey: selected.actorKey,
    defaultSharingAtomic: false,
    ...(jiraNativeId(response.body?.id) ? { filterId: response.body.id } : {}),
  };
  if (response.status < 200 || response.status >= 300 || receipt.filterId === undefined)
    return { ...SAVED_MALFORMED, receipt };
  return confirmCreated(request, selected, receipt);
}
async function create(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check: boolean,
): Promise<JiraSavedConfigurationAttempt> {
  const selected = createInput(args);
  if (selected === undefined)
    return savedInvalid(
      "Creating a filter requires reviewed current-user identity, acceptDefaultSharing:true and the observed default sharing scope, plus name and JQL. Jira does not support an atomic private-sharing override on this endpoint.",
    );
  const prior = await createAdmission(request, selected);
  if (!prior.ok) return prior;
  if (check) return { ok: true, receipt: {} };
  // Repeat the exact actor/default checks immediately before the single POST. This reduces a race,
  // but is deliberately not represented as an atomic guarantee or a private-start override.
  const rebound = await createAdmission(request, selected);
  if (!rebound.ok) return rebound;
  return sendCreate(request, selected);
}
async function confirmScope(
  request: JiraMutationRequest,
  key: string,
  scope: DefaultShareScope,
  receipt: JiraSavedConfigurationReceipt,
): Promise<JiraSavedConfigurationAttempt> {
  try {
    const actor = await readSavedActor(request, key);
    if (!actor.ok) return { ...actor, receipt };
    const observed = await readSavedShareScope(request);
    if (!observed.ok) return { ...observed, receipt };
    return observed.value === scope
      ? { ok: true, receipt: { ...receipt, observedShareScope: observed.value } }
      : savedUnconfirmed(
          "The independent default-sharing read did not match the requested scope. Do not replay the change.",
          receipt,
        );
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
function scopeReviewed(
  args: CatalogJsonObject,
): { readonly actorKey: string; readonly expectedScope: DefaultShareScope } | undefined {
  if (
    !savedExactKeys(args, SCOPE_FIELDS) ||
    !savedText(args.expectedActorKey, 255) ||
    !savedShareScope(args.expectedScope)
  )
    return undefined;
  return { actorKey: args.expectedActorKey, expectedScope: args.expectedScope };
}
async function sendScope(
  request: JiraMutationRequest,
  actorKey: string,
  scope: "PRIVATE" | "AUTHENTICATED",
  receipt: JiraSavedConfigurationReceipt,
): Promise<JiraSavedConfigurationAttempt> {
  const response = await request("filter/defaultShareScope", "PUT", { scope }, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...SAVED_MALFORMED, receipt };
  return confirmScope(request, actorKey, scope, receipt);
}
async function setScope(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check: boolean,
): Promise<JiraSavedConfigurationAttempt> {
  const reviewed = scopeReviewed(args);
  if (reviewed === undefined)
    return savedInvalid(
      "Review the connected user and native current default sharing scope before changing it.",
    );
  const scope = args.scope;
  if (scope !== "PRIVATE" && scope !== "AUTHENTICATED")
    return savedInvalid(
      "The published write endpoint supports only PRIVATE or AUTHENTICATED default sharing. Nothing was written.",
    );
  const actor = await readSavedActor(request, reviewed.actorKey);
  if (!actor.ok) return actor;
  const prior = await readSavedShareScope(request);
  if (!prior.ok) return prior;
  if (prior.value !== reviewed.expectedScope)
    return savedConflict("The default sharing scope changed after review. Nothing was written.");
  const receipt = { userKey: actor.value.key, username: actor.value.name };
  if (prior.value === scope)
    return savedUnchanged("Default sharing already has the requested scope. Nothing was written.", {
      ...receipt,
      observedShareScope: prior.value,
    });
  if (check) return { ok: true, receipt: {} };
  return sendScope(request, reviewed.actorKey, scope, receipt);
}
export function isJiraFilterMutation(name: string): name is FilterMutation {
  return (OPERATIONS as readonly string[]).includes(name);
}
export function executeJiraFilterMutation(
  operation: FilterMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraSavedConfigurationAttempt> {
  if (operation === "jira.create-filter") return create(args, request, check);
  if (operation === "jira.set-filter-share-scope") return setScope(args, request, check);
  return changeExisting(operation, args, request, check);
}
