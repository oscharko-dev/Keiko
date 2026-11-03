import { lstatSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { join, resolve } from "node:path";

export function loadSession(directory) {
  const root = resolve(directory);
  const session = JSON.parse(readFileSync(join(root, "session.json"), "utf8"));
  if (
    session.schemaVersion !== 1 ||
    session.syntheticOnly !== true ||
    !Number.isSafeInteger(session.httpPort) ||
    session.httpPort < 1024 ||
    session.httpPort > 65535
  )
    throw new TypeError("Invalid synthetic session");
  return { ...session, directory: root, origin: `http://127.0.0.1:${session.httpPort}` };
}

export function readPrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new TypeError("Laboratory credential must be a private regular file");
  return readFileSync(path, "utf8").trim();
}

export function actorDetails(actor) {
  const actors = new Set(["admin", "api", "restricted", "editor", "assignee"]);
  if (!actors.has(actor)) throw new TypeError("Unknown synthetic actor");
  return {
    name: `keiko-${actor}`,
    passwordFile: actor === "api" ? "api-user-password" : `${actor}-password`,
  };
}

export function basicAuth(session, actor) {
  const details = actorDetails(actor);
  const password = readPrivateFile(join(session.directory, "secrets", details.passwordFile));
  return `Basic ${Buffer.from(`${details.name}:${password}`).toString("base64")}`;
}

async function jsonBody(response) {
  const chunks = [];
  let bytes = 0;
  if (!response.body) return undefined;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 1_048_576) throw new TypeError("Laboratory response exceeds bound");
    chunks.push(chunk);
  }
  if (bytes === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TypeError("Laboratory response is not JSON");
  }
}

export async function labRequest(session, method, path, auth, body, accept = "application/json") {
  if (!path.startsWith("/rest/")) throw new TypeError("Unexpected laboratory API path");
  const url = new URL(path, session.origin);
  if (url.origin !== session.origin) throw new TypeError("Laboratory origin escape");
  const response = await globalThis.fetch(url, {
    method,
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(30_000),
    headers: {
      Accept: accept,
      Authorization: auth,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, value: await jsonBody(response) };
}

export async function checked(session, name, method, path, auth, body, expected = [200, 201, 204]) {
  const result = await labRequest(session, method, path, auth, body);
  const passed = expected.includes(result.status);
  console.log(
    JSON.stringify({ operation: "jira-lab-fixture", case: name, status: result.status, passed }),
  );
  if (!passed) throw new TypeError("Laboratory API rejected the fixture operation");
  return result.value;
}

export async function requireLicense(session) {
  const result = await labRequest(
    session,
    "GET",
    "/rest/plugins/applications/1.0/installed/jira-software/license",
    basicAuth(session, "admin"),
    undefined,
    "application/vnd.atl.plugins+json",
  );
  const remaining = Math.floor((Number(result.value?.expiryDate) - Date.now()) / 1000);
  const valid =
    result.status === 200 &&
    result.value?.valid === true &&
    result.value?.expired === false &&
    remaining > 300;
  console.log(
    JSON.stringify({
      operation: "jira-lab-license",
      valid,
      remainingSeconds: Number.isFinite(remaining) ? remaining : 0,
    }),
  );
  if (!valid) throw new TypeError("A valid laboratory session is required");
  return remaining;
}
