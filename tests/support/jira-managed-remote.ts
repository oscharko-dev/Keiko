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
  // A draft item's identity search: the synthetic project holds no earlier draft issue.
  if (path.endsWith("/search")) return response({ issues: [] });
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
/** Jira stores an added link and reads it back with the other issue on its own side. */
function fixtureLinkUpdates(mutation: Record<string, unknown>, state: SyntheticJira): void {
  const update = mutation.update as { issuelinks?: { add: Record<string, unknown> }[] } | undefined;
  if (update?.issuelinks === undefined) return;
  const links = (state.fields.issuelinks as readonly unknown[] | undefined) ?? [];
  state.fields.issuelinks = [
    ...links,
    ...update.issuelinks.map(({ add }, index) => ({ id: String(20000 + index), ...add })),
  ];
}
export function fixtureWrite(
  path: string,
  body: string | undefined,
  state: SyntheticJira,
): AtlassianHttpBodyResult {
  const mutation = JSON.parse(body ?? "{}") as Record<string, unknown>;
  if (typeof mutation.fields === "object" && mutation.fields !== null)
    state.fields = { ...state.fields, ...mutation.fields };
  fixtureLabelUpdates(mutation, state);
  fixtureLinkUpdates(mutation, state);
  if (path.endsWith("/assignee"))
    state.fields.assignee = mutation.name === null ? null : { name: mutation.name };
  if (path.endsWith("/transitions")) state.fields.status = { id: "3" };
  if (typeof mutation.body === "string") state.comment = mutation.body;
  if (path.endsWith("/issue")) return response({ key: "SYN-1", id: "10001" }, 201);
  if (path.endsWith("/comment")) return response({ id: "10002" }, 201);
  return response(undefined, 204);
}
