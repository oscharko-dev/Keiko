import { lstatSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { join, resolve } from "node:path";

export const DEFAULT_LAB_CONNECTION = Object.freeze({
  httpPort: 18081,
  httpsPort: 18443,
  jiraVersion: "10.3.26",
  jiraImageDigest: "ddcddc61ee43067fa274538b888d36408c47bc6a4ec14e41113dc304b8529168",
});
const SESSION_KEYS = new Set([
  "schemaVersion",
  "project",
  "httpPort",
  "syntheticOnly",
  "httpsPort",
  "jiraVersion",
  "jiraImageDigest",
]);

function labPort(value) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535)
    throw new TypeError("Invalid laboratory port");
  return value;
}

function labRelease(session) {
  const hasVersion = session.jiraVersion !== undefined;
  if (hasVersion !== (session.jiraImageDigest !== undefined))
    throw new TypeError("A laboratory release requires both exact version and digest");
  const jiraVersion = hasVersion ? session.jiraVersion : DEFAULT_LAB_CONNECTION.jiraVersion;
  const jiraImageDigest = hasVersion
    ? session.jiraImageDigest
    : DEFAULT_LAB_CONNECTION.jiraImageDigest;
  if (
    typeof jiraVersion !== "string" ||
    !/^(?:10\.[34]|11\.[23])\.(?:0|[1-9][0-9]{0,8})$/u.test(jiraVersion)
  )
    throw new TypeError("Unsupported laboratory release selection");
  if (typeof jiraImageDigest !== "string" || !/^[a-f0-9]{64}$/u.test(jiraImageDigest))
    throw new TypeError("A laboratory image requires an exact SHA-256 digest");
  return { jiraVersion, jiraImageDigest };
}

/** Fixed repository and loopback destinations; never accept an image, URL or environment map. */
export function labSessionConnection(session = DEFAULT_LAB_CONNECTION) {
  const httpPort = labPort(session.httpPort);
  const httpsPort = labPort(
    session.httpsPort === undefined ? DEFAULT_LAB_CONNECTION.httpsPort : session.httpsPort,
  );
  if (httpPort === httpsPort || httpsPort === 8080)
    throw new TypeError("Laboratory frontend ports must be distinct from their backend");
  const { jiraVersion, jiraImageDigest } = labRelease(session);
  return Object.freeze({
    httpPort,
    httpsPort,
    jiraVersion,
    jiraImageDigest,
    jiraImage: `atlassian/jira-software:${jiraVersion}@sha256:${jiraImageDigest}`,
    origin: `http://127.0.0.1:${httpPort}`,
    httpsOrigin: `https://127.0.0.1:${httpsPort}`,
  });
}

function sessionIdentity(session) {
  if (typeof session !== "object" || session === null || Array.isArray(session))
    throw new TypeError("Invalid synthetic session manifest");
  if (Object.keys(session).some((key) => !SESSION_KEYS.has(key)))
    throw new TypeError("Unknown synthetic session field");
  if (
    session.schemaVersion !== 1 ||
    session.syntheticOnly !== true ||
    typeof session.project !== "string" ||
    !/^keiko-jira-4081-[a-z0-9-]{1,32}$/u.test(session.project)
  )
    throw new TypeError("Invalid synthetic session identity");
}

export function normalizeLabSession(session, directory) {
  sessionIdentity(session);
  const pins = ["httpsPort", "jiraVersion", "jiraImageDigest"].filter((key) =>
    Object.hasOwn(session, key),
  );
  if (pins.length !== 0 && pins.length !== 3)
    throw new TypeError("Incomplete laboratory connection pins");
  return Object.freeze({
    schemaVersion: 1,
    syntheticOnly: true,
    project: session.project,
    directory: resolve(directory),
    ...labSessionConnection(session),
  });
}

export function loadSession(directory) {
  const root = resolve(directory);
  return normalizeLabSession(JSON.parse(readPrivateFile(join(root, "session.json"))), root);
}

/** Called only with an actual successful native serverInfo response, never an image tag. */
export function assertSessionServerInfo(session, value) {
  const expected = labSessionConnection(session).jiraVersion;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Native laboratory release observation is unavailable");
  const parts = expected.split(".").map(Number);
  if (
    value.version !== expected ||
    !Array.isArray(value.versionNumbers) ||
    value.versionNumbers.length !== 3 ||
    !parts.every((part, index) => value.versionNumbers[index] === part)
  )
    throw new TypeError("Native laboratory release does not match the session manifest");
  if (!new Set(["Server", "Data Center"]).has(value.deploymentType))
    throw new TypeError("Native laboratory deployment is not Jira Server or Data Center");
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
  const origin = labSessionConnection(session).origin;
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new TypeError("Laboratory origin escape");
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
