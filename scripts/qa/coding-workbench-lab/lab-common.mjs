// Shared helpers for the Coding Workbench live-lab drivers (see README.md in this directory).
// Lab tooling for a local operator: it records no prompts, model output or credentials, and the one
// credential it needs, the dev server's launcher secret, is read from the environment only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { parseArgs } from "node:util";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_BASE_URL = "http://127.0.0.1:1983";
export const CSRF_HEADERS = Object.freeze({
  "content-type": "application/json",
  "x-keiko-csrf": "1",
});
// The runtime state machine (packages/keiko-contracts coding-workbench-runtime.ts) has no step after these.
export const TERMINAL_STATES = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
  "recovery-required",
]);
export const MODES = Object.freeze([
  { label: "Ask for approval", id: "governed-assist" },
  { label: "Supervised workspace", id: "supervised-coding" },
  { label: "Full access", id: "autonomous-delivery" },
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TASKS_FILE = new URL("./tasks.json", import.meta.url);
const MIN_RUN_SUFFIX_LENGTH = 6;

/** A mistake in how the operator invoked a script: reported as usage, exit code 2. */
export class UsageError extends Error {}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a script's async main(); its return value is the process exit code. */
export function runMain(main) {
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (error) => {
      console.error(error instanceof UsageError ? error.message : `lab: ${errorMessage(error)}`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}

/** Strict option parsing with a built-in --help; `help: true` means the usage text was printed. */
export function parseCli({ argv = process.argv.slice(2), usage, options, positionals = false }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { help: { type: "boolean", short: "h" }, ...options },
      allowPositionals: positionals,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(`${errorMessage(error)}\n\n${usage}`);
  }
  const help = parsed.values.help === true;
  if (help) console.log(usage);
  return { help, values: parsed.values, positionals: parsed.positionals };
}

export function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

export function resolveMode(input = MODES[1].label) {
  const wanted = input.trim().toLowerCase();
  const mode = MODES.find((m) => m.id === wanted || m.label.toLowerCase() === wanted);
  if (mode === undefined) {
    const known = MODES.map((m) => `"${m.label}" (${m.id})`).join(", ");
    throw new UsageError(`unknown mode "${input}"; use one of ${known}`);
  }
  return mode;
}

/** The dev server origin, from --base-url, KEIKO_LAB_BASE_URL or the default; loopback http only. */
export function labBaseUrl(override, env = process.env) {
  const raw = override ?? env.KEIKO_LAB_BASE_URL ?? DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`the base URL is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new UsageError(
      `the lab drivers send a pairing attestation, so they only talk to a loopback http dev server (got ${url.origin})`,
    );
  }
  return url.origin;
}

/** The dev server redirects page loads from 127.0.0.1 to localhost, so a browser must use localhost. */
export function browserBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  return url.origin;
}

export function minutesToMs(value, flag = "--timeout-min") {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new UsageError(`${flag} must be a positive number of minutes (got "${value}")`);
  }
  return minutes * 60_000;
}

export function parseApprove(value) {
  if (value !== "all" && value !== "none" && value !== "ask") {
    throw new UsageError(`--approve must be all, none or ask (got "${value}")`);
  }
  return value;
}

export function labRepositoryPath(explicit, env = process.env) {
  const raw = explicit ?? env.KEIKO_LAB_REPO;
  if (raw === undefined || raw === "") {
    throw new UsageError("pass --repo <path> or set KEIKO_LAB_REPO to the lab repository checkout");
  }
  return resolve(raw);
}

/** Normalizes `run-123...` or a trailing part of the id; refuses suffixes that would match the whole log. */
export function normalizeRunSuffix(input) {
  const suffix = (input ?? "").replace(/^run-/u, "");
  if (suffix.length < MIN_RUN_SUFFIX_LENGTH) {
    throw new UsageError(
      `pass a run id (run-<digits>) or at least ${String(MIN_RUN_SUFFIX_LENGTH)} trailing digits of one`,
    );
  }
  return suffix;
}

/** Imports a module from a built workspace package; the checkout must have run `npm run build:packages`. */
export async function importBuilt(packageName, subpath) {
  const file = join(REPO_ROOT, "packages", packageName, "dist", subpath);
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error(
      `cannot load ${packageName}/dist/${subpath}: run "npm run build:packages" in the Keiko checkout first`,
      { cause: error },
    );
  }
}

/** Mints one single-use pairing attestation (valid about 30 s) from the launcher secret in the environment. */
export async function mintPairing(env = process.env) {
  const contracts = await importBuilt("keiko-contracts", "coding-app-session.js");
  const pairing = await importBuilt(
    "keiko-server",
    "coding-app-session/launcherSessionPairingPort.js",
  );
  const envName = contracts.CODING_APP_SESSION_LAUNCHER_SECRET_ENV;
  const minChars = contracts.CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS;
  const secret = env[envName];
  if (typeof secret !== "string" || secret.length < minChars) {
    throw new UsageError(
      `${envName} must hold the launcher secret the dev server was started with (at least ${String(minChars)} characters); see README.md`,
    );
  }
  const attestation = pairing.mintLauncherPairingAttestation({
    secret,
    requestId: `lab-${randomUUID()}`,
    issuedAtMs: Date.now(),
  });
  return { attestation, fragment: contracts.encodeCodingAppSessionPairingFragment(attestation) };
}

async function callJson(baseUrl, headers, method, path, body) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return {
    status: response.status,
    json,
    correlationId: response.headers.get("x-keiko-correlation-id"),
  };
}

/** Pairs an app session over HTTP and returns request(method, path, body) bound to its cookie. */
export async function openApiSession(baseUrl, env = process.env) {
  const { attestation } = await mintPairing(env);
  const cookies = await importBuilt("keiko-server", "coding-app-session/sessionCookie.js");
  const paired = await globalThis.fetch(`${baseUrl}/api/coding-workbench/app-session/pair`, {
    method: "POST",
    headers: CSRF_HEADERS,
    body: JSON.stringify(attestation),
  });
  const prefix = `${cookies.APP_SESSION_COOKIE_NAME}=`;
  const cookie = paired.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .find((entry) => entry.startsWith(prefix));
  if (cookie === undefined) {
    throw new Error(
      `pairing failed (HTTP ${String(paired.status)}); is the dev server running with the same launcher secret?`,
    );
  }
  const headers = { ...CSRF_HEADERS, cookie };
  return { request: (method, path, body) => callJson(baseUrl, headers, method, path, body) };
}

/** One progress line for a run snapshot: state, revision and the kind of a pending permission. */
export function describeSnapshot(snapshot) {
  const pending = snapshot.pendingPermission;
  const kind = pending?.kind ?? pending?.permission ?? pending?.toolName ?? "?";
  const waiting = pending ? ` pending=${kind}` : "";
  return `${snapshot.state} rev=${snapshot.revision}${waiting}`;
}

export function exitCodeForState(state) {
  if (state === "succeeded") return 0;
  return TERMINAL_STATES.includes(state) ? 1 : 3;
}

export function loadTasks() {
  return JSON.parse(readFileSync(TASKS_FILE, "utf8"));
}

export function formatTaskList() {
  return loadTasks()
    .map(
      (task) =>
        `${task.id.padEnd(4)} ${task.mode.padEnd(21)} ${task.baseline.padEnd(8)} ${task.title}`,
    )
    .join("\n");
}

function findCatalogTask(id) {
  if (id === undefined) return undefined;
  const task = loadTasks().find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new UsageError(`unknown task id "${id}"; the catalog is:\n${formatTaskList()}`);
  }
  return task;
}

/** The task text and mode for --task and/or --task-id (a catalog id from tasks.json). */
export function resolveTaskInput(values) {
  const catalogTask = findCatalogTask(values["task-id"]);
  const text = values.task ?? catalogTask?.text;
  if (text === undefined || text.trim() === "") {
    throw new UsageError("pass --task <text> or --task-id <id> (see --list-tasks)");
  }
  return { text, mode: resolveMode(values.mode ?? catalogTask?.mode), taskId: catalogTask?.id };
}
