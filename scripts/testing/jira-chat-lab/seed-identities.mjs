import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureFixtureToken } from "./fixture-tokens.mjs";
import { actorDetails, basicAuth, checked, labRequest, readPrivateFile } from "./lab-client.mjs";

export async function ensureFixtureIdentity(session, actor, lifecycle = {}) {
  if (actor === "admin") throw new TypeError("Administrator is provisioned by Jira setup");
  const details = actorDetails(actor);
  const path = join(session.directory, "secrets", details.passwordFile);
  if (!existsSync(path))
    writeFileSync(path, randomBytes(24).toString("base64url"), { mode: 0o600, flag: "wx" });
  const admin = basicAuth(session, "admin");
  const result = await labRequest(
    session,
    "GET",
    `/rest/api/2/user?username=${details.name}`,
    admin,
  );
  if (result.status !== 200 && result.status !== 404)
    throw new TypeError("Unexpected synthetic identity state");
  if (result.status === 404)
    await identityWrite(session, actor, lifecycle, "create-user", "/rest/api/2/user", admin, {
      name: details.name,
      password: readPrivateFile(path),
      emailAddress: `${actor}@example.invalid`,
      displayName: `Synthetic ${actor}`,
      applicationKeys: ["jira-software"],
      notification: false,
    });
  const auth = await ensureFixtureToken(session, actor);
  const identity = await checked(session, "pat-identity", "GET", "/rest/api/2/myself", auth);
  if (identity.name !== details.name || identity.active !== true)
    throw new TypeError("Unexpected PAT identity");
  const permissions = await checked(
    session,
    "non-admin-identity",
    "GET",
    "/rest/api/2/mypermissions?permissions=ADMINISTER",
    auth,
  );
  if (permissions.permissions.ADMINISTER.havePermission !== false)
    throw new TypeError("Fixture actor is unexpectedly privileged");
  return auth;
}

async function identityWrite(session, actor, lifecycle, name, path, auth, body) {
  const intent = { actor, name, method: "POST", path };
  await lifecycle.beforeWrite?.(intent);
  const value = await checked(session, name, "POST", path, auth, body);
  await lifecycle.afterWrite?.(intent);
  return value;
}

/** Own disposable qualification sessions only: reuse normal PAT creation and verify native admin. */
export async function ensureFixtureAdminToken(session) {
  const auth = await ensureFixtureToken(session, "admin");
  const identity = await checked(
    session,
    "qualification-admin-identity",
    "GET",
    "/rest/api/2/myself",
    auth,
  );
  if (identity.name !== "keiko-admin" || identity.active !== true)
    throw new TypeError("Unexpected qualification administrator identity");
  const permissions = await checked(
    session,
    "qualification-admin-permission",
    "GET",
    "/rest/api/2/mypermissions?permissions=ADMINISTER",
    auth,
  );
  if (permissions.permissions?.ADMINISTER?.havePermission !== true)
    throw new TypeError("Qualification requires actual native administration permission");
}
