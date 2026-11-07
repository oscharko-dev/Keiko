import type {
  JiraMutationAttempt,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { asRecord } from "./atlassian-sync-classify.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { agileDate, agileId, agileIssueKey } from "./jira-agile-projection.js";

export type AgileFailure = Extract<JiraMutationAttempt, { ok: false }>;
export const AGILE_MALFORMED: AgileFailure = { ok: false, reason: "malformed-payload" };
export const AGILE_CONFLICT: AgileFailure = { ok: false, reason: "conflict" };
export type AgileEntity =
  { readonly ok: true; readonly item: CatalogJsonObject & { readonly id: string } } | AgileFailure;
export type AgileProjection = (value: unknown) => CatalogJsonObject | undefined;
export function agileEntityReceipt(
  item: CatalogJsonObject,
  sprint: boolean,
): JiraMutationReceipt | undefined {
  if (sprint) {
    const sprintId = agileId(item.id);
    return sprintId === undefined ? undefined : { sprintId };
  }
  return agileIssueKey(item.key) ? { epicKey: item.key } : undefined;
}

export async function readAgileEntity(
  request: JiraMutationRequest,
  path: string,
  project: AgileProjection,
  identity: string,
): Promise<AgileEntity> {
  const response = await request(path);
  if (!response.ok) return dispatchFailure(response);
  const item = response.status === 200 ? project(response.body) : undefined;
  if (
    item === undefined ||
    typeof item.id !== "string" ||
    (item.id !== identity && item.key !== identity)
  )
    return AGILE_MALFORMED;
  return { ok: true, item: { ...item, id: item.id } };
}
function expectedGoal(expected: CatalogJsonValue, observed: CatalogJsonValue | undefined): boolean {
  return expected === ""
    ? observed === undefined || observed === null || observed === ""
    : expected === observed;
}
function expectedField(
  key: string,
  expected: CatalogJsonValue,
  observed: CatalogJsonValue | undefined,
): boolean {
  if (key === "goal") return expectedGoal(expected, observed);
  if (key === "originBoardId" || key === "filterId") return agileId(expected) === observed;
  if (key === "color") return asRecord(expected)?.key === observed;
  if (key === "startDate" || key === "endDate")
    return (
      agileDate(expected) && agileDate(observed) && Date.parse(expected) === Date.parse(observed)
    );
  return expected === observed;
}
export function agileFieldsMatch(
  expected: CatalogJsonObject,
  observed: CatalogJsonObject,
): boolean {
  return Object.entries(expected).every(([key, value]) => expectedField(key, value, observed[key]));
}
export async function confirmAgileEntity(
  request: JiraMutationRequest,
  path: string,
  project: AgileProjection,
  identity: string,
  expected: CatalogJsonObject,
  receipt: JiraMutationReceipt,
): Promise<JiraMutationAttempt> {
  const current = await readAgileEntity(request, path, project, identity);
  if (!current.ok) return { ...current, receipt };
  return agileFieldsMatch(expected, current.item)
    ? { ok: true, receipt }
    : { ...AGILE_CONFLICT, receipt };
}
