import {
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  type JiraReportEstimateUnavailableReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { mapWithConcurrency } from "@oscharko-dev/keiko-contracts/runtime/bounded-concurrency";
import { asRecord } from "./atlassian-sync-classify.js";
import { boardEstimationField } from "./jira-agile-planning-observations.js";
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
> & { readonly failure?: JiraReportFailure; readonly alternate?: JiraReportAlternateEstimate };
/** An estimate field the same search also reads, so a configured field nobody uses is not the last word. */
export interface JiraReportAlternateEstimate {
  readonly id: string;
  readonly name: string;
  readonly unit: "seconds" | "custom-field";
}
/** Jira Software's own, non-localized schema key of its Story Points field. */
export const JIRA_STORY_POINTS_SCHEMA_KEY = "com.pyxis.greenhopper.jira:jsw-story-points";

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
interface BoardFields {
  readonly fields: readonly JiraReportFieldCatalogEntry[];
  readonly failure?: JiraReportFailure;
}
async function boardConfiguration(http: JiraReportHttp, board: unknown): Promise<BoardFields> {
  const id = boardId(board);
  if (id === undefined) return { fields: [], failure: "malformed-payload" };
  const outcome = await http.getAgileRecord(`board/${id}/configuration`);
  if (!outcome.ok) return { fields: [], failure: outcome.reason };
  const estimation = boardEstimationField(outcome.body);
  if (estimation.kind === "field")
    return { fields: [{ id: estimation.fieldId, name: estimation.displayName }] };
  return estimation.kind === "none" ? { fields: [] } : { fields: [], failure: "malformed-payload" };
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
  const fields = unique(required.estimateFields ?? []).filter(
    (field) => field.schemaKey === JIRA_STORY_POINTS_SCHEMA_KEY,
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

const TIME_ESTIMATE: JiraReportAlternateEstimate = {
  id: "timeoriginalestimate",
  name: "Original time estimate",
  unit: "seconds",
};
/**
 * The other estimate field the same search reads: native time tracking beside a custom field, and
 * the project's unique Story Points field beside time tracking. Never a second request per issue.
 */
function alternateFor(
  chosen: Selection,
  required: JiraReportRequiredFields,
): JiraReportAlternateEstimate | undefined {
  if (chosen.estimateFieldId === undefined) return undefined;
  if (chosen.estimateFieldId !== TIME_ESTIMATE.id) return TIME_ESTIMATE;
  const fields = unique(required.estimateFields ?? []).filter(
    (field) => field.schemaKey === JIRA_STORY_POINTS_SCHEMA_KEY,
  );
  const only = fields.length === 1 ? fields[0] : undefined;
  return only === undefined ? undefined : { id: only.id, name: only.name, unit: "custom-field" };
}
async function chosenEstimate(
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

/** One report-owned decision: explicit field, project board configuration, then project screens. */
export async function resolveJiraReportEstimate(
  http: JiraReportHttp,
  request: JiraReportRequest,
  required: JiraReportRequiredFields,
  catalog: readonly JiraReportFieldCatalogEntry[] | undefined,
): Promise<Selection> {
  const chosen = await chosenEstimate(http, request, required, catalog);
  const alternate = alternateFor(chosen, required);
  return alternate === undefined ? chosen : { ...chosen, alternate };
}

/**
 * The issue types whose create screen lacks the estimate field although the project offers it on
 * another type's: a hit of such a type that omits the field is an unestimated issue of a type that
 * has no estimate, not a field Jira withheld. Nothing is exempt unless the whole metadata read
 * succeeded (a partial or failed read cannot say which types lack the field), and a field no
 * screen lists, such as an explicit field the metadata does not know, exempts no type.
 */
export function jiraReportEstimateNotApplicableTypes(
  required: JiraReportRequiredFields,
  fieldId: string | undefined,
): ReadonlySet<string> {
  const screens = [...(required.estimateByType ?? [])];
  if (
    fieldId === undefined ||
    required.state !== "applied" ||
    !screens.some(([, ids]) => ids.includes(fieldId))
  )
    return new Set();
  return new Set(screens.filter(([, ids]) => !ids.includes(fieldId)).map(([typeId]) => typeId));
}
