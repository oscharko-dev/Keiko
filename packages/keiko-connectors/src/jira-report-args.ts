import {
  ATLASSIAN_JQL_MAX_CHARS,
  isSafeAtlassianIdentifier,
  JIRA_FIELD_ID_PATTERN,
  JIRA_REPORT_ID_PATTERN,
  JIRA_REPORT_REQUIREMENT_ID_CHARS_MAX,
  JIRA_REPORT_REQUIREMENT_ID_MAX,
  JIRA_REPORT_SECTIONS,
  type JiraReportSection,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jqlClause } from "./jira-report-jql.js";
import { compareCodePoints } from "./jira-report-order.js";
import type { JiraReportRequest } from "./jira-report-session.js";

export const JIRA_REPORT_SECTION_PAGE_DEFAULT = 25;
export const JIRA_REPORT_SECTION_PAGE_MAX = 100;
export const JIRA_REPORT_PARENT_FIELDS_MAX = 4;

/** The view a call asks for; a new report may name it too, so one call can read and page. */
export interface JiraReportPage {
  readonly section: JiraReportSection;
  readonly startAt: number;
  readonly maxResults: number;
}
export type JiraReportArgs =
  | ({
      readonly kind: "new";
      readonly request: JiraReportRequest;
      /** Keiko, not the model, lists the requirement ids of the Chat's Knowledge Pods. */
      readonly requirementsFromPods: boolean;
    } & JiraReportPage)
  | ({ readonly kind: "continue"; readonly reportId: string } & JiraReportPage);

