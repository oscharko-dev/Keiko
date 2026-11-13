// What a fresh lab session holds for the Release 1 walk (#4369), and the one command that completes
// it. The base seeds (project KEIKO, the identities, the required fields, content and pagination
// volume, the requirements projects) already exist as their own scripts; this module neither
// repeats nor replaces them. It adds the estimate-mix project, the parent-field project and the
// German-language mode, in the one order that works: every step that drives labelled English pages
// or English names runs first, the German locale last. `inventory` is the statement of which
// fixtures the lab holds, read natively, so it cannot drift from the lab.
// Usage: node release-1-fixtures.mjs <private-session-directory> [--language de]
//        node release-1-fixtures.mjs <private-session-directory> --inventory
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { basicAuth, checked, labRequest, loadSession } from "./lab-client.mjs";
import { main as seedEstimateMix } from "./requirements/seed-estimate-mix.mjs";
import { main as seedParentFields } from "./requirements/seed-parent-fields.mjs";
import { LAB_LOCALES, main as seedLanguage } from "./seed-language.mjs";

/** Pages of 100 the report must read to be compared with JQL over "more than three pages". */
export const PAGINATION_PAGE_SIZE = 100;
export const PAGINATION_PAGES_MIN = 4;

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);

async function jqlTotal(session, auth, project) {
  const jql = encodeURIComponent(`project = ${project}`);
  const page = await checked(
    session,
    "inventory-total",
    "GET",
    `/rest/api/2/search?jql=${jql}&maxResults=0`,
    auth,
  );
  return page.total;
}

/** The restricted second identity: its token exists, it reads ISOLATED and is refused on KEIKO. */
async function restrictedIdentity(session, fixture) {
  if (!existsSync(join(session.directory, "secrets", "restricted-token"))) return false;
  const auth = basicAuth(session, "restricted");
  const denied = await labRequest(
    session,
    "GET",
    `/rest/api/2/issue/${fixture.requiredIssueKey}`,
    auth,
  );
  const allowed = await labRequest(
    session,
    "GET",
    `/rest/api/2/issue/${fixture.isolationIssueKey}`,
    auth,
  );
  return allowed.status === 200 && denied.status !== 200;
}

/** The required custom field is required on the create screen and on the Done transition screen. */
async function requiredFields(session, fixture) {
  const auth = basicAuth(session, "admin");
  const create = await checked(
    session,
    "inventory-create-meta",
    "GET",
    `/rest/api/2/issue/createmeta/${fixture.project}/issuetypes/${fixture.issueTypeId}?maxResults=200`,
    auth,
  );
  const onCreate = create.values.some(
    (field) => field.fieldId === fixture.requiredFieldId && field.required === true,
  );
  const transitions = await checked(
    session,
    "inventory-transition-fields",
    "GET",
    `/rest/api/2/issue/${fixture.requiredIssueKey}/transitions?expand=transitions.fields`,
    auth,
  );
  const onTransition = transitions.transitions.some(
    (transition) => transition.fields && Object.hasOwn(transition.fields, fixture.requiredFieldId),
  );
  return { onCreate, onTransition };
}

/**
 * The fixtures this session holds, as closed facts. A missing one reads `false`/0, never an error:
 * the inventory is how a run learns what its lab lacks.
 */
export async function fixtureInventory(session) {
  const auth = basicAuth(session, "admin");
  const fixture = readJson(join(session.directory, "fixture.json"));
  if (fixture === undefined) return { baseSeed: false };
  const required = await requiredFields(session, fixture);
  const projects = readJson(join(session.directory, "requirements-truth.json"))?.projects ?? {};
  const largest = projects.large === undefined ? 0 : await jqlTotal(session, auth, projects.large);
  const mix = readJson(join(session.directory, "estimate-mix-truth.json"));
  const parent = readJson(join(session.directory, "parent-fields-truth.json"));
  const language = readJson(join(session.directory, "language.json"));
  return {
    baseSeed: true,
    restrictedSecondIdentity: await restrictedIdentity(session, fixture),
    requiredCustomFieldOnCreate: required.onCreate,
    requiredFieldOnTransitionScreen: required.onTransition,
    paginationIssues: largest,
    paginationPagesOf100: Math.ceil(largest / PAGINATION_PAGE_SIZE),
    paginationMoreThanThreePages: largest > 3 * PAGINATION_PAGE_SIZE,
    estimateMixTypes: mix === undefined ? 0 : Object.keys(mix.types).length,
    parentFieldsSideBySideTypes: parent?.sideBySideTypes?.length ?? 0,
    language: language?.locale ?? "en_US",
  };
}

/**
 * Completes a session for the Release 1 walk. The requirements projects come first (their seed
 * drives English administration and English status names), then the two new fixtures; the German
 * locale is applied last and only when asked, because every English-labelled seed after it would
 * fail on localized names.
 */
export async function prepareRelease1Fixtures(directory, { language = "en" } = {}) {
  if (!Object.hasOwn(LAB_LOCALES, language)) throw new TypeError("Unsupported lab language");
  await seedEstimateMix([directory]);
  await seedParentFields([directory]);
  await seedLanguage([directory, language]);
  const inventory = await fixtureInventory(loadSession(directory));
  console.log(JSON.stringify({ operation: "jira-lab-release-1-fixtures", ...inventory }));
  return inventory;
}

export async function main(args) {
  const [directory, flag, value, ...extra] = args;
  const inventoryOnly = flag === "--inventory" && value === undefined;
  const withLanguage = flag === "--language" && value !== undefined;
  if (!directory || extra.length > 0 || !(inventoryOnly || withLanguage || flag === undefined))
    throw new TypeError(
      "Usage: release-1-fixtures.mjs <session-directory> [--language de|en | --inventory]",
    );
  if (inventoryOnly) {
    const inventory = await fixtureInventory(loadSession(directory));
    console.log(JSON.stringify({ operation: "jira-lab-release-1-fixtures", ...inventory }));
    return inventory;
  }
  return prepareRelease1Fixtures(directory, { language: value ?? "en" });
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
