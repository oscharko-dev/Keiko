// The lab's one issue-security scheme, its one level and the project association. Jira's public
// REST API reads these but cannot create them, so the existing supported-UI administration path
// (seed-admin.mjs) is reused. Idempotent: each step first observes the native state and acts only on
// what is missing. Everything is synthetic, deterministic and free of personal data.
import { basicAuth, labRequest } from "./lab-client.mjs";
import { withLabAdmin } from "./seed-admin.mjs";

export const FIXTURE_SECURITY_SCHEME = "Keiko synthetic security scheme";
export const FIXTURE_SECURITY_LEVEL = "Keiko synthetic security level";
const PROJECT_KEY = "KEIKO";

async function nativeRead(session, path) {
  return labRequest(session, "GET", path, basicAuth(session, "admin"));
}
async function observeScheme(session) {
  const schemes = await nativeRead(session, "/rest/api/2/issuesecurityschemes");
  if (schemes.status !== 200 || !Array.isArray(schemes.value?.issueSecuritySchemes))
    throw new TypeError("Unexpected issue security scheme state");
  const scheme = schemes.value.issueSecuritySchemes.find(
    (row) => row.name === FIXTURE_SECURITY_SCHEME,
  );
  if (scheme === undefined) return { schemeId: undefined, hasLevel: false };
  const detail = await nativeRead(session, `/rest/api/2/issuesecurityschemes/${scheme.id}`);
  const levels = detail.value?.levels;
  return {
    schemeId: String(scheme.id),
    hasLevel: Array.isArray(levels) && levels.some((row) => row.name === FIXTURE_SECURITY_LEVEL),
  };
}
async function observeProject(session) {
  const project = await nativeRead(session, `/rest/api/2/project/${PROJECT_KEY}`);
  const associated = await nativeRead(
    session,
    `/rest/api/2/project/${PROJECT_KEY}/issuesecuritylevelscheme`,
  );
  return {
    projectId: project.status === 200 ? String(project.value.id) : undefined,
    associated: associated.status === 200 && associated.value?.name === FIXTURE_SECURITY_SCHEME,
  };
}
async function observeSecurity(session) {
  return { ...(await observeScheme(session)), ...(await observeProject(session)) };
}

async function addScheme(page, session) {
  await page.goto(`${session.origin}/secure/admin/AddIssueSecurityScheme!default.jspa`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("input[name=name]").first().fill(FIXTURE_SECURITY_SCHEME);
  await page.locator("#add_submit, input[type=submit][value=Add]").first().click();
  await page.waitForLoadState("domcontentloaded");
}
async function addLevel(page, session, schemeId) {
  await page.goto(
    `${session.origin}/secure/admin/EditIssueSecurities!default.jspa?schemeId=${schemeId}`,
    {
      waitUntil: "domcontentloaded",
    },
  );
  await page.locator("input[name=name]").first().fill(FIXTURE_SECURITY_LEVEL);
  await page.locator("#add_submit, input[type=submit][value*=Add]").first().click();
  await page.waitForLoadState("domcontentloaded");
}
async function associate(page, session, projectId, schemeId) {
  await page.goto(
    `${session.origin}/secure/project/SelectIssueSecurityScheme!default.jspa?projectId=${projectId}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.locator("select[name=schemeId]").selectOption(schemeId);
  await page.locator("#next_submit, input[type=submit][value=Next]").first().click();
  await page.waitForLoadState("domcontentloaded");
  // The second step maps existing issues to a level; the default (no level) is the right choice.
  await page.locator("#associate_submit, input[type=submit][value=Associate]").first().click();
  await page.waitForLoadState("domcontentloaded");
}

/** Returns true when the scheme, its level and the project association all exist afterwards. */
export async function ensureFixtureSecurityScheme(session) {
  let state = await observeSecurity(session);
  if (state.schemeId !== undefined && state.hasLevel && state.associated) return true;
  if (state.projectId === undefined) throw new TypeError("Synthetic project is missing");
  await withLabAdmin(session, async (page) => {
    if (state.schemeId === undefined) {
      await addScheme(page, session);
      state = await observeSecurity(session);
    }
    if (state.schemeId === undefined) throw new TypeError("Scheme was not created");
    if (!state.hasLevel) {
      await addLevel(page, session, state.schemeId);
      state = await observeSecurity(session);
    }
    if (!state.associated) await associate(page, session, state.projectId, state.schemeId);
  });
  state = await observeSecurity(session);
  const ready = state.schemeId !== undefined && state.hasLevel && state.associated;
  console.log(JSON.stringify({ operation: "jira-lab-admin", case: "security-scheme", ready }));
  return ready;
}
