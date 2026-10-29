import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { actorDetails, basicAuth, checked, labRequest, readPrivateFile } from "./lab-client.mjs";

export async function ensureFixtureIdentity(session, actor) {
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
    await checked(session, "create-user", "POST", "/rest/api/2/user", admin, {
      name: details.name,
      password: readPrivateFile(path),
      emailAddress: `${actor}@example.invalid`,
      displayName: `Synthetic ${actor}`,
      applicationKeys: ["jira-software"],
      notification: false,
    });
  const auth = await ensureToken(session, actor);
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

async function ensureToken(session, actor) {
  const path = join(session.directory, "secrets", `${actor}-token`);
  if (existsSync(path)) return `Bearer ${readPrivateFile(path)}`;
  // Persist intent before dispatch; a lost response must never create another PAT implicitly.
  const marker = actor === "api" ? "pat-creation-started" : `${actor}-pat-creation-started`;
  writeFileSync(join(session.directory, "secrets", marker), "1\n", { mode: 0o600, flag: "wx" });
  const token = await checked(
    session,
    "create-pat",
    "POST",
    "/rest/pat/latest/tokens",
    basicAuth(session, actor),
    { name: "Keiko synthetic 4081 session", expirationDuration: 1 },
  );
  if (typeof token?.rawToken !== "string" || token.rawToken.length === 0)
    throw new TypeError("Missing laboratory PAT");
  writeFileSync(path, token.rawToken, { mode: 0o600, flag: "wx" });
  return `Bearer ${token.rawToken}`;
}
