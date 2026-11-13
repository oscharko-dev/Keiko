// What a fresh lab session holds for the Release 1 walk (#4369), and the one command that completes
// it. The base seeds (project KEIKO, the identities, the required fields, content and pagination
// volume, the requirements projects) already exist as their own scripts; this module neither
// repeats nor replaces them. It adds the estimate-mix project, the parent-field project and the
// German-language mode, in the one order that works: every step that drives labelled English pages
// or English names runs first, the German locale last. `inventory` is the statement of which
// fixtures the lab holds, read natively, so it cannot drift from the lab.
// Usage: node release-1-fixtures.mjs <private-session-directory> [--seed] [--language de]
//        node release-1-fixtures.mjs <private-session-directory> --inventory
// `--seed` runs the base seeds first, so a session straight after `setup.mjs` needs nothing else.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { basicAuth, checked, labRequest, loadSession } from "./lab-client.mjs";
import { assertLabDirectoryOutsideTemporary } from "./lab-directory.mjs";
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
  const fixture = readJson(join(session.directory, "fixture.json"));
  if (fixture === undefined) return { baseSeed: false };
  const required = await requiredFields(session, fixture);
  const largest = await largestProjectIssues(session);
  return {
    baseSeed: true,
    restrictedSecondIdentity: await restrictedIdentity(session, fixture),
    requiredCustomFieldOnCreate: required.onCreate,
    requiredFieldOnTransitionScreen: required.onTransition,
    paginationIssues: largest,
    paginationPagesOf100: Math.ceil(largest / PAGINATION_PAGE_SIZE),
    paginationMoreThanThreePages: largest > 3 * PAGINATION_PAGE_SIZE,
    ...receiptFacts(session),
  };
}

/** The issue count of the large report project, the lab's pagination volume. */
async function largestProjectIssues(session) {
  const projects = readJson(join(session.directory, "requirements-truth.json"))?.projects ?? {};
  if (projects.large === undefined) return 0;
  return jqlTotal(session, basicAuth(session, "admin"), projects.large);
}

/** What the private receipts of the three new fixtures record, without reading Jira again. */
function receiptFacts(session) {
  const read = (name) => readJson(join(session.directory, name));
  return {
    estimateMixTypes: Object.keys(read("estimate-mix-truth.json")?.types ?? {}).length,
    parentFieldsSideBySideTypes: read("parent-fields-truth.json")?.sideBySideTypes?.length ?? 0,
    language: read("language.json")?.locale ?? "en_US",
  };
}

/** The existing base seeds, each idempotent and each driving English labels or English names. */
export const BASE_SEED_STEPS = Object.freeze([
  "seed.mjs",
  "qualify-fields.mjs",
  "seed-content.mjs",
  "requirements/seed-projects.mjs",
  "requirements/seed-estimates.mjs",
]);
const HERE = dirname(fileURLToPath(import.meta.url));

function runScript(script, directory) {
  const result = spawnSync(process.execPath, [join(HERE, script), directory], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new TypeError(`Lab step ${script} failed`);
}

/**
 * Completes a session for the Release 1 walk. With `seed`, the base seeds run first (after license
 * setup, nothing else is needed). The requirements projects come before the two new fixtures
 * (their seed drives English administration and English status names); the actors are English while
 * any of that runs, and the German locale is applied last and only when asked, because
 * `qualify-fields.mjs` failed on localized names (2026-11-13).
 */
export async function prepareRelease1Fixtures(
  directory,
  { language = "en", seed = false, run = runScript } = {},
) {
  if (!Object.hasOwn(LAB_LOCALES, language)) throw new TypeError("Unsupported lab language");
  if (seed) {
    // A session left German by an earlier run must be English before any English-labelled seed.
    if (existsSync(join(directory, "language.json"))) await seedLanguage([directory, "en"]);
    for (const script of BASE_SEED_STEPS) run(script, directory);
  }
  await seedEstimateMix([directory]);
  await seedParentFields([directory]);
  await seedLanguage([directory, language]);
  const inventory = await fixtureInventory(loadSession(directory));
  console.log(JSON.stringify({ operation: "jira-lab-release-1-fixtures", ...inventory }));
  return inventory;
}

export async function main(args) {
  const usage =
    "Usage: release-1-fixtures.mjs <session-directory> [--seed] [--language de|en] | --inventory";
  const [directory, ...flags] = args;
  if (!directory) throw new TypeError(usage);
  assertLabDirectoryOutsideTemporary(directory);
  if (flags.length === 1 && flags[0] === "--inventory") {
    const inventory = await fixtureInventory(loadSession(directory));
    console.log(JSON.stringify({ operation: "jira-lab-release-1-fixtures", ...inventory }));
    return inventory;
  }
  const seed = flags.includes("--seed");
  const rest = flags.filter((flag) => flag !== "--seed");
  const withLanguage = rest[0] === "--language" && rest.length === 2;
  if (rest.length > 0 && !withLanguage) throw new TypeError(usage);
  return prepareRelease1Fixtures(directory, { language: withLanguage ? rest[1] : "en", seed });
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
