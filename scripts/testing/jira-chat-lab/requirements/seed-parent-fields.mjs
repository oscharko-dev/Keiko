// The parent-field project PAR (#4369): a lab project that offers the Epic Link field and the Parent
// Link field side by side on the same issue types, so the parent-field validation of the write-path
// child (#4354) is reproducible. Both fields are Jira's own: Epic Link is Jira Software's, Parent Link
// is Advanced Roadmaps' (`jpo-custom-field-parent`), found by schema and never by name or id. A
// project of this instance offers Epic Link from its template; this seed puts Parent Link on the
// project's default issue screen. An instance without the Parent Link type fails closed: the lab never
// stands in for it with a text field of the same name, which would test a shape no customer has.
// The truth, written to <session>/parent-fields-truth.json, is what Jira's own create metadata
// offers per type, plus one Epic with two Tasks linked through Epic Link.
import { isMainModule } from "../../../lib/is-main-module.mjs";
import { runFixtureSeed } from "./fixture-seed-cli.mjs";
import { bulkCreate, ensureProject, fieldIds } from "./seed-projects.mjs";
import { ensureOnProjectScreen } from "./seed-estimate-mix.mjs";

const PARENT_FIELDS_PROJECT = "PAR";
const PARENT_LINK_SCHEMA = "com.atlassian.jpo:jpo-custom-field-parent";
const asList = (value) => (Array.isArray(value) ? value : (value?.values ?? []));

/** The unique Parent Link field of the instance, found by its schema type. */
export async function findParentLink(jira) {
  const fields = await jira.call("par-fields", "GET", "/rest/api/2/field");
  const found = fields.filter((field) => field.schema?.custom === PARENT_LINK_SCHEMA);
  if (found.length !== 1)
    throw new TypeError("The instance has no unique Parent Link (Advanced Roadmaps) field");
  return found[0].id;
}

/** The issue types that offer each of the two fields on their create screen, from Jira's metadata. */
export async function offeredParentFields(jira, projectKey, { epicLink, parentLink }) {
  const base = `/rest/api/2/issue/createmeta/${projectKey}/issuetypes`;
  const offered = {};
  for (const type of asList(await jira.call("par-types", "GET", base))) {
    const meta = asList(
      await jira.call("par-create-fields", "GET", `${base}/${type.id}?maxResults=200`),
    );
    const ids = new Set(meta.map((field) => field.fieldId));
    offered[type.name] = { epicLink: ids.has(epicLink), parentLink: ids.has(parentLink) };
  }
  return offered;
}

/** The fixture is usable only when at least one issue type offers both fields side by side. */
export function parentFieldsTruth({ project, ids, offered, issues }) {
  const sideBySide = Object.entries(offered)
    .filter(([, row]) => row.epicLink && row.parentLink)
    .map(([type]) => type);
  if (sideBySide.length === 0)
    throw new TypeError("No issue type offers Epic Link and Parent Link side by side");
  return {
    schemaVersion: 1,
    project,
    fieldIds: { epicLink: ids.epicLink, parentLink: ids.parentLink },
    offered,
    sideBySideTypes: sideBySide,
    issues,
  };
}

async function seedPopulation(context, ids) {
  const [epic] = await bulkCreate(context, PARENT_FIELDS_PROJECT, [
    {
      type: "Epic",
      fields: { summary: "Eltern-Felder Epic", [ids.epicName]: "Eltern-Felder Epic" },
    },
  ]);
  const tasks = await bulkCreate(
    context,
    PARENT_FIELDS_PROJECT,
    [1, 2].map((n) => ({
      type: "Task",
      fields: { summary: `Eltern-Felder Aufgabe ${n}`, [ids.epicLink]: epic },
    })),
  );
  return [{ key: epic, type: "Epic" }, ...tasks.map((key) => ({ key, type: "Task", epic }))];
}

async function seedParentFields(context, jira, save) {
  await ensureProject(context, PARENT_FIELDS_PROJECT, "Eltern-Felder");
  const parentLink = await findParentLink(jira);
  await ensureOnProjectScreen(jira, PARENT_FIELDS_PROJECT, "Default Issue", parentLink);
  const ids = { ...(await fieldIds(context, PARENT_FIELDS_PROJECT)), parentLink };
  const existing = await jira.call(
    "par-existing",
    "GET",
    `/rest/api/2/search?jql=${encodeURIComponent(`project = ${PARENT_FIELDS_PROJECT} ORDER BY key ASC`)}&fields=issuetype&maxResults=50`,
  );
  const issues =
    existing.total === 0
      ? await seedPopulation(context, ids)
      : existing.issues.map((issue) => ({ key: issue.key, type: issue.fields.issuetype.name }));
  const offered = await offeredParentFields(jira, PARENT_FIELDS_PROJECT, ids);
  const truth = parentFieldsTruth({ project: PARENT_FIELDS_PROJECT, ids, offered, issues });
  save(truth);
  return {
    project: PARENT_FIELDS_PROJECT,
    sideBySideTypes: truth.sideBySideTypes.length,
    issues: issues.length,
  };
}

export function main(args) {
  return runFixtureSeed({
    args,
    name: "seed-parent-fields.mjs",
    receipt: "parent-fields-truth.json",
    operation: "requirements-parent-fields",
    seed: seedParentFields,
  });
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
