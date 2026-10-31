import type { AtlassianHttpBodyResult } from "@oscharko-dev/keiko-connectors";

export function field(id: string, type: string, required = false): Record<string, unknown> {
  return { fieldId: id, name: id, required, operations: ["set"], schema: { type, system: id } };
}
export const REQUIRED_CUSTOM = {
  ...field("customfield_10000", "string", true),
  schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" },
};
const LABEL_FIELD = {
  ...field("labels", "array"),
  operations: ["set", "add", "remove"],
  schema: { type: "array", items: "string", system: "labels" },
};
export const LINKS_FIELD = {
  ...field("issuelinks", "array"),
  operations: ["add"],
  schema: { type: "array", items: "issuelinks", system: "issuelinks" },
};
export const FIELDS: readonly Record<string, unknown>[] = [
  field("project", "project", true),
  field("issuetype", "issuetype", true),
  field("summary", "string", true),
  REQUIRED_CUSTOM,
];
export function response(body: unknown, status = 200): AtlassianHttpBodyResult {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  };
}
export interface SyntheticJira {
  fields: Record<string, unknown>;
  comment: string;
}
export function fixtureRead(path: string, state: SyntheticJira): AtlassianHttpBodyResult {
  if (path.includes("createmeta"))
    return response({ values: FIELDS, start: 0, size: 100, last: true, total: FIELDS.length });
  if (path.endsWith("editmeta"))
    return response({
      fields: {
        summary: field("summary", "string"),
        assignee: field("assignee", "user"),
        labels: LABEL_FIELD,
        issuelinks: LINKS_FIELD,
      },
    });
  if (path.endsWith("transitions"))
    return response({
      transitions: [{ id: "31", to: { id: "3" }, fields: { customfield_10000: REQUIRED_CUSTOM } }],
    });
  if (path.endsWith("assignable/search"))
    return response([{ name: "synthetic-user", active: true }]);
  // A draft item's identity search: the synthetic project holds the one issue SYN-1, found by its
  // summary (the connector keeps only an exact summary match).
  if (path.endsWith("/search"))
    return response({
      startAt: 0,
      maxResults: 50,
      total: 1,
      issues: [{ key: "SYN-1", id: "10001", fields: { summary: state.fields.summary } }],
    });
  if (path.endsWith("/comment/10002")) return response({ id: "10002", body: state.comment });
  if (path.endsWith("/issue/SYN-1"))
    return response({ id: "10001", key: "SYN-1", fields: state.fields });
  return response({}, 404);
}
function fixtureLabelUpdates(mutation: Record<string, unknown>, state: SyntheticJira): void {
  const update = mutation.update as { labels?: Record<string, string>[] } | undefined;
  if (update?.labels === undefined) return;
  const labels = new Set(state.fields.labels as readonly string[]);
  for (const item of update.labels) {
    if (item.add !== undefined) labels.add(item.add);
    if (item.remove !== undefined) labels.delete(item.remove);
  }
  state.fields.labels = [...labels];
}
type LinkOperations = { issuelinks?: { add: Record<string, unknown> }[] } | undefined;
/** The synthetic issue every fixture request is about. */
const SYNTHETIC_ISSUE_KEY = "SYN-1";
/**
 * Jira Data Center and Cloud both take ONE `issuelinks` operation per create/edit request (the
 * unresolved JRASERVER-66329); a lab Data Center 10.3 answers HTTP 400 with this message. The
 * fixture refuses the same way, so a payload real Jira rejects can never pass here.
 */
export function jiraTooManyLinkOperationsBody(operations: number): Record<string, unknown> {
  return {
    errorMessages: [],
    errors: {
      issuelinks: `Too many operations (${String(operations)}) provided for field 'issuelinks'. We support at most 1 operation for this field.`,
    },
  };
}
export function fixtureLinkOperationCount(mutation: Record<string, unknown>): number {
  return (mutation.update as LinkOperations)?.issuelinks?.length ?? 0;
}
function fixtureLinkOperationRefusal(
  mutation: Record<string, unknown>,
): AtlassianHttpBodyResult | undefined {
  const operations = fixtureLinkOperationCount(mutation);
  return operations > 1 ? response(jiraTooManyLinkOperationsBody(operations), 400) : undefined;
}
function fixtureStoreLink(state: SyntheticJira, link: Record<string, unknown>): void {
  const links = (state.fields.issuelinks as readonly unknown[] | undefined) ?? [];
  state.fields.issuelinks = [...links, { id: String(20000 + links.length), ...link }];
}
/** Jira stores an added link and reads it back with the other issue on its own side. */
function fixtureLinkUpdates(mutation: Record<string, unknown>, state: SyntheticJira): void {
  for (const { add } of (mutation.update as LinkOperations)?.issuelinks ?? [])
    fixtureStoreLink(state, add);
}
/**
 * `POST /rest/api/2/issueLink`: `inwardIssue` is the source of the link, as a real Data Center
 * reads back (a link whose source is this issue lists the other under `outwardIssue`).
 */
function fixtureIssueLink(
  mutation: Record<string, unknown>,
  state: SyntheticJira,
): AtlassianHttpBodyResult {
  const inward = (mutation.inwardIssue as { key?: string } | undefined)?.key;
  const outward = (mutation.outwardIssue as { key?: string } | undefined)?.key;
  if (mutation.type === undefined || inward === undefined || outward === undefined)
    return response({ errorMessages: ["Bad link"], errors: {} }, 400);
  if (inward === SYNTHETIC_ISSUE_KEY)
    fixtureStoreLink(state, { type: mutation.type, outwardIssue: { key: outward } });
  else if (outward === SYNTHETIC_ISSUE_KEY)
    fixtureStoreLink(state, { type: mutation.type, inwardIssue: { key: inward } });
  else return response({ errorMessages: ["Issue Does Not Exist"], errors: {} }, 404);
  return response(undefined, 201);
}
function fixtureApply(path: string, mutation: Record<string, unknown>, state: SyntheticJira): void {
  if (typeof mutation.fields === "object" && mutation.fields !== null)
    state.fields = { ...state.fields, ...mutation.fields };
  fixtureLabelUpdates(mutation, state);
  fixtureLinkUpdates(mutation, state);
  if (path.endsWith("/assignee"))
    state.fields.assignee = mutation.name === null ? null : { name: mutation.name };
  if (path.endsWith("/transitions")) state.fields.status = { id: "3" };
  if (typeof mutation.body === "string") state.comment = mutation.body;
}
export function fixtureWrite(
  path: string,
  body: string | undefined,
  state: SyntheticJira,
): AtlassianHttpBodyResult {
  const mutation = JSON.parse(body ?? "{}") as Record<string, unknown>;
  const refusal = fixtureLinkOperationRefusal(mutation);
  if (refusal !== undefined) return refusal;
  if (path.endsWith("/issueLink")) return fixtureIssueLink(mutation, state);
  fixtureApply(path, mutation, state);
  if (path.endsWith("/issue")) return response({ key: "SYN-1", id: "10001" }, 201);
  if (path.endsWith("/comment")) return response({ id: "10002" }, 201);
  return response(undefined, 204);
}
