import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";

/** A deterministic synthetic Data Center project for the report tests. Nothing here is a customer's. */
export const EPIC_LINK = "customfield_10014";
export const EPIC_NAME = "customfield_10011";
export const ACCEPTANCE = "customfield_10100";
export const POINTS = "customfield_10200";
/** Opaque app fields that never hold a parent: a rank string and an object without an issue key. */
export const DECOY_RANK = "customfield_10300";
export const DECOY_BLOB = "customfield_10301";
const EXTRA_FIELD_BASE = 20000;

export type FixtureCategory = "new" | "indeterminate" | "done";
export interface FixtureIssue {
  readonly key: string;
  readonly type: "Epic" | "Story" | "Bug" | "Sub-task";
  readonly category: FixtureCategory;
  readonly status: string;
  readonly summary: string;
  readonly epic?: string;
  readonly parent?: string;
  readonly links: readonly string[];
  readonly assignee: boolean;
  readonly due?: string;
  readonly seconds?: number;
  readonly points?: number;
  readonly acceptance: string | null;
  readonly labels: readonly string[];
  readonly description?: string;
}

const TYPE_IDS = { Epic: "10", Story: "11", Bug: "12", "Sub-task": "13" } as const;
const CATEGORY_STATUS: Readonly<Record<FixtureCategory, readonly [string, string, string]>> = {
  new: ["1", "Open", "To Do"],
  indeterminate: ["3", "Working", "In Progress"],
  done: ["5", "Closed", "Done"],
};

function category(index: number): FixtureCategory {
  const mod = index % 7;
  if (mod < 3) return "new";
  return mod < 5 ? "indeterminate" : "done";
}

/**
 * Epics REP-1..REP-4 (REP-4 stays empty); then stories, bugs and sub-tasks by index: every 9th
 * story has no epic (an orphan), every 5th lacks its acceptance criteria, bugs link to a story and
 * sub-tasks have a parent. Requirement ids REQ-001..REQ-005 are named by the first four epics and
 * two stories; REQ-006 is named by nothing.
 */
export function syntheticProject(size: number): readonly FixtureIssue[] {
  const issues: FixtureIssue[] = [1, 2, 3, 4].map(epicIssue);
  let lastStory = 4;
  for (let index = 5; index <= size; index += 1) {
    const key = `REP-${String(index)}`;
    const kind = index % 4;
    if (kind === 1 || kind === 0) {
      lastStory = index;
      issues.push(storyIssue(index, key));
    } else
      issues.push(
        kind === 2 ? bugIssue(index, key, lastStory) : subtaskIssue(index, key, lastStory),
      );
  }
  return issues;
}
function epicIssue(epic: number): FixtureIssue {
  return {
    key: `REP-${String(epic)}`,
    type: "Epic",
    category: epic === 3 ? "done" : "indeterminate",
    status: epic === 3 ? "Closed" : "Working",
    summary: epic <= 3 ? `Epic ${String(epic)} for REQ-00${String(epic)}.` : "Epic without members",
    links: [],
    assignee: epic !== 2,
    acceptance: "n/a",
    labels: epic === 1 ? ["REQ-004"] : [],
  };
}
function storyIssue(index: number, key: string): FixtureIssue {
  const withEpic = index % 9 !== 0;
  return {
    key,
    type: "Story",
    category: category(index),
    status: CATEGORY_STATUS[category(index)][1],
    summary: index === 41 ? "Story REQ-005 delivery" : `Story ${String(index)}`,
    ...(withEpic ? { epic: `REP-${String((index % 3) + 1)}` } : {}),
    links: [],
    assignee: index % 6 !== 0,
    ...(index % 11 === 0 ? { due: "2020-01-01" } : { due: "2999-01-01" }),
    ...(index % 4 === 1 ? { seconds: 3600 * (1 + (index % 5)) } : {}),
    ...(index % 3 === 0 ? { points: 0.5 + (index % 4) } : {}),
    acceptance: index % 5 === 0 ? null : "Given when then",
    labels: index === 45 ? ["REQ-002"] : [],
    description: index === 61 ? "Implements REQ-003, see notes." : "",
  };
}
function bugIssue(index: number, key: string, story: number): FixtureIssue {
  return {
    key,
    type: "Bug",
    category: category(index),
    status: CATEGORY_STATUS[category(index)][1],
    summary: `Bug ${String(index)}`,
    links: [`REP-${String(story)}`],
    assignee: index % 3 !== 0,
    ...(index % 2 === 0 ? { seconds: 1800 } : {}),
    acceptance: "n/a",
    labels: [],
  };
}
function subtaskIssue(index: number, key: string, story: number): FixtureIssue {
  return {
    key,
    type: "Sub-task",
    category: category(index),
    status: CATEGORY_STATUS[category(index)][1],
    summary: `Sub-task ${String(index)}`,
    parent: `REP-${String(story)}`,
    links: [],
    assignee: true,
    seconds: 900,
    acceptance: "n/a",
    labels: [],
  };
}

