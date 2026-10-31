import type {
  JiraFieldMetadata,
  JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";

/**
 * Issue links travel on Jira's own `issuelinks` add-update of a create or edit (#4176). The
 * caller names the link type and the other issue; Jira validates the type and the target.
 */
export const JIRA_ISSUE_LINKS_MAX = 20;
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

type Failure = Extract<JiraMutationAttempt, { ok: false }>;
/** Current metadata must offer `add` on `issuelinks`; the update is Jira's canonical shape. */
export function jiraIssueLinkUpdate(
  metadata: readonly JiraFieldMetadata[],
  links: readonly JiraIssueLinkRequest[],
): { readonly ok: true; readonly update: readonly Record<string, unknown>[] } | Failure {
  const field = metadata.find((candidate) => candidate.id === "issuelinks");
  if (field?.kind !== "links" || !field.operations.includes("add"))
    return {
      ok: false,
      reason: "field-validation",
      detail: { fieldId: "issuelinks", validation: "unsupported-field" },
    };
  return {
    ok: true,
    update: links.map((link) => ({
      add: {
        type: { name: link.type },
        [link.direction === "outward" ? "outwardIssue" : "inwardIssue"]: { key: link.issueKey },
      },
    })),
  };
}

function presentLink(value: unknown, link: JiraIssueLinkRequest): boolean {
  const raw = asRecord(value);
  const type = asRecord(raw?.type)?.name;
  const other = asRecord(raw?.[link.direction === "outward" ? "outwardIssue" : "inwardIssue"]);
  return (
    typeof type === "string" &&
    type.toLowerCase() === link.type.toLowerCase() &&
    typeof other?.key === "string" &&
    other.key.toUpperCase() === link.issueKey.toUpperCase()
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
