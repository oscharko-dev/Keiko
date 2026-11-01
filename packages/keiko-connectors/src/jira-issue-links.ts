import {
  JIRA_MUTATION_LINKS_MAX,
  type JiraFieldMetadata,
  type JiraMutationAttempt,
  type JiraMutationLinkAccount,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";

/**
 * Issue links (#4176). The caller names the link type and the other issue; Jira validates the type
 * and the target. Jira Data Center and Cloud take ONE `issuelinks` operation per create/edit request
 * (JRASERVER-66329, unresolved), so the request carries the first link on Jira's own add-update and
 * every further link is its own `POST /rest/api/2/issueLink` after the issue exists.
 */
export const JIRA_ISSUE_LINKS_MAX = JIRA_MUTATION_LINKS_MAX;
export const JIRA_ISSUE_LINKS_PER_REQUEST_MAX = 1;
/** The path (below `/rest/api/2/`) of the call that creates one link between two existing issues. */
export const JIRA_ISSUE_LINK_PATH = "issueLink";
const ISSUE_KEY = /^[A-Za-z]\w{0,254}-[1-9]\d{0,17}$/u;
// eslint-disable-next-line no-control-regex -- a link type name is a single-line identifier.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export interface JiraIssueLinkRequest {
  /** A Jira link type name, e.g. "Relates" or "Blocks". */
  readonly type: string;
  /** `outward`: this issue → other issue ("blocks"); `inward`: other issue → this issue. */
  readonly direction: "inward" | "outward";
  readonly issueKey: string;
}

function linkType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 255 &&
    !CONTROL.test(value)
  );
}
function linkRequest(value: unknown): JiraIssueLinkRequest | undefined {
  const raw = asRecord(value);
  if (raw === undefined || Object.keys(raw).length !== 3) return undefined;
  const { type, direction, issueKey } = raw;
  if (!linkType(type) || (direction !== "inward" && direction !== "outward")) return undefined;
  return typeof issueKey === "string" && ISSUE_KEY.test(issueKey)
    ? { type, direction, issueKey }
    : undefined;
}
function identity(link: JiraIssueLinkRequest): string {
  return `${link.type.toLowerCase()}\u0000${link.direction}\u0000${link.issueKey.toUpperCase()}`;
}

/** Undefined when the argument is malformed; duplicates collapse to one request. */
export function parseJiraIssueLinks(value: unknown): readonly JiraIssueLinkRequest[] | undefined {
  if (value === undefined) return [];
  const input = asArray(value);
  if (input === undefined || input.length > JIRA_ISSUE_LINKS_MAX) return undefined;
  const links = new Map<string, JiraIssueLinkRequest>();
  for (const entry of input) {
    const link = linkRequest(entry);
    if (link === undefined) return undefined;
    links.set(identity(link), link);
  }
  return [...links.values()];
}

export interface JiraIssueLinkPlan {
  /** Already on the issue when it was read: nothing is written for them. */
  readonly present: readonly JiraIssueLinkRequest[];
  /** At most one link: it rides on the create/edit request itself. */
  readonly inline: readonly JiraIssueLinkRequest[];
  /** Every other link: one separate call each, after the request succeeded. */
  readonly further: readonly JiraIssueLinkRequest[];
}
/**
 * Splits the requested links. Jira does not de-duplicate links, so one already on the issue is never
 * written again; `existing` is the issue's `issuelinks` as read before the write (none on create).
 */
export function planJiraIssueLinks(
  links: readonly JiraIssueLinkRequest[],
  existing?: unknown,
): JiraIssueLinkPlan {
  const present = links.filter((link) => jiraIssueLinksPresent(existing, [link]));
  const missing = links.filter((link) => !present.includes(link));
  return {
    present,
    inline: missing.slice(0, JIRA_ISSUE_LINKS_PER_REQUEST_MAX),
    further: missing.slice(JIRA_ISSUE_LINKS_PER_REQUEST_MAX),
  };
}
/** The plan's links in the order they are accepted: already present, inline, then further. */
export function orderedJiraIssueLinks(plan: JiraIssueLinkPlan): readonly JiraIssueLinkRequest[] {
  return [...plan.present, ...plan.inline, ...plan.further];
}

type Failure = Extract<JiraMutationAttempt, { ok: false }>;
/** Current metadata must offer `add` on `issuelinks`, whichever way a link is written. */
export function jiraIssueLinksOffered(metadata: readonly JiraFieldMetadata[]): Failure | undefined {
  const field = metadata.find((candidate) => candidate.id === "issuelinks");
  return field?.kind !== "links" || !field.operations.includes("add")
    ? {
        ok: false,
        reason: "field-validation",
        detail: { fieldId: "issuelinks", validation: "unsupported-field" },
      }
    : undefined;
}
/** Jira's canonical `issuelinks` add-update for the links that ride on the request itself. */
export function jiraIssueLinkAdds(
  inline: readonly JiraIssueLinkRequest[],
): readonly Record<string, unknown>[] {
  return inline.map((link) => ({
    add: {
      type: { name: link.type },
      [link.direction === "outward" ? "outwardIssue" : "inwardIssue"]: { key: link.issueKey },
    },
  }));
}
/**
 * The update for a request's own links. Jira refuses a request with a second `issuelinks` operation,
 * so this builds one link at most (JRASERVER-66329); `planJiraIssueLinks` routes the rest.
 */
