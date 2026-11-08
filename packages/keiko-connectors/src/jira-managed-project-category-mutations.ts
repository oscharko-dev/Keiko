import {
  type JiraProjectCategoryMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraCoreMetadataProjection } from "./jira-core-metadata-values.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import {
  readSavedActor,
  savedExactKeys,
  savedName,
  savedText,
} from "./jira-saved-configuration-values.js";

type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
type Observation<T> = Failure | { readonly ok: true; readonly value: T };
interface Category {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
interface Selection {
  readonly operation: JiraProjectCategoryMutation;
  readonly actor: string;
  readonly expected?: Category;
  readonly target?: Pick<Category, "name" | "description">;
}
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const CREATE_KEYS = new Set(["expectedActorKey", "name", "description"]);
const UPDATE_KEYS = new Set([...CREATE_KEYS, "expectedCategory"]);
const DELETE_KEYS = new Set(["expectedActorKey", "expectedCategory", "confirmUnverifiedDeletion"]);
const SNAPSHOT_KEYS = new Set(["id", "name", "description"]);
function refusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: JiraMutationReceipt,
): Failure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
/** Missing/null native descriptions are unavailable review evidence, never an empty string. */
function category(value: unknown): Category | undefined {
  const projected = jiraCoreMetadataProjection("project-category", value);
  return projected !== undefined &&
    jiraNativeId(projected.id) &&
    savedName(projected.name) &&
    savedText(projected.description, 32768, true)
    ? { id: projected.id, name: projected.name, description: projected.description }
    : undefined;
}
function expectedCategory(value: unknown): Category | undefined {
  const raw = asRecord(value);
  return raw !== undefined &&
    savedExactKeys(raw, SNAPSHOT_KEYS) &&
    Object.keys(raw).length === SNAPSHOT_KEYS.size
    ? category(raw)
    : undefined;
}
function inputKeys(operation: JiraProjectCategoryMutation): ReadonlySet<string> {
  if (operation === "jira.create-project-category") return CREATE_KEYS;
  return operation === "jira.update-project-category" ? UPDATE_KEYS : DELETE_KEYS;
}
function categoryTarget(
  args: CatalogJsonObject,
): Pick<Category, "name" | "description"> | undefined {
  if (!savedName(args.name) || !savedText(args.description, 32768, true)) return undefined;
  return { name: args.name, description: args.description };
}
function selection(
  operation: JiraProjectCategoryMutation,
  args: CatalogJsonObject,
): Selection | undefined {
  if (!savedExactKeys(args, inputKeys(operation)) || !savedText(args.expectedActorKey, 255))
    return undefined;
  const base = { operation, actor: args.expectedActorKey };
  if (operation === "jira.create-project-category") {
    const target = categoryTarget(args);
    return target === undefined ? undefined : { ...base, target };
  }
  const expected = expectedCategory(args.expectedCategory);
  if (expected === undefined) return undefined;
  if (operation === "jira.delete-project-category")
    return args.confirmUnverifiedDeletion === true ? { ...base, expected } : undefined;
  const target = categoryTarget(args);
  return target === undefined ? undefined : { ...base, expected, target };
}
function sameCategory(left: Category, right: Category): boolean {
  return left.id === right.id && left.name === right.name && left.description === right.description;
}
async function readCategory(
  request: JiraMutationRequest,
  id: string,
): Promise<Observation<Category>> {
  const response = await request(`projectCategory/${id}`);
  if (!response.ok) return dispatchFailure(response);
  const value = response.status === 200 ? category(response.body) : undefined;
  return value?.id === id ? { ok: true, value } : MALFORMED;
}
async function readCategories(
  request: JiraMutationRequest,
): Promise<Observation<readonly CatalogJsonObject[]>> {
  const response = await request("projectCategory", "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const values = projectJiraCollection(
    response.items,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    (value) => jiraCoreMetadataProjection("project-category", value),
    "id",
  );
  // Collection identity/name evidence is sufficient for duplicate-name checks and observing
  // visibility. Unrelated categories with absent descriptions do not become empty descriptions.
  return values === undefined ? MALFORMED : { ok: true, value: values };
}
async function admission(
  request: JiraMutationRequest,
  input: Selection,
): Promise<Failure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  if (input.expected !== undefined) {
    const current = await readCategory(request, input.expected.id);
    if (!current.ok) return current;
    if (!sameCategory(current.value, input.expected))
      return refusal(
        "The reviewed category changed. Review its exact current name and description before writing.",
        "conflict",
      );
    if (
      input.target !== undefined &&
      sameCategory(current.value, { ...input.target, id: current.value.id })
    )
      return {
        ...refusal("The category already has the requested name and description.", "conflict", {
          categoryId: current.value.id,
          userKey: input.actor,
          categoryPresent: true,
        }),
        detail: {
          unchanged: true,
          messages: ["The requested category metadata is already present. Nothing was written."],
        },
      };
    return undefined;
  }
  const current = await readCategories(request);
  if (!current.ok) return current;
  return current.value.some((value) => value.name === input.target?.name)
    ? refusal(
        "A visible category already uses this exact name. Inspect it before creating another category.",
        "conflict",
      )
    : undefined;
}
function knownReceipt(input: Selection, id: string): JiraMutationReceipt {
  return {
    categoryId: id,
    userKey: input.actor,
    categoryPresent: input.operation !== "jira.delete-project-category",
  };
}
async function confirm(
  request: JiraMutationRequest,
  input: Selection,
  receipt: JiraMutationReceipt,
  id: string,
): Promise<JiraMutationAttempt> {
  try {
    const actor = await readSavedActor(request, input.actor);
    if (!actor.ok) return { ...actor, receipt };
    if (input.operation === "jira.delete-project-category") {
      // A selected404 also means permission loss. A global list has no independent parent
      // proving every category/project association effect, so never assert complete deletion.
      const list = await readCategories(request);
      if (!list.ok) return { ...list, receipt };
      return refusal(
        list.value.some((value) => value.id === id)
          ? "Jira acknowledged deletion, but the category is still visible. Inspect the known ID; do not replay deletion."
          : "Jira acknowledged deletion and the category is absent from the returned visible list. This cannot independently prove every deletion or project-association effect. The result remains unconfirmed; do not replay deletion.",
        "unavailable",
        receipt,
      );
    }
    const current = await readCategory(request, id);
    if (!current.ok) return { ...current, receipt };
    return input.target !== undefined && sameCategory(current.value, { ...input.target, id })
      ? { ok: true, receipt }
      : refusal(
          "Jira acknowledged the category change, but independent native metadata does not match the requested result. Keep the known ID and do not replay this write.",
          "unavailable",
          receipt,
        );
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
interface Effect {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body?: Pick<Category, "name" | "description">;
  readonly expect: "none" | "json";
  readonly status: number;
}
function effect(input: Selection): Effect | undefined {
  if (input.operation === "jira.create-project-category")
    return input.target === undefined
      ? undefined
      : {
          path: "projectCategory",
          method: "POST",
          body: input.target,
          expect: "json",
          status: 201,
        };
  if (input.expected === undefined) return undefined;
  const path = `projectCategory/${input.expected.id}`;
  if (input.operation === "jira.delete-project-category")
    return { path, method: "DELETE", expect: "none", status: 204 };
  return input.target === undefined
    ? undefined
    : { path, method: "PUT", body: input.target, expect: "json", status: 200 };
}
async function write(request: JiraMutationRequest, input: Selection): Promise<JiraMutationAttempt> {
  const native = effect(input);
  if (native === undefined) return MALFORMED;
  const receipt =
    input.expected === undefined ? {} : { receipt: knownReceipt(input, input.expected.id) };
  const response = await request(native.path, native.method, native.body, native.expect);
  if (!response.ok) return { ...dispatchFailure(response), ...receipt };
  if (response.status !== native.status) return { ...MALFORMED, ...receipt };
  const actualId: unknown = input.expected?.id ?? response.body?.id;
  if (!jiraNativeId(actualId)) return MALFORMED;
  // The ACK's exact ID survives a missing/malformed ACK description. Only a fresh native
  // read can establish the resulting name/description; response self URLs never retarget it.
  const known = knownReceipt(input, actualId);
  return confirm(request, input, known, actualId);
}
export { isJiraProjectCategoryMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
/** Native ProjectCategoryResource: global admin is required independently of the local admin grant.
 * PUT's provided name/description override; no absent description is inferred or sent as null.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/issue/ProjectCategoryResource.html
 */
export async function executeJiraProjectCategoryMutation(
  operation: JiraProjectCategoryMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraMutationAttempt> {
  const input = selection(operation, args);
  if (input === undefined)
    return refusal(
      "Review the connected actor and exact category name/description. Update/deletion require the complete observed category snapshot; missing/null descriptions are unavailable, never empty. Deletion also requires explicit acceptance that its complete effect cannot be independently confirmed.",
    );
  const refused = await admission(request, input);
  if (refused !== undefined) return refused;
  return check ? { ok: true, receipt: {} } : write(request, input);
}
