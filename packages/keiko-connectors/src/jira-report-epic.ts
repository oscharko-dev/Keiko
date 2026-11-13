import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import type { JiraReportFailure } from "./jira-report-metadata.js";
import { compareCodePoints } from "./jira-report-order.js";
import type { JiraReportFieldCatalogEntry } from "./jira-report-types.js";

/** Jira Software's own, non-localized schema key of its Epic Link field. */
export const JIRA_EPIC_LINK_SCHEMA_KEY = "com.pyxis.greenhopper.jira:gh-epic-link";
/**
 * One query carries at most this many characters of Epic clause, far below the URL ceilings of the
 * proxies in front of a Data Center instance (the search is a GET). The sub-tasks of a larger Epic
 * are read in several queries, never cut.
 */
export const JIRA_REPORT_EPIC_WINDOW_CHARS_MAX = 2500;
/** Members read to compose the windows; an Epic beyond this is reported incomplete, never cut. */
export const JIRA_REPORT_EPIC_MEMBERS_MAX = 10_000;
const MEMBER_PAGE_SIZE = 100;
const CUSTOM_FIELD_ID = /^customfield_(\d{1,12})$/u;

export interface JiraReportEpicScope {
  /** The clause that selects the Epic and its members; every other window selects sub-tasks. */
  readonly clause: string;
  /** One clause per query: the first is `clause`, the others `parent in (...)` over member chunks. */
  readonly windows: readonly string[];
  /** The members that can hold sub-tasks, and the digest of their sorted keys. */
  readonly memberCount: number;
  readonly membersDigest: string;
  /** `field`: the Epic Link field was addressed by id; `absent`: the instance has none. */
  readonly link: "field" | "absent";
}
export type JiraReportEpicResolution =
  | { readonly kind: "resolved"; readonly scope: JiraReportEpicScope }
  | { readonly kind: "failed"; readonly reason: JiraReportFailure };

function quoted(key: string): string {
  return JSON.stringify(key);
}
function memberClause(epicKey: string, linkClause: string | undefined): string {
  return [
    `key = ${quoted(epicKey)}`,
    ...(linkClause === undefined ? [] : [`${linkClause} = ${quoted(epicKey)}`]),
    `parent = ${quoted(epicKey)}`,
  ].join(" OR ");
}

/**
 * The Epic Link field by its schema key, addressed as `cf[N]` by its id and never by a display
 * name, which an instance may localize or rename. `absent` means the readable field list holds
 * none, as on an instance whose Epics are parents; `unresolved` means it holds several.
 */
function epicLinkClause(
  catalog: readonly JiraReportFieldCatalogEntry[],
): string | undefined | "unresolved" {
  const fields = catalog.filter((field) => field.schemaKey === JIRA_EPIC_LINK_SCHEMA_KEY);
  if (fields.length === 0) return undefined;
  const id = fields.length === 1 ? CUSTOM_FIELD_ID.exec(fields[0]?.id ?? "")?.[1] : undefined;
  return id === undefined ? "unresolved" : `cf[${id}]`;
}

interface Collected {
  epicSeen: boolean;
  readonly parents: Set<string>;
}
function observe(hits: readonly unknown[], epicKey: string, into: Collected): void {
  for (const hit of hits) {
    const record = asRecord(hit);
    const key = record?.key;
    if (!isSafeAtlassianIdentifier(key)) continue;
    if (key === epicKey) into.epicSeen = true;
    else if (asRecord(asRecord(record?.fields)?.issuetype)?.subtask !== true) into.parents.add(key);
  }
}
async function readMembers(
  http: JiraReportHttp,
  epicKey: string,
  jql: string,
  startAt: number,
  into: Collected,
): Promise<JiraReportFailure | undefined> {
  const outcome = await http.getRecord(
    `search?${new URLSearchParams({
      jql: `${jql} ORDER BY key ASC`,
      startAt: String(startAt),
      maxResults: String(MEMBER_PAGE_SIZE),
      fields: "issuetype",
    }).toString()}`,
  );
  if (!outcome.ok) return outcome.reason;
  const hits = asArray(outcome.body.issues);
  const { total } = outcome.body;
  if (hits === undefined || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
    return "malformed-payload";
  if (total > JIRA_REPORT_EPIC_MEMBERS_MAX) return "bounds-exceeded";
  observe(hits, epicKey, into);
  const next = startAt + hits.length;
  return hits.length === 0 || next >= total
    ? undefined
    : readMembers(http, epicKey, jql, next, into);
}

/** Member chunks whose `parent in (...)` clause stays within the per-query character bound. */
function chunks(parents: readonly string[]): readonly string[] {
  const windows: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const key of parents) {
    const cell = quoted(key).length + 2;
    if (current.length > 0 && size + cell > JIRA_REPORT_EPIC_WINDOW_CHARS_MAX) {
      windows.push(`parent in (${current.map(quoted).join(", ")})`);
      current = [];
      size = 0;
    }
    current.push(key);
    size += cell;
  }
  if (current.length > 0) windows.push(`parent in (${current.map(quoted).join(", ")})`);
  return windows;
}

/**
 * Resolves an Epic scope into reconcilable JQL windows: the Epic with its members (found through
 * the Epic Link field by id, and through `parent`), then the sub-tasks of those members, whose
 * `parent` no single clause can name. The scope states how many members it expanded and the digest
 * of their keys. A field list that is unreadable or ambiguous, a refused clause, an invisible Epic
 * and an Epic beyond the member bound are failures, never a silently narrower scope.
 */
export async function resolveJiraReportEpicScope(
  http: JiraReportHttp,
  epicKey: string,
  catalog: readonly JiraReportFieldCatalogEntry[] | undefined,
): Promise<JiraReportEpicResolution> {
  if (catalog === undefined) return { kind: "failed", reason: "unavailable" };
  const link = epicLinkClause(catalog);
  if (link === "unresolved") return { kind: "failed", reason: "malformed-payload" };
  const clause = memberClause(epicKey, link);
  const into: Collected = { epicSeen: false, parents: new Set() };
  const reason = await readMembers(http, epicKey, clause, 0, into);
  if (reason !== undefined) return { kind: "failed", reason };
  if (!into.epicSeen) return { kind: "failed", reason: "not-found" };
  const parents = [...into.parents].sort(compareCodePoints);
  return {
    kind: "resolved",
    scope: {
      clause,
      windows: [clause, ...chunks(parents)],
      memberCount: parents.length,
      membersDigest: sha256Hex(parents.join("\n")),
      link: link === undefined ? "absent" : "field",
    },
  };
}
