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
  | { readonly kind: "failed"; readonly reason: JiraReportFailure }
  /** The member list moved while it was read; the report ends as `scope-changed`. */
  | { readonly kind: "moved" };

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
type EpicLink =
  | { readonly kind: "absent" }
  | { readonly kind: "unresolved" }
  | { readonly kind: "clause"; readonly clause: string };
function epicLinkOf(catalog: readonly JiraReportFieldCatalogEntry[]): EpicLink {
  const fields = catalog.filter((field) => field.schemaKey === JIRA_EPIC_LINK_SCHEMA_KEY);
  if (fields.length === 0) return { kind: "absent" };
  const id = fields.length === 1 ? CUSTOM_FIELD_ID.exec(fields[0]?.id ?? "")?.[1] : undefined;
  return id === undefined ? { kind: "unresolved" } : { kind: "clause", clause: `cf[${id}]` };
}

interface Collected {
  epicSeen: boolean;
  readonly parents: Set<string>;
  /** Every key the pages enumerated, and the total the pages stated. */
  readonly seen: Set<string>;
  enumerated: number;
  total: number | undefined;
}
/** The member read ended because the list moved or was cut, not because it was complete. */
type MemberEnd = JiraReportFailure | "moved" | undefined;
/** Returns true when a key repeated: a list that shifts between pages shows a key twice. */
function observe(hits: readonly unknown[], epicKey: string, into: Collected): boolean {
  let repeated = false;
  for (const hit of hits) {
    const record = asRecord(hit);
    const key = record?.key;
    if (!isSafeAtlassianIdentifier(key)) continue;
    if (into.seen.has(key)) repeated = true;
    into.seen.add(key);
    if (key === epicKey) into.epicSeen = true;
    else if (asRecord(asRecord(record?.fields)?.issuetype)?.subtask !== true) into.parents.add(key);
  }
  return repeated;
}
interface MemberPage {
  readonly hits: readonly unknown[];
  readonly total: number;
}
/** A page with Jira's own coordinates: it starts where asked and holds no more than the total leaves. */
function memberPage(body: Record<string, unknown>, startAt: number): MemberPage | undefined {
  const hits = asArray(body.issues);
  const { total } = body;
  if (hits === undefined || typeof total !== "number") return undefined;
  if (!Number.isSafeInteger(total) || total < 0) return undefined;
  return body.startAt === startAt && startAt + hits.length <= total ? { hits, total } : undefined;
}
async function readMembers(
  http: JiraReportHttp,
  epicKey: string,
  jql: string,
  startAt: number,
  into: Collected,
): Promise<MemberEnd> {
  const outcome = await http.getRecord(
    `search?${new URLSearchParams({
      jql: `${jql} ORDER BY key ASC`,
      startAt: String(startAt),
      maxResults: String(MEMBER_PAGE_SIZE),
      fields: "issuetype",
    }).toString()}`,
  );
  if (!outcome.ok) return outcome.reason;
  const page = memberPage(outcome.body, startAt);
  if (page === undefined) return "malformed-payload";
  if (page.total > JIRA_REPORT_EPIC_MEMBERS_MAX) return "bounds-exceeded";
  if (into.total !== undefined && into.total !== page.total) return "moved";
  into.total = page.total;
  if (observe(page.hits, epicKey, into)) return "moved";
  into.enumerated += page.hits.length;
  if (startAt + page.hits.length >= page.total) return undefined;
  // An empty page before the stated total is a cut list, never a complete one.
  return page.hits.length === 0
    ? "malformed-payload"
    : readMembers(http, epicKey, jql, startAt + page.hits.length, into);
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
  const link = epicLinkOf(catalog);
  if (link.kind === "unresolved") return { kind: "failed", reason: "malformed-payload" };
  const clause = memberClause(epicKey, link.kind === "clause" ? link.clause : undefined);
  const into: Collected = {
    epicSeen: false,
    parents: new Set(),
    seen: new Set(),
    enumerated: 0,
    total: undefined,
  };
  const end = await readMembers(http, epicKey, clause, 0, into);
  if (end === "moved") return { kind: "moved" };
  if (end !== undefined) return { kind: "failed", reason: end };
  // What the pages enumerated must be exactly what Jira said the list holds.
  if (into.enumerated !== into.total) return { kind: "moved" };
  if (!into.epicSeen) return { kind: "failed", reason: "not-found" };
  const parents = [...into.parents].sort(compareCodePoints);
  return {
    kind: "resolved",
    scope: {
      clause,
      windows: [clause, ...chunks(parents)],
      memberCount: parents.length,
      membersDigest: sha256Hex(parents.join("\n")),
      link: link.kind === "clause" ? "field" : "absent",
    },
  };
}
