// The limit run outlasts one three-hour Jira test license (#4287). Before each step it renews
// the owned laboratory's window at the step boundary, never inside a step or a browser turn, by
// the same restart the scorecard lanes use. Nothing here changes clocks, licensing code or data.
import assert from "node:assert/strict";
import { renewLicenseWindow } from "./requirements/license-window.mjs";

/** Floor for every step: thirty minutes of the current window. */
export const LIMIT_LICENSE_FLOOR_SECONDS = 1800;
/**
 * Longer steps need a window that outlasts them, within the 7200 s ceiling of the shared
 * validator, so a freshly renewed three-hour window always satisfies it. A step is never split
 * across a restart. Steps not listed need only the floor.
 */
export const LIMIT_STEP_LICENSE_SECONDS = Object.freeze({
  "ac2-epics": 7200,
  "ac4-hierarchy": 5400,
  "ac6-sprint": 5400,
  "progress-simulation": 5400,
  "ac3-report": 3600,
});

export function limitStepLicenseSeconds(step) {
  return LIMIT_STEP_LICENSE_SECONDS[step] ?? LIMIT_LICENSE_FLOOR_SECONDS;
}

/**
 * Builds `ctx.checkLicense(step)`. A restart is recorded body-free in the run intent; a failed
 * renewal, or a window still too short afterwards, fails the step closed.
 */
export function createLimitLicenseGuard({ session, intent, renew = renewLicenseWindow }) {
  return async (step) => {
    const needed = limitStepLicenseSeconds(step);
    const count = (intent.state.licenseRenewal?.count ?? 0) + 1;
    const began = globalThis.performance.now();
    let renewal;
    try {
      renewal = await renew(session, session.directory, needed);
      assert.ok(
        renewal.remainingAfter >= needed,
        `The license window for step ${step} is shorter than the ${needed} seconds it needs`,
      );
    } catch (error) {
      intent.record("licenseRenewal", { phase: "failed", count, step, neededSeconds: needed });
      throw error;
    }
    if (renewal.restarted)
      intent.record("licenseRenewal", {
        phase: "renewed",
        count,
        step,
        remainingBefore: renewal.remainingBefore,
        remainingAfter: renewal.remainingAfter,
        downtimeMs: Math.ceil(globalThis.performance.now() - began),
      });
  };
}
