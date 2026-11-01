// Fast, model-free probes of the product against the live laboratory Jira (#4174).
// Each probe compares what Jira offers with what Keiko's own production code accepts.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { basicAuth, labRequest } from "../lab-client.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const fieldMetadata = await import(
  pathToFileURL(join(REPO, "packages/keiko-connectors/dist/jira-field-metadata.js")).href
);
const connectorContracts = await import(
  pathToFileURL(join(REPO, "packages/keiko-contracts/dist/atlassian-connectors.js")).href
);

async function adminGet(session, path) {
  const result = await labRequest(session, "GET", path, basicAuth(session, "admin"));
  if (result.status !== 200) throw new TypeError(`Laboratory read failed (${result.status})`);
  return result.value;
}

async function createFields(session, projectKey, typeName) {
  const types = await adminGet(session, `/rest/api/2/issue/createmeta/${projectKey}/issuetypes`);
  const type = types.values.find((value) => value.name === typeName);
  if (type === undefined) return undefined;
  const page = await adminGet(
    session,
    `/rest/api/2/issue/createmeta/${projectKey}/issuetypes/${type.id}?maxResults=200`,
  );
  return page.values;
}

async function editFields(session, projectKey, typeName) {
  const jql = encodeURIComponent(`project = ${projectKey} AND issuetype = "${typeName}"`);
  const found = await adminGet(
    session,
    `/rest/api/2/search?jql=${jql}&maxResults=1&fields=summary`,
  );
  const key = found.issues?.[0]?.key;
  if (key === undefined) return undefined;
  const meta = await adminGet(session, `/rest/api/2/issue/${key}/editmeta`);
  return Object.entries(meta.fields).map(([fieldId, field]) => ({ ...field, fieldId }));
}

// Fixed by the create call itself.
const FIXED_BY_CREATE = new Set(["project", "issuetype"]);
// Written through a dedicated governed tool instead of a field write. A field counts as covered
// only while Keiko's production contracts actually declare that tool.
const DEDICATED_TOOLS = Object.freeze({ comment: "jira.comment", attachment: "jira.attach" });

/** Whether a field is not a field write: set by the create call or by a declared dedicated tool. */
export function isNotFieldWrite(
  fieldId,
  actionTypes = connectorContracts.JIRA_MANAGED_ACTION_TYPES,
) {
  if (FIXED_BY_CREATE.has(fieldId)) return true;
  const tool = DEDICATED_TOOLS[fieldId];
  return tool !== undefined && Object.hasOwn(actionTypes, tool);
}

/** Every field Jira offers for the operation must be writable through Keiko's projection. */
function coverage(raw, operation) {
  const parsed = fieldMetadata.parseJiraFieldMetadata(raw);
  if (!parsed.ok) return { offered: raw.length, refused: [`metadata ${parsed.reason}`] };
  const offered = parsed.fields.filter((field) => !isNotFieldWrite(field.id));
  const refused = offered
    .filter((field) => field.kind === "unsupported" || field.operations.length === 0)
    .map((field) => `${field.name} (${operation})`);
  return { offered: offered.length, refused };
}

async function typeCoverage(session, projectKey, typeName) {
  const create = await createFields(session, projectKey, typeName);
  if (create === undefined)
    return { status: "red", detail: `issue type ${typeName} missing in lab` };
  const results = [coverage(create, "create")];
  const edit = await editFields(session, projectKey, typeName);
  if (edit !== undefined) results.push(coverage(edit, "edit"));
  const refused = results.flatMap((result) => result.refused);
  const offered = results.reduce((sum, result) => sum + result.offered, 0);
  return refused.length === 0
    ? {
        status: "green",
        covers: ["fields-writable"],
        detail: `${typeName}: all ${offered} offered fields writable`,
      }
    : {
        status: "red",
        covers: ["fields-writable"],
        detail: `${typeName}: ${refused.length} of ${offered} offered fields refused by Keiko: ${refused.join(", ")}`,
      };
}

/** Probes keyed by scenario id. Each returns one probe-layer check. */
export const PROBES = Object.freeze({
  S05: (session, project) => typeCoverage(session, project, "Epic"),
  S07: (session, project) => typeCoverage(session, project, "Task"),
  S08: (session, project) => typeCoverage(session, project, "Bug"),
  S09: (session, project) => typeCoverage(session, project, "Sub-task"),
});
