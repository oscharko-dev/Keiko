import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { basicAuth, checked } from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";
import {
  withLabAdmin,
  setFixtureFieldRequirement,
  configureFixtureTransition,
} from "./seed-admin.mjs";

export async function ensureFixtureField(session) {
  const auth = basicAuth(session, "admin");
  const fields = await checked(session, "find-required-field", "GET", "/rest/api/2/field", auth);
  const found = fields.filter((field) => field.name === "Keiko required text");
  if (found.length > 1) throw new TypeError("Ambiguous required fixture field");
  const field =
    found[0] ??
    (await checked(session, "create-required-field", "POST", "/rest/api/2/field", auth, {
      name: "Keiko required text",
      description: "Synthetic mandatory field fixture",
      type: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
      searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher",
    }));
  const screens = await checked(
    session,
    "find-fixture-screens",
    "GET",
    "/rest/api/2/screens",
    auth,
  );
  for (const name of [
    "Resolve Issue Screen",
    ...["KEIKO", "ISOLATED"].flatMap((key) => [
      `${key}: Simple Issue Tracking Create Issue Screen`,
      `${key}: Simple Issue Tracking Edit/View Issue Screen`,
    ]),
  ]) {
    const screen = screens.find((value) => value.name === name);
    if (!screen) throw new TypeError("Missing synthetic fixture screen");
    await addScreenField(session, screen.id, field.id);
  }
  return field.id;
}

async function addScreenField(session, screenId, fieldId) {
  const auth = basicAuth(session, "admin");
  const tabs = await checked(
    session,
    "screen-tabs",
    "GET",
    `/rest/api/2/screens/${screenId}/tabs`,
    auth,
  );
  if (!tabs[0]) throw new TypeError("Missing fixture screen tab");
  const path = `/rest/api/2/screens/${screenId}/tabs/${tabs[0].id}/fields`;
  const fields = await checked(session, "screen-fields", "GET", path, auth);
  if (!fields.some((value) => value.id === fieldId))
    await checked(session, "add-screen-field", "POST", path, auth, { fieldId });
}

export async function prepareTransitionFixtures(session, fieldId, issueKeys) {
  await withLabAdmin(session, async (page) => {
    try {
      await setFixtureFieldRequirement(page, session, false);
      for (const key of issueKeys) await resetLegacyIssue(session, fieldId, key);
      const auth = basicAuth(session, "admin");
      const metadata = await checked(
        session,
        "transition-screen-readiness",
        "GET",
        `/rest/api/2/issue/${issueKeys[0]}/transitions?expand=transitions.fields`,
        auth,
      );
      if (
        !metadata.transitions.some(
          (value) => value.name === "Done" && Object.hasOwn(value.fields, fieldId),
        )
      )
        await configureFixtureTransition(page, session);
    } finally {
      await setFixtureFieldRequirement(page, session, true);
    }
  });
}

async function resetLegacyIssue(session, fieldId, key) {
  const auth = basicAuth(session, "admin");
  const path = `/rest/api/2/issue/${key}`;
  const metadata = await checked(
    session,
    "legacy-fixture-state",
    "GET",
    `${path}/transitions?expand=transitions.fields`,
    auth,
  );
  const reopen = metadata.transitions.find(
    (value) => value.name === "Reopen" || value.name === "Stop Progress",
  );
  if (reopen)
    await checked(
      session,
      "restore-legacy-fixture-status",
      "POST",
      `${path}/transitions`,
      auth,
      { transition: { id: reopen.id } },
      [204],
    );
  await checked(
    session,
    "prepare-legacy-field",
    "PUT",
    path,
    auth,
    { fields: { [fieldId]: null } },
    [204],
  );
}

const REQUIRED_FIELD_NAME = "Keiko required text";
const OPTIONAL_MARKER = "required-field-lifted.json";

const markerPath = (session) => join(session.directory, OPTIONAL_MARKER);

/** A marker left by a killed run means the requirement may still be lifted: restore it first. */
export async function recoverFixtureFieldRequirement(session) {
  if (!existsSync(markerPath(session))) return false;
  await withLabAdmin(session, (page) => setFixtureFieldRequirement(page, session, true));
  rmSync(markerPath(session));
  console.log(
    JSON.stringify({ operation: "jira-lab-admin", case: "required-field", recovered: true }),
  );
  return true;
}

/**
 * The qualification field is required in Jira's one default field configuration, which every
 * other project inherits. A lab that seeds other projects (the requirements lab) runs its writes
 * inside this bracket: a private marker is written, the requirement is lifted for the duration and
 * restored afterwards, also on failure; a restore failure never masks the work's own error. A
 * marker that survived a crash is recovered at the next bracket. No field, no bracket.
 */
export async function withFixtureFieldOptional(session, run) {
  const auth = basicAuth(session, "admin");
  const fields = await checked(session, "find-required-field", "GET", "/rest/api/2/field", auth);
  if (!fields.some((field) => field.name === REQUIRED_FIELD_NAME)) return run();
  await recoverFixtureFieldRequirement(session);
  privateJson(markerPath(session), { lifted: true });
  await withLabAdmin(session, (page) => setFixtureFieldRequirement(page, session, false));
  let result;
  try {
    result = await run();
  } catch (error) {
    await restoreAfterFailure(session, error);
    throw error;
  }
  await restoreRequirement(session);
  return result;
}

async function restoreRequirement(session) {
  await withLabAdmin(session, (page) => setFixtureFieldRequirement(page, session, true));
  rmSync(markerPath(session));
}

/** Keeps the marker for the next bracket when the restore fails; the work's error stays primary. */
async function restoreAfterFailure(session, error) {
  try {
    await restoreRequirement(session);
  } catch (restore) {
    error.cause ??= restore;
  }
}
