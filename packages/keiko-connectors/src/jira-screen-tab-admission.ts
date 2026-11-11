import {
  isAtlassianConnectorWriteFailureReason,
  sanitizeJiraMutationFailureDetail,
  type JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray } from "./atlassian-sync-classify.js";
import { jiraScreenProjection } from "./jira-configuration-values.js";
import { executeJiraConfigurationRead } from "./jira-managed-configuration-reads.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraScreenFieldProjection, jiraScreenTabProjection } from "./jira-managed-screen-reads.js";
import { dispatchFailure } from "./jira-mutation-failure.js";

type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
type Rows = Failure | { readonly ok: true; readonly items: readonly CatalogJsonObject[] };
export interface JiraScreenTabSelection {
  readonly screenId: string;
  readonly expectedScreenName: string;
}
type ScreenPage = Rows & { readonly nextStartAt?: number; readonly total?: number };
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const CONFLICT: Failure = { ok: false, reason: "conflict" };

async function screenPage(
  request: JiraMutationRequest,
  selected: JiraScreenTabSelection,
  startAt: number,
): Promise<ScreenPage> {
  const result = await executeJiraConfigurationRead(
    "jira.screens",
    {
      search: selected.expectedScreenName,
      startAt,
      maxResults: 100,
    },
    request,
  );
  const data = result.data;
  if (data.outcome !== "succeeded") {
    if (!isAtlassianConnectorWriteFailureReason(data.reason)) return MALFORMED;
    const detail = sanitizeJiraMutationFailureDetail(data);
    return { ok: false, reason: data.reason, ...(detail === undefined ? {} : { detail }) };
  }
  const values = asArray(data.items);
  if (values === undefined) return MALFORMED;
  const items = projectJiraCollection(values, 100, jiraScreenProjection, "id");
  return items === undefined
    ? MALFORMED
    : {
        ok: true,
        items,
        ...(typeof data.nextStartAt === "number" ? { nextStartAt: data.nextStartAt } : {}),
        ...(typeof data.total === "number" ? { total: data.total } : {}),
      };
}
function continuousPage(
  page: Extract<ScreenPage, { ok: true }>,
  seen: Set<string>,
  total: number | undefined,
): Failure | undefined {
  if (total !== undefined && page.total !== total) return CONFLICT;
  for (const item of page.items) {
    if (typeof item.id !== "string" || seen.has(item.id)) return MALFORMED;
    seen.add(item.id);
  }
  return undefined;
}

/** The selected ID/name must occur in a real native screen page; a path argument is not evidence. */
export async function bindJiraScreen(
  request: JiraMutationRequest,
  selected: JiraScreenTabSelection,
): Promise<Failure | { readonly ok: true }> {
  let startAt = 0;
  let total: number | undefined;
  const seen = new Set<string>();
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const page = await screenPage(request, selected, startAt);
    if (!page.ok) return page;
    const failure = continuousPage(page, seen, total);
    if (failure !== undefined) return failure;
    total = page.total;
    const match = page.items.find((item) => item.id === selected.screenId);
    if (match !== undefined)
      return match.name === selected.expectedScreenName ? { ok: true } : CONFLICT;
    if (total !== undefined && startAt + page.items.length >= total)
      return { ok: false, reason: "not-found" };
    if (page.nextStartAt === undefined) return { ok: false, reason: "bounds-exceeded" };
    startAt = page.nextStartAt;
  }
  return { ok: false, reason: "bounds-exceeded" };
}

async function collection(
  request: JiraMutationRequest,
  path: string,
  project: (value: unknown) => CatalogJsonObject | undefined,
): Promise<Rows> {
  const response = await request(path, "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const items = projectJiraCollection(
    response.items,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    project,
    "id",
  );
  return items === undefined ? MALFORMED : { ok: true, items };
}
/** Native complete tab/field arrays are never replaced with a page or a truncated prefix. */
export function readJiraScreenTabs(request: JiraMutationRequest, screenId: string): Promise<Rows> {
  return collection(request, `screens/${screenId}/tabs`, jiraScreenTabProjection);
}
export function readJiraScreenTabFields(
  request: JiraMutationRequest,
  screenId: string,
  tabId: string,
): Promise<Rows> {
  return collection(request, `screens/${screenId}/tabs/${tabId}/fields`, jiraScreenFieldProjection);
}