export function jiraIssueLinkUpdate(
  metadata: readonly JiraFieldMetadata[],
  links: readonly JiraIssueLinkRequest[],
): { readonly ok: true; readonly update: readonly Record<string, unknown>[] } | Failure {
  if (links.length > JIRA_ISSUE_LINKS_PER_REQUEST_MAX)
    return {
      ok: false,
      reason: "field-validation",
      detail: { fieldId: "issuelinks", validation: "bounds-exceeded" },
    };
  return jiraIssueLinksOffered(metadata) ?? { ok: true, update: jiraIssueLinkAdds(links) };
}

/**
 * `POST /rest/api/2/issueLink` body for one link between this issue and the other. `inwardIssue` is
 * the link's source: an outward link ("this blocks that") has this issue as source, an inward link
 * has the other. A lab Data Center reads each shape back on the same side the update form puts it.
 */
export function jiraIssueLinkBody(
  issueKey: string,
  link: JiraIssueLinkRequest,
): Readonly<Record<string, unknown>> {
  const outward = link.direction === "outward";
  return {
    type: { name: link.type },
    inwardIssue: { key: outward ? issueKey : link.issueKey },
    outwardIssue: { key: outward ? link.issueKey : issueKey },
  };
}
/** A write that is one further link of an already acknowledged create/edit (#4176). */
export function isJiraIssueLinkWrite(request: {
  readonly method: string;
  readonly url: string;
}): boolean {
  return (
    request.method === "POST" &&
    URL.canParse(request.url) &&
    new URL(request.url).pathname.endsWith(`/rest/api/2/${JIRA_ISSUE_LINK_PATH}`)
  );
}

/**
 * A symmetric link type ("relates to" both ways) has no direction: a lab Data Center 10.3 lists a
 * Relates link made through the update form under the other side, so its direction is not compared.
 */
function symmetricType(type: Record<string, unknown> | undefined): boolean {
  return (
    typeof type?.inward === "string" &&
    type.inward.length > 0 &&
    type.inward.toLowerCase() ===
      (typeof type.outward === "string" ? type.outward.toLowerCase() : "")
  );
}
function presentLink(value: unknown, link: JiraIssueLinkRequest): boolean {
  const raw = asRecord(value);
  const type = asRecord(raw?.type);
  const sides = symmetricType(type)
    ? (["outwardIssue", "inwardIssue"] as const)
    : ([link.direction === "outward" ? "outwardIssue" : "inwardIssue"] as const);
  return (
    typeof type?.name === "string" &&
    type.name.toLowerCase() === link.type.toLowerCase() &&
    sides.some((side) => {
      const other = asRecord(raw?.[side]);
      return (
        typeof other?.key === "string" && other.key.toUpperCase() === link.issueKey.toUpperCase()
      );
    })
  );
}
/** Read back: every requested link must exist on the issue in its requested direction. */
export function jiraIssueLinksPresent(
  current: unknown,
  links: readonly JiraIssueLinkRequest[],
): boolean {
  const entries = asArray(current ?? []);
  return (
    entries !== undefined &&
    links.every((link) => entries.some((entry) => presentLink(entry, link)))
  );
}

function linkRef(link: JiraIssueLinkRequest): JiraIssueLinkRequest {
  return { type: link.type, direction: link.direction, issueKey: link.issueKey };
}
/**
 * The requested links against the issue's links as read back. `current` is undefined when the read
 * failed: then only the first `acknowledged` links are known to have been accepted, and the rest are
 * reported missing but unconfirmed, because a call whose answer was lost may still have landed.
 */
export function jiraIssueLinkAccount(
  links: readonly JiraIssueLinkRequest[],
  current: readonly unknown[] | undefined,
  acknowledged: number,
): JiraMutationLinkAccount {
  if (current === undefined) {
    const accepted = Math.min(acknowledged, links.length);
    return {
      requested: links.length,
      created: accepted,
      missing: links.slice(accepted).map(linkRef),
      unconfirmed: true,
    };
  }
  const missing = links.filter((link) => !current.some((entry) => presentLink(entry, link)));
  return {
    requested: links.length,
    created: links.length - missing.length,
    missing: missing.map(linkRef),
    unconfirmed: false,
  };
}
