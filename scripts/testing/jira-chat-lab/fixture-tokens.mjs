// Renewal belongs to the existing disposable lab fixture owner, before a product run binds a PAT.
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actorDetails, basicAuth, labRequest, readPrivateFile } from "./lab-client.mjs";

const TOKEN_NAME = "Keiko synthetic 4081 session";
const TOKEN_PATH = "/rest/pat/latest/tokens";

function tokenExpiry(token) {
  const value = token?.expiringAt;
  const expiry =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(expiry) || expiry <= 0)
    throw new TypeError("Native PAT expiry is unavailable");
  return expiry;
}
async function tokens(session, actor) {
  const result = await labRequest(session, "GET", TOKEN_PATH, basicAuth(session, actor));
  if (
    result.status !== 200 ||
    !Array.isArray(result.value) ||
    result.value.length > 100 ||
    result.value.some((row) => !Number.isSafeInteger(row?.id) || row.id < 1)
  )
    throw new TypeError("Native PAT inventory is unavailable");
  return result.value;
}
async function verifyIdentity(session, actor, auth) {
  const result = await labRequest(session, "GET", "/rest/api/2/myself", auth);
  if (
    result.status !== 200 ||
    result.value?.name !== actorDetails(actor).name ||
    result.value.active !== true
  )
    throw new TypeError("Unexpected laboratory PAT identity");
}
function ownedToken(inventory, current) {
  const matches = inventory.filter((row) => row.name === TOKEN_NAME);
  if (matches.length !== (current === undefined ? 0 : 1))
    throw new TypeError("Owned laboratory PAT is ambiguous or missing");
  return matches[0];
}
function beginRenewal(session, actor, current, inventory) {
  const root = join(session.directory, "secrets");
  const pending = join(root, `${actor}-pat-renewal.pending.json`);
  if (current === undefined) {
    const marker = actor === "api" ? "pat-creation-started" : `${actor}-pat-creation-started`;
    writeFileSync(join(root, marker), "1\n", { mode: 0o600, flag: "wx" });
  }
  writeFileSync(
    pending,
    JSON.stringify({ schemaVersion: 1, priorIds: inventory.map((row) => row.id) }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return pending;
}
function assertFreshReplacement(result, inventory) {
  const value = result.value;
  if (
    !new Set([200, 201]).has(result.status) ||
    !Number.isSafeInteger(value?.id) ||
    value.id < 1 ||
    value.name !== TOKEN_NAME ||
    typeof value.rawToken !== "string" ||
    value.rawToken.trim().length === 0 ||
    inventory.some((row) => row.id === value.id)
  )
    throw new TypeError("Native PAT replacement is unconfirmed");
  return value;
}

async function createReplacement(session, actor, inventory, minimumSeconds) {
  const result = await labRequest(session, "POST", TOKEN_PATH, basicAuth(session, actor), {
    name: TOKEN_NAME,
    expirationDuration: 1,
  });
  const value = assertFreshReplacement(result, inventory);
  const readback = (await tokens(session, actor)).filter(
    (row) => row.id === value.id && row.name === TOKEN_NAME,
  );
  if (readback.length !== 1 || tokenExpiry(readback[0]) - Date.now() <= minimumSeconds * 1000)
    throw new TypeError("Replacement PAT has insufficient native validity");
  await verifyIdentity(session, actor, `Bearer ${value.rawToken}`);
  return value;
}
async function retirePredecessor(session, actor, prior) {
  if (prior === undefined) return;
  const result = await labRequest(
    session,
    "DELETE",
    `${TOKEN_PATH}/${prior.id}`,
    basicAuth(session, actor),
  );
  if (
    !new Set([200, 204, 404]).has(result.status) ||
    (await tokens(session, actor)).some((row) => row.id === prior.id)
  )
    throw new TypeError("Predecessor PAT retirement is unconfirmed");
}

function assertCredentialUnchanged(path, current, marker) {
  const live = existsSync(path) ? readPrivateFile(path) : undefined;
  if (live === current) return;
  unlinkSync(marker);
  throw new TypeError("Laboratory PAT changed before renewal dispatch");
}

function validateTokenWindow(minimumSeconds) {
  if (!Number.isSafeInteger(minimumSeconds) || minimumSeconds < 1 || minimumSeconds > 86_000)
    throw new TypeError("Invalid laboratory PAT window");
}

export async function ensureFixtureToken(session, actor, minimumSeconds = 3600) {
  actorDetails(actor);
  validateTokenWindow(minimumSeconds);
  const path = join(session.directory, "secrets", `${actor}-token`);
  const pending = join(session.directory, "secrets", `${actor}-pat-renewal.pending.json`);
  if (existsSync(pending) || existsSync(`${path}.next`))
    throw new TypeError("Reconcile the private PAT renewal intent before retrying");
  const current = existsSync(path) ? readPrivateFile(path) : undefined;
  const inventory = await tokens(session, actor);
  const prior = ownedToken(inventory, current);
  if (current !== undefined && tokenExpiry(prior) > Date.now())
    await verifyIdentity(session, actor, `Bearer ${current}`);
  if (current !== undefined && tokenExpiry(prior) - Date.now() > minimumSeconds * 1000)
    return `Bearer ${current}`;
  const marker = beginRenewal(session, actor, current, inventory);
  assertCredentialUnchanged(path, current, marker);
  const replacement = await createReplacement(session, actor, inventory, minimumSeconds);
  const next = `${path}.next`;
  writeFileSync(next, replacement.rawToken, { mode: 0o600, flag: "wx" });
  renameSync(next, path);
  await retirePredecessor(session, actor, prior);
  unlinkSync(marker);
  console.log(
    JSON.stringify({
      operation: "jira-lab-pat-window",
      renewed: current !== undefined,
      valid: true,
    }),
  );
  return `Bearer ${replacement.rawToken}`;
}
