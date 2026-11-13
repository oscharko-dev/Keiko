// Keeps the published three-hour test license usable for a scenario group (#4174).
// The test license counts from Jira's start, so a normal container restart opens a new window.
// Nothing here changes clocks, licensing code or license data.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { enterActive, withExclusiveRestart } from "./lab-lanes.mjs";
import {
  LabOutageError,
  captureOutageEvidence,
  labFrontAnswers,
  labJiraState,
  waitForFront,
  waitForJiraHealth,
} from "./lab-health.mjs";

const SESSION_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "session.mjs");
const READY_TIMEOUT_MS = 600_000;
/** Longer than the longest journey seen, so a lane already inside one still ends in the window. */
const JOURNEY_LICENSE_SECONDS = 2_700;

function runSession(action, directory) {
  const result = spawnSync(process.execPath, [SESSION_SCRIPT, action, directory], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) throw new TypeError(`Laboratory session ${action} failed`);
}

/** After a restart: a real license reading with enough time, then Keiko's route to Jira usable. */
async function waitForLicense(session, minimumSeconds, ports) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reading = await ports.probe(session);
    if (reading.state === "licensed" && reading.remaining >= minimumSeconds) {
      await ports.waitFront(session);
      return reading.remaining;
    }
    await delay(5_000);
  }
  throw new TypeError("Jira did not report a valid license after restart");
}

/**
 * Restarts the laboratory when less than `minimumSeconds` of license time remain, then marks this
 * lane as using Jira.
 */
export async function ensureLicenseWindow(session, directory, minimumSeconds, ports) {
  return (await renewLicenseWindow(session, directory, minimumSeconds, ports)).remainingAfter;
}

/**
 * Same renewal, with what happened: whether this call restarted the owned laboratory, the license
 * seconds left before it and after it. Only this session's own compose project is restarted.
 */
export async function renewLicenseWindow(session, directory, minimumSeconds, ports = {}) {
  if (!Number.isSafeInteger(minimumSeconds) || minimumSeconds < 1 || minimumSeconds > 7200)
    throw new TypeError("Invalid laboratory license window");
  const renewal = await renewedLicense(session, directory, minimumSeconds, healthPorts(ports));
  await enterActive(directory);
  return renewal;
}

/**
 * Runs each journey inside a license window that outlasts it. Two lanes need longer than the
 * three-hour license, so checking only at the start lets Jira refuse every later write and turns
 * the rest of the scorecard red. A lane needing a renewal waits at this boundary until every other
 * lane reached it too, because they read the same license.
 */
export async function eachJourneyInLicenseWindow(ids, ensureWindow, run, index = 0) {
  if (index >= ids.length) return;
  await ensureWindow(JOURNEY_LICENSE_SECONDS);
  await run(ids[index]);
  await eachJourneyInLicenseWindow(ids, ensureWindow, run, index + 1);
}

/** The injectable edges of the renewal: probing, waiting, evidence, restarting. */
function healthPorts(ports) {
  return {
    probe: labJiraState,
    waitHealth: waitForJiraHealth,
    waitFront: (session) => waitForFront(session, { answers: labFrontAnswers }),
    capture: captureOutageEvidence,
    restart: (directory) => {
      runSession("stop", directory);
      runSession("start", directory);
    },
    log: (line) => console.log(line),
    ...ports,
  };
}

/**
 * Renews the window only on a real license reading that is expired or too short. A Jira that does
 * not answer is waited for within a bound and is never read as an expired license: its evidence is
 * kept first, and a Jira that stays down ends the run as a lab outage (`LabOutageError`).
 */
async function renewedLicense(session, directory, minimumSeconds, ports) {
  const reading = await ports.waitHealth(session, {
    probe: ports.probe,
    onDown: (down) => ports.capture(session, directory, { reason: `before-wait-${down.state}` }),
  });
  const remaining = reading.state === "licensed" ? reading.remaining : 0;
  if (remaining >= minimumSeconds) {
    ports.log(
      JSON.stringify({ operation: "jira-lab-license-window", restarted: false, remaining }),
    );
    return { restarted: false, remainingBefore: remaining, remainingAfter: remaining };
  }
  const stillNeeded = async () => {
    const now = await ports.probe(session);
    return now.state === "expired" || (now.state === "licensed" && now.remaining < minimumSeconds);
  };
  // Another lane may be mid-turn on this Jira: restart only when no other lane is active.
  const restarted = await withExclusiveRestart(directory, stillNeeded, async () => {
    await ports.capture(session, directory, { reason: "before-license-restart" });
    ports.restart(directory);
    return waitForLicense(session, minimumSeconds, ports);
  });
  const after = await ports.waitHealth(session, { probe: ports.probe });
  const renewed = restarted ?? (after.state === "licensed" ? after.remaining : 0);
  ports.log(
    JSON.stringify({
      operation: "jira-lab-license-window",
      restarted: restarted !== undefined,
      remaining: renewed,
    }),
  );
  return {
    restarted: restarted !== undefined,
    remainingBefore: remaining,
    remainingAfter: renewed,
  };
}

export { LabOutageError };