const FIELD_ID = new RegExp(JIRA_FIELD_ID_PATTERN, "u");
const REPORT_ID = new RegExp(JIRA_REPORT_ID_PATTERN, "u");
const REQUIREMENT_ID = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${String(JIRA_REPORT_REQUIREMENT_ID_CHARS_MAX - 1)}}$`,
  "u",
);
/** Whether `value` can name a requirement in a report. */
export function isJiraReportRequirementId(value: string): boolean {
  return REQUIREMENT_ID.test(value);
}
const SCOPE_KEYS: ReadonlySet<string> = new Set([
  "projectKey",
  "jql",
  "estimateFieldId",
  "asOf",
  "parentFieldIds",
  "requirementIds",
  "requirementsFromPods",
]);
const PAGE_KEYS = ["section", "startAt", "maxResults"] as const;
const NEW_KEYS: ReadonlySet<string> = new Set([...SCOPE_KEYS, ...PAGE_KEYS]);
const CONTINUE_KEYS: ReadonlySet<string> = new Set(["reportId", ...PAGE_KEYS]);
/** Argument names echoed to the model; anything else is named by this placeholder. */
const ARGUMENT_NAME = /^[A-Za-z]\w{0,31}$/u;
const UNNAMED_ARGUMENT = "(unnamed)";
const INVALID_ARGUMENTS_MAX = 16;

function stringList(value: unknown, max: number, pattern: RegExp): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return undefined;
  const items: readonly unknown[] = value;
  const valid = items.filter(
    (item): item is string => typeof item === "string" && pattern.test(item),
  );
  return valid.length === items.length ? [...new Set(valid)].sort(compareCodePoints) : undefined;
}
function optionalField(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && FIELD_ID.test(value) ? value : null;
}
interface ReportScope {
  readonly projectKey: string | undefined;
  readonly jql: string | undefined;
}
function optionalProject(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return isSafeAtlassianIdentifier(value) ? value : null;
}
/** The caller's clause without ordering; null when unbalanced, undefined when none was given. */
function optionalClause(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const valid =
    typeof value === "string" && value.trim().length > 0 && value.length <= ATLASSIAN_JQL_MAX_CHARS;
  if (!valid) return null;
  const clause = jqlClause(value);
  return clause ?? null;
}
function scopeOf(args: CatalogJsonObject): ReportScope | undefined {
  const project = optionalProject(args.projectKey);
  const clause = optionalClause(args.jql);
  if (project === null || clause === null) return undefined;
  // A clause that was only ordering adds no scope; without a project nothing would be left.
  const effective = clause === undefined || clause.length === 0 ? undefined : clause;
  if (project === undefined && effective === undefined) return undefined;
  return { projectKey: project, jql: effective };
}
function optionalDate(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value) ? value : null;
}
function newReport(args: CatalogJsonObject): JiraReportArgs | undefined {
  if (!Object.keys(args).every((key) => NEW_KEYS.has(key))) return undefined;
  const scope = scopeOf(args);
  const view = pageOf(args);
  const estimate = optionalField(args.estimateFieldId);
  const asOf = optionalDate(args.asOf);
  const fromPods = optionalFlag(args.requirementsFromPods);
  const parents = stringList(args.parentFieldIds, JIRA_REPORT_PARENT_FIELDS_MAX, FIELD_ID);
  const requirements = stringList(
    args.requirementIds,
    JIRA_REPORT_REQUIREMENT_ID_MAX,
    REQUIREMENT_ID,
  );
  if (
    scope === undefined ||
    view === undefined ||
    estimate === null ||
    asOf === null ||
    fromPods === null ||
    parents === undefined ||
    requirements === undefined
  )
    return undefined;
  return {
    kind: "new",
    request: {
      ...scope,
      estimateFieldId: estimate,
      asOf,
      parentFieldIds: parents,
      requirementIds: requirements,
    },
    requirementsFromPods: fromPods,
    ...view,
  };
}
function optionalFlag(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : null;
}
function page(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}
function sectionOf(value: unknown): JiraReportSection | undefined {
  return JIRA_REPORT_SECTIONS.find((item) => item === (value ?? "summary"));
}
function startOf(value: unknown): number | undefined {
  return page(value, 0, 0, 10_000_000);
}
function maxResultsOf(value: unknown): number | undefined {
  return page(value, JIRA_REPORT_SECTION_PAGE_DEFAULT, 1, JIRA_REPORT_SECTION_PAGE_MAX);
}
function pageOf(args: CatalogJsonObject): JiraReportPage | undefined {
  const section = sectionOf(args.section);
  const startAt = startOf(args.startAt);
  const maxResults = maxResultsOf(args.maxResults);
  if (section === undefined || startAt === undefined || maxResults === undefined) return undefined;
  return { section, startAt, maxResults };
}
function continuation(args: CatalogJsonObject): JiraReportArgs | undefined {
  const { reportId } = args;
  const view = pageOf(args);
  if (
    !Object.keys(args).every((key) => CONTINUE_KEYS.has(key)) ||
    typeof reportId !== "string" ||
    !REPORT_ID.test(reportId) ||
    view === undefined
  )
    return undefined;
  return { kind: "continue", reportId, ...view };
}

const ARGUMENT_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  projectKey: (value) => optionalProject(value) !== null,
  jql: (value) => optionalClause(value) !== null,
  estimateFieldId: (value) => optionalField(value) !== null,
  asOf: (value) => optionalDate(value) !== null,
  parentFieldIds: (value) =>
    stringList(value, JIRA_REPORT_PARENT_FIELDS_MAX, FIELD_ID) !== undefined,
  requirementIds: (value) =>
    stringList(value, JIRA_REPORT_REQUIREMENT_ID_MAX, REQUIREMENT_ID) !== undefined,
  requirementsFromPods: (value) => optionalFlag(value) !== null,
  reportId: (value) => typeof value === "string" && REPORT_ID.test(value),
  section: (value) => sectionOf(value) !== undefined,
  startAt: (value) => startOf(value) !== undefined,
  maxResults: (value) => maxResultsOf(value) !== undefined,
};
function argumentName(key: string): string {
  return ARGUMENT_NAME.test(key) ? key : UNNAMED_ARGUMENT;
}

/**
 * The argument names a refused call has to fix, so the model can correct the call instead of
 * abandoning the report (#4181). Unknown or invalid names come first; a new report that names no
 * scope is answered with the two scope arguments, one of which it needs.
 */
export function invalidJiraReportArguments(args: CatalogJsonObject): readonly string[] {
  const allowed = args.reportId === undefined ? NEW_KEYS : CONTINUE_KEYS;
  const named = Object.keys(args).filter(
    (key) => !allowed.has(key) || ARGUMENT_CHECKS[key]?.(args[key]) === false,
  );
  const invalid = [...new Set(named.map((key) => argumentName(key)))].sort(compareCodePoints);
  if (invalid.length > 0) return invalid.slice(0, INVALID_ARGUMENTS_MAX);
  return args.reportId === undefined && scopeOf(args) === undefined ? ["jql", "projectKey"] : [];
}

/** A new report names a scope; a continuation names only the report it resumes or pages. */
export function parseJiraReportArgs(args: CatalogJsonObject): JiraReportArgs | undefined {
  return args.reportId === undefined ? newReport(args) : continuation(args);
}
