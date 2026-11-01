// Keeps the published three-hour test license usable for a scenario group (#4174).
// The test license counts from Jira's start, so a normal container restart opens a new window.
// Nothing here changes clocks, licensing code or license data.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { basicAuth, labRequest } from "../lab-client.mjs";
import { enterActive, withExclusiveRestart } from "./lab-lanes.mjs";

const LICENSE_PATH = "/rest/plugins/applications/1.0/installed/jira-software/license";
const LICENSE_MEDIA = "application/vnd.atl.plugins+json";
const SESSION_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "session.mjs");
const READY_TIMEOUT_MS = 600_000;

function remainingSeconds(license) {
  const usable = license?.valid === true && license.expired === false;
  return usable ? Math.max(0, Math.floor((Number(license.expiryDate) - Date.now()) / 1000)) : 0;
}

/** Remaining license seconds; 0 while Jira is unreachable or starting (fetch rejects as TypeError). */
async function licenseRemainingSeconds(session) {
  try {
    const result = await labRequest(
      session,
      "GET",
      LICENSE_PATH,
      basicAuth(session, "admin"),
      undefined,
      LICENSE_MEDIA,
    );
    return result.status === 200 ? remainingSeconds(result.value) : 0;
  } catch (error) {
    if (error instanceof TypeError || error?.name === "TimeoutError") return 0;
    throw error;
  }
}

function runSession(action, directory) {
  const result = spawnSync(process.execPath, [SESSION_SCRIPT, action, directory], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) throw new TypeError(`Laboratory session ${action} failed`);
}

async function waitForLicense(session, minimumSeconds) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = await licenseRemainingSeconds(session);
    if (remaining >= minimumSeconds) return remaining;
    await delay(5_000);
  }
  throw new TypeError("Jira did not report a valid license after restart");
}

/**
 * Restarts the laboratory when less than `minimumSeconds` of license time remain, then marks this
 * lane as using Jira.
 */
export async function ensureLicenseWindow(session, directory, minimumSeconds) {
  const remaining = await renewedLicense(session, directory, minimumSeconds);
  await enterActive(directory);
  return remaining;
}

async function renewedLicense(session, directory, minimumSeconds) {
  const remaining = await licenseRemainingSeconds(session);
  if (remaining >= minimumSeconds) {
    console.log(
      JSON.stringify({ operation: "jira-lab-license-window", restarted: false, remaining }),
    );
    return remaining;
  }
  // Another lane may be mid-turn on this Jira: restart only when no other lane is active.
  const restarted = await withExclusiveRestart(
    directory,
    async () => (await licenseRemainingSeconds(session)) < minimumSeconds,
    async () => {
      runSession("stop", directory);
      runSession("start", directory);
      return waitForLicense(session, minimumSeconds);
    },
  );
  const renewed = restarted ?? (await licenseRemainingSeconds(session));
  console.log(
    JSON.stringify({
      operation: "jira-lab-license-window",
      restarted: restarted !== undefined,
      remaining: renewed,
    }),
  );
  return renewed;
}
