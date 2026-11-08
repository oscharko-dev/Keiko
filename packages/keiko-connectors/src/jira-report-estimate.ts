import {
  JIRA_FIELD_ID_PATTERN,
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  type JiraReportEstimateUnavailableReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { mapWithConcurrency } from "@oscharko-dev/keiko-contracts/runtime/bounded-concurrency";
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
async function boardConfiguration(http: JiraReportHttp, board: unknown): Promise<BoardFields> {
  const id = boardId(board);
  if (id === undefined) return { fields: [], failure: "malformed-payload" };
  const outcome = await http.getAgileRecord(`board/${id}/configuration`);
  if (!outcome.ok) return { fields: [], failure: outcome.reason };
  const field = configuredField(outcome.body);
  if (field !== undefined) return { fields: [field] };
  return boardWithoutEstimate(outcome.body)
    ? { fields: [] }
    : { fields: [], failure: "malformed-payload" };
}
async function boardFields(http: JiraReportHttp, project: string): Promise<BoardFields> {
  const boards: unknown[] = [];
  const reason = await collectJiraReportMetadataPages(
    { getRecord: http.getAgileRecord },
    `board?projectKeyOrId=${encodeURIComponent(project)}`,
    0,
    boards,
    DEFAULT_ATLASSIAN_SYNC_BOUNDS.maxItems,
  );
  if (reason !== undefined) return { fields: [], failure: reason };
  const observed = await mapWithConcurrency(
    boards,
    DEFAULT_ATLASSIAN_SYNC_BOUNDS.maxConcurrency,
    (board) => boardConfiguration(http, board),
  );
  const failure = observed.find((item) => item.failure !== undefined)?.failure;
  return {
    fields: observed.flatMap((item) => item.fields),
    ...(failure === undefined ? {} : { failure }),
  };
}
function unique(
  fields: readonly JiraReportFieldCatalogEntry[],
): readonly JiraReportFieldCatalogEntry[] {
  return [...new Map(fields.map((field) => [field.id, field])).values()];
}
function timeTracking(): Selection {
  return selected({ id: "timeoriginalestimate", name: "Original time estimate" }, "time-tracking");
}
function fromScreens(required: JiraReportRequiredFields, boards: BoardFields): Selection {
  if (required.state !== "applied") return unavailable("metadata-unavailable");
  const fields = unique(required.estimateFields ?? []).filter((field) =>
    /^story[ -]points(?: estimate)?$/iu.test(field.name),
  );
  const first = fields.length === 1 ? fields[0] : undefined;
  if (first !== undefined) return selected(first, "project-screen");
  if (required.timeTracking === true) return timeTracking();
  if (fields.length > 1) return unavailable("ambiguous-field");
  return unavailable(
    boards.failure === undefined || boards.failure === "not-found"
      ? "field-not-found"
      : "metadata-unavailable",
  );
}
function onScreens(
  field: JiraReportFieldCatalogEntry,
  required: JiraReportRequiredFields,
): boolean {
  if (field.id === "timeoriginalestimate") return required.timeTracking === true;
  return (required.estimateFields ?? []).some((candidate) => candidate.id === field.id);
}
function fromBoards(boards: BoardFields, required: JiraReportRequiredFields): Selection {
  const fields = unique(boards.fields).filter((field) => onScreens(field, required));
  const first = boards.failure === undefined && fields.length === 1 ? fields[0] : undefined;
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
  if (request.projectKey === undefined) return timeTracking();
  const boards = await boardFields(http, request.projectKey);
  if (boards.failure === "cancelled" || boards.failure === "effect-denied")
    return unavailable("metadata-unavailable", boards.failure);
  if (boards.failure === "bounds-exceeded") return unavailable("metadata-unavailable");
  return fromBoards(boards, required);
}