function plainFields(issue: FixtureIssue): Record<string, unknown> {
  return {
    summary: issue.summary,
    project: { key: "REP" },
    parent: issue.parent === undefined ? undefined : { key: issue.parent },
    issuelinks: issue.links.map((key) => ({ type: { name: "Relates" }, outwardIssue: { key } })),
    labels: [...issue.labels],
    assignee: issue.assignee ? { name: "someone" } : null,
    duedate: issue.due ?? null,
    timeoriginalestimate: issue.seconds ?? null,
    description: issue.description ?? null,
  };
}
function typedFields(issue: FixtureIssue): Record<string, unknown> {
  const [statusId, , categoryName] = CATEGORY_STATUS[issue.category];
  const statusName = issue.status;
  return {
    status: {
      id: statusId,
      name: statusName,
      statusCategory: { key: issue.category, name: categoryName },
    },
    issuetype: { id: TYPE_IDS[issue.type], name: issue.type, subtask: issue.type === "Sub-task" },
    [EPIC_LINK]: issue.epic ?? null,
    [EPIC_NAME]: issue.type === "Epic" ? issue.summary : null,
    [ACCEPTANCE]: issue.type === "Story" ? issue.acceptance : "n/a",
    [POINTS]: issue.points ?? null,
    [DECOY_RANK]: `0|i${issue.key.slice(4).padStart(5, "0")}:`,
    [DECOY_BLOB]: { hasValue: true },
    fixVersions: [],
  };
}
/** Every even extra opaque field holds free text; the odd ones stay empty on every issue. */
function extraFields(count: number): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1)
    fields[`customfield_${String(EXTRA_FIELD_BASE + index)}`] =
      index % 2 === 0 ? "free text" : null;
  return fields;
}
function rawIssue(issue: FixtureIssue, requested: ReadonlySet<string>, extra: number): unknown {
  const all = { ...plainFields(issue), ...typedFields(issue), ...extraFields(extra) };
  const fields: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(all))
    if (requested.has(id) && value !== undefined) fields[id] = value;
  return { id: issue.key.slice(4), key: issue.key, fields };
}

export function response(body: unknown, truncated = false): AtlassianHttpBodyResult {
  const bodyText = JSON.stringify(body);
  return {
    kind: "response",
    status: 200,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated,
  };
}

export interface FixtureOptions {
  readonly issues: readonly FixtureIssue[];
  /** Largest search response, in issues times requested fields; larger ones read as truncated. */
  readonly truncateAbove?: number;
  readonly pageClamp?: number;
  /** Rewrites the `total` of a search response, to emulate a scope that changes while paging. */
  readonly totalFor?: (call: number, total: number) => number;
  /** Selects the issues of a JQL string; the default selects the whole project. */
  readonly select?: (jql: string, searchCall: number) => readonly FixtureIssue[];
  /** HTTP statuses the `field` endpoint answers with, one per request; 200 once exhausted. */
  readonly fieldStatuses?: readonly number[];
  /** The HTTP status a failing search answers with (default 503). */
  readonly failSearchStatus?: number;
  /** Also require `fixVersions` (a mixed-case system field) on create for stories. */
  readonly requireFixVersions?: boolean;
  readonly failSearchAt?: number;
  readonly omitFieldList?: boolean;
  readonly noRequiredMetadata?: boolean;
  /** Create metadata is readable but requires nothing beyond the always-present system fields. */
  readonly noRequiredFields?: boolean;
  /**
   * The app that defines the epic-link and epic-name field types is another one with other type
   * keys; Jira still reports the same schema shape for them.
   */
  readonly foreignFieldTypeKeys?: boolean;
  /** This many further opaque app fields; every even one holds free text, the others are empty. */
  readonly extraOpaqueFields?: number;
}
export interface FixtureJira {
  readonly http: AtlassianHttpBodyPort;
  readonly searches: {
    readonly startAt: number;
    readonly maxResults: number;
    readonly jql: string;
  }[];
  readonly requests: string[];
}

const ISSUE_TYPES = [
  { id: "10", name: "Epic", subtask: false },
  { id: "11", name: "Story", subtask: false },
  { id: "12", name: "Bug", subtask: false },
  { id: "13", name: "Sub-task", subtask: true },
];
function createMetaFields(
  typeId: string,
  mixedCase: boolean,
  nothingRequired: boolean,
): readonly unknown[] {
  if (nothingRequired) return [{ fieldId: "summary", required: true, hasDefaultValue: false }];
  return [
    { fieldId: "summary", required: true, hasDefaultValue: false },
    { fieldId: "issuetype", required: true, hasDefaultValue: false },
    { fieldId: "reporter", required: true, hasDefaultValue: true },
    { fieldId: "labels", required: false, hasDefaultValue: false },
    ...(typeId === "11" ? [{ fieldId: ACCEPTANCE, required: true, hasDefaultValue: false }] : []),
    ...(typeId === "11" && mixedCase
      ? [{ fieldId: "fixVersions", required: true, hasDefaultValue: false }]
      : []),
  ];
}

