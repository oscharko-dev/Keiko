import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { projectJiraFilterColumnState } from "./jira-managed-column-reads.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import {
  bindSavedFilterOwner,
  savedConflict,
  savedExactKeys,
  savedText,
  savedUnchanged,
  savedUnconfirmed,
  SAVED_MALFORMED,
  type JiraSavedConfigurationAttempt,
  type JiraSavedConfigurationReceipt,
  type SavedObservation,
} from "./jira-saved-configuration-values.js";

type ColumnMutation = "jira.set-filter-columns" | "jira.reset-filter-columns";
interface ColumnState {
  readonly columns: readonly string[];
  readonly columnConfig: string | null;
}
interface Input {
  readonly filterId: string;
  readonly actorKey: string;
  readonly expected: ColumnState;
  readonly columns?: readonly string[];
}
const FIELDS = new Set([
  "filterId",
  "expectedOwnerKey",
  "expectedColumns",
  "expectedColumnConfig",
  "columns",
]);
const CONFIGURATIONS: ReadonlySet<unknown> = new Set([
  null,
  "SYSTEM",
  "EXPLICIT",
  "FILTER",
  "USER",
  "NONE",
]);
function fieldList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    value.every((field) => savedText(field, 255))
  );
}
function input(operation: ColumnMutation, args: CatalogJsonObject): Input | undefined {
  if (
    !savedExactKeys(args, FIELDS) ||
    !jiraNativeId(args.filterId) ||
    !savedText(args.expectedOwnerKey, 255)
  )
    return undefined;
  if (!fieldList(args.expectedColumns) || !CONFIGURATIONS.has(args.expectedColumnConfig))
    return undefined;
  const configuration = args.expectedColumnConfig;
  if (configuration !== null && typeof configuration !== "string") return undefined;
  const selected = {
    filterId: args.filterId,
    actorKey: args.expectedOwnerKey,
    expected: { columns: args.expectedColumns, columnConfig: configuration },
  };
  const replacement = requestedColumns(operation, args);
  return replacement === undefined ? undefined : { ...selected, ...replacement };
}
function requestedColumns(operation: ColumnMutation, args: CatalogJsonObject): Pick<Input, "columns"> | undefined {
  if (operation === "jira.reset-filter-columns")
    return Object.hasOwn(args, "columns") ? undefined : {};
  return fieldList(args.columns) && args.columns.length > 0
    ? { columns: args.columns }
    : undefined;
}
async function readColumns(
  request: JiraMutationRequest,
  id: string,
): Promise<SavedObservation<ColumnState>> {
  const response = await request(`filter/${id}/columns`, "GET", undefined, "json-object-or-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return SAVED_MALFORMED;
  const state = projectJiraFilterColumnState(response);
  if (!state.ok) return state;
  return state.columns === undefined
    ? { ok: false, reason: "unavailable" }
    : { ok: true, value: { columns: state.columns, columnConfig: state.columnConfig ?? null } };
}
function equalColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}
function noOwnColumns(state: ColumnState): boolean {
  return (
    state.columnConfig === "SYSTEM" ||
    state.columnConfig === "USER" ||
    state.columnConfig === "NONE"
  );
}
function exactOwnColumns(state: ColumnState, columns: readonly string[]): boolean {
  return (
    (state.columnConfig === "FILTER" || state.columnConfig === "EXPLICIT") &&
    equalColumns(state.columns, columns)
  );
}
async function write(
  request: JiraMutationRequest,
  selected: Input,
  receipt: JiraSavedConfigurationReceipt,
): Promise<JiraSavedConfigurationAttempt> {
  // Published JSON overload: FilterResource#setColumns(Long, ColumnsBean), not FormParam.
  // https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/search/FilterResource.html
  const response = await request(
    `filter/${selected.filterId}/columns`,
    selected.columns === undefined ? "DELETE" : "PUT",
    selected.columns === undefined ? undefined : { columns: selected.columns },
    "none",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...SAVED_MALFORMED, receipt };
  return JiraAcknowledgedMutationError.observe(receipt, async () => {
    const bound = await bindSavedFilterOwner(request, selected);
    if (!bound.ok) return { ...bound, receipt };
    const current = await readColumns(request, selected.filterId);
    if (!current.ok) return { ...current, receipt };
    const matches =
      selected.columns === undefined
        ? noOwnColumns(current.value)
        : equalColumns(current.value.columns, selected.columns);
    return matches
      ? { ok: true, receipt }
      : savedUnconfirmed(
          "The independent filter layout did not prove the requested column change. A legacy array alone cannot prove removal of the filter's own layout. The known filter ID is retained; do not replay.",
          receipt,
        );
  });
}
export function isJiraFilterColumnMutation(name: string): name is ColumnMutation {
  return name === "jira.set-filter-columns" || name === "jira.reset-filter-columns";
}
export async function executeJiraFilterColumnMutation(
  operation: ColumnMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraSavedConfigurationAttempt> {
  const current = await bindSavedFilterOwner(
    request,
    input(operation, args),
    readColumns,
    "Review the filter owner, full ordered expectedColumns and expectedColumnConfig (null means native provenance was omitted). Set needs a nonempty ordered columns list. Reset accepts no replacement list. Nothing was written.",
  );
  if (!current.ok) return current;
  const { selected } = current;
  if (
    current.value.columnConfig !== selected.expected.columnConfig ||
    !equalColumns(current.value.columns, selected.expected.columns)
  )
    return savedConflict(
      "The complete filter column layout changed after review. Nothing was written.",
    );
  const receipt = { filterId: selected.filterId, userKey: selected.actorKey };
  const unchanged =
    selected.columns === undefined
      ? noOwnColumns(current.value)
      : exactOwnColumns(current.value, selected.columns);
  if (unchanged)
    return savedUnchanged(
      "The filter columns already have the requested state. Nothing was written.",
      receipt,
    );
  if (check) return { ok: true, receipt: {} };
  return write(request, selected, receipt);
}
