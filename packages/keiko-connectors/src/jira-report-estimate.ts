import {
  JIRA_FIELD_ID_PATTERN,
  type JiraReportEstimateUnavailableReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import {
  collectJiraReportMetadataPages,
  type JiraReportFailure,
  type JiraReportRequiredFields,
} from "./jira-report-metadata.js";
import type { JiraReportRequest } from "./jira-report-session.js";
import type { JiraReportFieldCatalogEntry, JiraReportScope } from "./jira-report-types.js";

type Selection = Pick<
  JiraReportScope,
  | "estimateFieldId"
  | "estimateFieldName"
  | "estimateUnit"
  | "estimateSource"
  | "estimateUnavailableReason"
> & { readonly failure?: JiraReportFailure };
const FIELD_ID = new RegExp(JIRA_FIELD_ID_PATTERN, "u");

function unavailable(
  reason: JiraReportEstimateUnavailableReason,
  failure?: JiraReportFailure,
): Selection {
  return {
    estimateUnit: "unavailable",
    estimateSource: "unavailable",
    estimateUnavailableReason: reason,
    ...(failure === undefined ? {} : { failure }),
  };
}
function selected(
  field: JiraReportFieldCatalogEntry,
  source: Exclude<Selection["estimateSource"], undefined | "unavailable">,
): Selection {
  return {
    estimateFieldId: field.id,
    estimateFieldName: field.name,
    estimateSource: source,
    estimateUnit: field.id === "timeoriginalestimate" ? "seconds" : "custom-field",
  };
}
function boardId(value: unknown): string | undefined {
  const id = asRecord(value)?.id;
  const text = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : id;
  return typeof text === "string" && /^[1-9]\d{0,17}$/u.test(text) ? text : undefined;
}
function configuredField(body: Record<string, unknown>): JiraReportFieldCatalogEntry | undefined {
  const estimation = asRecord(body.estimation);
  const field = asRecord(estimation?.field);
  const id = field?.fieldId;
  if (estimation?.type !== "field" || typeof id !== "string" || !FIELD_ID.test(id))
    return undefined;
  const name = field?.displayName;
  return { id, name: typeof name === "string" ? name.slice(0, 200) : id };
}
function boardWithoutEstimate(body: Record<string, unknown>): boolean {
  const estimation = asRecord(body.estimation);
  if (estimation === undefined) return body.type === "kanban";
  return estimation.type === "issueCount" || estimation.type === "none";
}
interface BoardFields {
  readonly fields: readonly JiraReportFieldCatalogEntry[];
  readonly failure?: JiraReportFailure;
}
async function boardFields(http: JiraReportHttp, project: string): Promise<BoardFields> {
  const boards: unknown[] = [];
  const reason = await collectJiraReportMetadataPages(
    { getRecord: http.getAgileRecord },
    `board?projectKeyOrId=${encodeURIComponent(project)}`,
    0,
    boards,
    5000,
  );
  if (reason !== undefined) return { fields: [], failure: reason };
  const fields: JiraReportFieldCatalogEntry[] = [];
  for (const board of boards) {
    const id = boardId(board);
    if (id === undefined) return { fields, failure: "malformed-payload" };
    const outcome = await http.getAgileRecord(`board/${id}/configuration`);
    if (!outcome.ok) return { fields, failure: outcome.reason };
    const field = configuredField(outcome.body);
    if (field !== undefined) fields.push(field);
    else if (!boardWithoutEstimate(outcome.body)) return { fields, failure: "malformed-payload" };
  }
  return { fields };
}
function unique(
  fields: readonly JiraReportFieldCatalogEntry[],
): readonly JiraReportFieldCatalogEntry[] {
  return [...new Map(fields.map((field) => [field.id, field])).values()];
}
function fromScreens(required: JiraReportRequiredFields, boards: BoardFields): Selection {
  const fields = unique(required.estimateFields ?? []);
  if (required.state !== "applied") return unavailable("metadata-unavailable");
  if (fields.length > 1) return unavailable("ambiguous-field");
  const first = fields[0];
  if (first !== undefined) return selected(first, "project-screen");
  return unavailable(
    boards.failure === undefined || boards.failure === "not-found"
      ? "field-not-found"
      : "metadata-unavailable",
  );
}
function fromBoards(boards: BoardFields, required: JiraReportRequiredFields): Selection {
  const fields = unique(boards.fields);
  if (fields.length > 1) return unavailable("ambiguous-field");
  if (boards.failure !== undefined && fields.length > 0) return unavailable("metadata-unavailable");
  const first = fields[0];
  return first === undefined
    ? fromScreens(required, boards)
    : selected(first, "board-configuration");
}

/** One report-owned decision: explicit field, project board configuration, then project screens. */
export async function resolveJiraReportEstimate(
  http: JiraReportHttp,
  request: JiraReportRequest,
  required: JiraReportRequiredFields,
  catalog: readonly JiraReportFieldCatalogEntry[] | undefined,
): Promise<Selection> {
  const explicit = request.estimateFieldId;
  if (explicit !== undefined)
    return selected(
      { id: explicit, name: catalog?.find((item) => item.id === explicit)?.name ?? explicit },
      "explicit-field",
    );
  if (request.projectKey === undefined) return unavailable("project-not-specified");
  const boards = await boardFields(http, request.projectKey);
  if (boards.failure === "cancelled" || boards.failure === "effect-denied")
    return unavailable("metadata-unavailable", boards.failure);
  return fromBoards(boards, required);
}