const NOT_FOUND = {
  kind: "response",
  status: 404,
  bodyText: "",
  bodyBytes: 0,
  truncated: false,
} as const;
function failure(status: number): AtlassianHttpBodyResult {
  return { ...NOT_FOUND, status };
}
function fieldList(options: FixtureOptions): AtlassianHttpBodyResult {
  const custom = (
    type: string,
    key: string,
  ): { schema: { type: string; custom: string; customId: number } } => ({
    schema: { type, custom: key, customId: 1 },
  });
  const system = "com.atlassian.jira.plugin.system.customfieldtypes";
  const foreign = options.foreignFieldTypeKeys === true;
  const keys = foreign
    ? {
        link: "example.vendor.hierarchy:link-to-container",
        label: "example.vendor.hierarchy:label",
      }
    : {
        link: "com.pyxis.greenhopper.jira:gh-epic-link",
        label: "com.pyxis.greenhopper.jira:gh-epic-label",
      };
  const app = foreign ? "example.vendor.hierarchy" : "com.example.apps";
  const extra = Array.from({ length: options.extraOpaqueFields ?? 0 }, (_, index) => ({
    id: `customfield_${String(EXTRA_FIELD_BASE + index)}`,
    ...custom("any", `${app}:opaque-${String(index)}`),
  }));
  return response([
    { id: EPIC_LINK, ...custom("any", keys.link) },
    { id: EPIC_NAME, ...custom("string", keys.label) },
    { id: DECOY_RANK, ...custom("any", `${app}:ordering`) },
    { id: DECOY_BLOB, ...custom("any", `${app}:summary-blob`) },
    { id: ACCEPTANCE, ...custom("string", `${system}:textarea`) },
    { id: POINTS, ...custom("number", `${system}:float`) },
    { id: "summary", schema: { type: "string", system: "summary" } },
    ...extra,
  ]);
}
function createMeta(path: string, options: FixtureOptions): AtlassianHttpBodyResult {
  if (options.noRequiredMetadata === true) return failure(404);
  if (path.startsWith("issue/createmeta/REP/issuetypes/")) {
    const typeId = path.slice(path.lastIndexOf("/") + 1);
    return response({
      values: createMetaFields(
        typeId,
        options.requireFixVersions === true,
        options.noRequiredFields === true,
      ),
      isLast: true,
      total: 5,
    });
  }
  return response({ values: ISSUE_TYPES, isLast: true, total: 4 });
}

export function fixtureJira(options: FixtureOptions): FixtureJira {
  const searches: FixtureJira["searches"] = [];
  const requests: string[] = [];
  let searchCall = 0;
  const fieldStatuses = [...(options.fieldStatuses ?? [])];
  const select = options.select ?? ((): readonly FixtureIssue[] => options.issues);
  function search(url: URL): AtlassianHttpBodyResult {
    searchCall += 1;
    const jql = url.searchParams.get("jql") ?? "";
    const startAt = Number(url.searchParams.get("startAt"));
    const asked = Number(url.searchParams.get("maxResults"));
    const maxResults = Math.min(asked, options.pageClamp ?? 1000);
    searches.push({ startAt, maxResults: asked, jql });
    if (options.failSearchAt !== undefined && searchCall >= options.failSearchAt)
      return failure(options.failSearchStatus ?? 503);
    const requested = new Set((url.searchParams.get("fields") ?? "").split(","));
    const all = select(jql, searchCall);
    const page = all
      .slice(startAt, startAt + maxResults)
      .map((issue) => rawIssue(issue, requested, options.extraOpaqueFields ?? 0));
    const total = options.totalFor?.(searchCall, all.length) ?? all.length;
    const heavy =
      options.truncateAbove !== undefined && page.length * requested.size > options.truncateAbove;
    return response({ startAt, maxResults, total, issues: page }, heavy);
  }
  const http: AtlassianHttpBodyPort = (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*\/rest\/api\/2\//u, "");
    requests.push(`${request.method} ${path}${url.search}`);
    if (path === "field") {
      const status = fieldStatuses.shift();
      if (status !== undefined && status !== 200) return Promise.resolve(failure(status));
      return Promise.resolve(options.omitFieldList === true ? failure(500) : fieldList(options));
    }
    if (path.startsWith("issue/createmeta/REP/issuetypes"))
      return Promise.resolve(createMeta(path, options));
    return Promise.resolve(path === "search" ? search(url) : NOT_FOUND);
  };
  return { http, searches, requests };
}
