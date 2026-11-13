// The health of the lab's own Jira as its own closed state (#4369). An unreachable or starting Jira
// is never "0 seconds of license left": reading an outage as an expired license restarted the lab's
// stack in the middle of a lane (2026-11-13, S10 repeats 2 and 3), and the readiness turns that
// followed were graded as product failures. The states are closed, the wait for health is bounded,
// a journey that meets a down Jira is `invalid` (`lab-outage`), and before a restart destroys them
// the container's last log lines and its exit/OOM state are kept in the session directory.
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { basicAuth, labRequest, labSessionConnection } from "../lab-client.mjs";
import { privateJson } from "../private-json.mjs";

export const LAB_STATES = Object.freeze(["licensed", "expired", "unreachable", "starting"]);
/** How long the lab waits for its Jira to answer before the outage is final for this run. */
export const HEALTH_WAIT_MS = 300_000;
const POLL_MS = 5_000;
const LICENSE_PATH = "/rest/plugins/applications/1.0/installed/jira-software/license";
const LICENSE_MEDIA = "application/vnd.atl.plugins+json";
const LOG_LINES = 200;

/** A Jira that stayed down for the bound: a lab outage, never a product or model verdict. */
export class LabOutageError extends Error {
  constructor(reason) {
    super(`The laboratory Jira is ${reason}`);
    this.name = "LabOutageError";
    this.reason = reason;
  }
}

const isConnectionFailure = (error) =>
  error instanceof TypeError || error?.name === "TimeoutError" || error?.name === "AbortError";

/**
 * One reading of the lab's Jira: `licensed` (with the seconds left), `expired` (a real license
 * reading that is no longer valid), `starting` (it answers, but not yet with a license) or
 * `unreachable` (no answer at all).
 */
export async function labJiraState(session, { request = labRequest, now = Date.now } = {}) {
  let result;
  try {
    result = await request(
      session,
      "GET",
      LICENSE_PATH,
      basicAuth(session, "admin"),
      undefined,
      LICENSE_MEDIA,
    );
  } catch (error) {
    return stateOfFailure(error);
  }
  return stateOfAnswer(result, now);
}

function stateOfFailure(error) {
  if (!isConnectionFailure(error)) throw error;
  // An answer that is not JSON is Jira's startup page: reachable, but not ready.
  return { state: /not JSON/u.test(String(error?.message)) ? "starting" : "unreachable" };
}

function stateOfAnswer(result, now) {
  if (result.status === 503 || result.status === 404) return { state: "starting" };
  if (result.status !== 200) throw new TypeError("The laboratory license read was refused");
  const license = result.value;
  if (license?.valid !== true || license.expired !== false) return { state: "expired" };
  const remaining = Math.floor((Number(license.expiryDate) - now()) / 1000);
  return remaining > 0 ? { state: "licensed", remaining } : { state: "expired" };
}

/** Polls until Jira answers with a license reading, within the bound; otherwise a lab outage. */
const WAIT_DEFAULTS = {
  boundMs: HEALTH_WAIT_MS,
  pollMs: POLL_MS,
  sleep: delay,
  now: Date.now,
  onDown: () => undefined,
};

export async function waitForJiraHealth(session, options = {}) {
  const {
    probe = labJiraState,
    boundMs,
    pollMs,
    sleep,
    now,
    onDown,
  } = {
    ...WAIT_DEFAULTS,
    ...options,
  };
  const deadline = now() + boundMs;
  let announced = false;
  for (;;) {
    const reading = await probe(session);
    if (reading.state === "licensed" || reading.state === "expired") return reading;
    if (!announced) {
      announced = true;
      await onDown(reading);
    }
    if (now() >= deadline) throw new LabOutageError(reading.state);
    await sleep(pollMs);
  }
}

/** Whether the HTTPS front the product path uses answers Jira's status with the lab's own CA. */
export function frontAnswers(session, ca) {
  const { httpsPort } = labSessionConnection(session);
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port: httpsPort,
        path: "/status",
        ca,
        servername: "localhost",
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve(res.statusCode === 200 && /"RUNNING"/u.test(Buffer.concat(chunks).toString())),
        );
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Waits until Keiko's route to Jira (the front) is usable again after a restart, within the bound. */
export async function waitForFront(
  session,
  { answers, boundMs = HEALTH_WAIT_MS, pollMs = POLL_MS, sleep = delay, now = Date.now } = {},
) {
  const deadline = now() + boundMs;
  while (!(await answers(session))) {
    if (now() >= deadline) throw new LabOutageError("front-unreachable");
    await sleep(pollMs);
  }
}

const SERVICE_NAMES = new Set(["jira", "tls", "database"]);

/** The lab's containers (this session's own Compose project only) with their exit/OOM state. */
async function containerFacts(session, docker) {
  const ids = (
    await docker([
      "ps",
      "-a",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${session.project}`,
    ])
  )
    .split("\n")
    .filter((id) => /^[a-f0-9]{12,64}$/u.test(id));
  const facts = [];
  for (const id of ids) {
    const inspected = JSON.parse(await docker(["inspect", id]))[0];
    const service = inspected.Config?.Labels?.["com.docker.compose.service"];
    if (!SERVICE_NAMES.has(service)) continue;
    const state = inspected.State ?? {};
    facts.push({
      service,
      state: {
        status: state.Status,
        running: state.Running,
        oomKilled: state.OOMKilled,
        exitCode: state.ExitCode,
        startedAt: state.StartedAt,
        finishedAt: state.FinishedAt,
        restartCount: inspected.RestartCount,
      },
      logTail: (await docker(["logs", "--tail", String(LOG_LINES), id]))
        .split("\n")
        .slice(-LOG_LINES),
    });
  }
  return facts;
}

/**
 * Keeps the last log lines and the exit/OOM state of the lab's containers in
 * `<session>/lab-outage/<timestamp>.json` before a restart or recreation destroys them. A capture
 * that fails is recorded as such and never masks the outage it was taken for.
 */
export async function captureOutageEvidence(
  session,
  directory,
  { docker, now = () => new Date().toISOString(), reason = "unknown" } = {},
) {
  const stamp = now();
  // Loaded on demand: the Docker edge is only needed when an outage is being recorded.
  const run = docker ?? (await import("../lab-services.mjs")).labDocker;
  let record;
  try {
    record = {
      schemaVersion: 1,
      capturedAt: stamp,
      reason,
      containers: await containerFacts(session, run),
    };
  } catch (error) {
    record = {
      schemaVersion: 1,
      capturedAt: stamp,
      reason,
      captureFailed: true,
      errorName: error?.name ?? "Error",
    };
  }
  const path = join(directory, "lab-outage", `${stamp.replaceAll(":", "-")}.json`);
  mkdirSync(join(directory, "lab-outage"), { recursive: true, mode: 0o700 });
  privateJson(path, record, true);
  return path;
}

/** The CA the lab's front is served with; the product path trusts exactly this one. */
export const labFrontAnswers = (session) =>
  frontAnswers(session, readFileSync(join(session.directory, "secrets", "tls", "ca.pem")));
