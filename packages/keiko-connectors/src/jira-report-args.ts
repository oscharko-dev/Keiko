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

export type JiraReportArgs =
  | { readonly kind: "new"; readonly request: JiraReportRequest }
  | {
      readonly kind: "continue";
      readonly reportId: string;
      readonly section: JiraReportSection;
      readonly startAt: number;
      readonly maxResults: number;
    };

const FIELD_ID = new RegExp(JIRA_FIELD_ID_PATTERN, "u");
const REPORT_ID = new RegExp(JIRA_REPORT_ID_PATTERN, "u");
const REQUIREMENT_ID = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${String(JIRA_REPORT_REQUIREMENT_ID_CHARS_MAX - 1)}}$`,
  "u",
);
const SCOPE_KEYS: ReadonlySet<string> = new Set([
  "projectKey",
  "jql",
  "estimateFieldId",
  "asOf",
  "parentFieldIds",
  "requirementIds",
]);
const CONTINUE_KEYS = new Set(["reportId", "section", "startAt", "maxResults"]);

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
  if (!Object.keys(args).every((key) => SCOPE_KEYS.has(key))) return undefined;
  const scope = scopeOf(args);
  const estimate = optionalField(args.estimateFieldId);
  const asOf = optionalDate(args.asOf);
  const parents = stringList(args.parentFieldIds, JIRA_REPORT_PARENT_FIELDS_MAX, FIELD_ID);
  const requirements = stringList(
    args.requirementIds,
    JIRA_REPORT_REQUIREMENT_ID_MAX,
    REQUIREMENT_ID,
  );
  if (
    scope === undefined ||
    estimate === null ||
    asOf === null ||
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
  };
}
function page(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}
function continuation(args: CatalogJsonObject): JiraReportArgs | undefined {
  const { reportId, section } = args;
  const startAt = page(args.startAt, 0, 0, 10_000_000);
  const maxResults = page(
    args.maxResults,
    JIRA_REPORT_SECTION_PAGE_DEFAULT,
    1,
    JIRA_REPORT_SECTION_PAGE_MAX,
  );
  const named = JIRA_REPORT_SECTIONS.find((item) => item === (section ?? "summary"));
  if (
    !Object.keys(args).every((key) => CONTINUE_KEYS.has(key)) ||
    typeof reportId !== "string" ||
    !REPORT_ID.test(reportId) ||
    named === undefined ||
    startAt === undefined ||
    maxResults === undefined
  )
    return undefined;
  return { kind: "continue", reportId, section: named, startAt, maxResults };
}

/** A new report names a scope; a continuation names only the report it resumes or pages. */
export function parseJiraReportArgs(args: CatalogJsonObject): JiraReportArgs | undefined {
  return args.reportId === undefined ? newReport(args) : continuation(args);
}
