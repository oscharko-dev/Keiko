import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  REGISTRY_OBSERVATION_TIMEOUT_MS,
  waitForVerifiedPackageState,
} from "../lib/npm-registry-observation.mjs";

// GITHUB_TOKEN carries only the permissions a job declares, and GitHub's permission data for
// installation tokens requires attestations:read to list attestations and deployments:read to list
// deployments. release-publish.mjs does both after the npm-publish approval: `gh attestation verify`
// for the Windows setup companion once the GitHub release exists, and the alignment gate after npm
// already holds the release. No publish job ran after either call became reachable, so neither grant
// was ever exercised; reading the job against the publisher found both missing on 2026-09-14.

const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
const publisher = readFileSync("scripts/release-publish.mjs", "utf8");
const alignment = readFileSync("scripts/check-release-alignment.mjs", "utf8");

describe("release publish job token", () => {
  it("still makes the two reads the grants below exist for", () => {
    expect(publisher).toMatch(/"attestation",\s*"verify"/u);
    expect(publisher).toContain("checkReleaseAlignment(");
    expect(alignment).toMatch(/\/deployments\?environment=/u);
  });

  it("grants exactly what the publish path uses", () => {
    expect(workflow.jobs.publish.permissions).toEqual({
      actions: "read",
      attestations: "read",
      checks: "read",
      contents: "write",
      deployments: "read",
      "id-token": "write",
      statuses: "read",
    });
  });

  it("budgets npm trusted-publishing registry quarantine without a classic token", () => {
    const publishJob = workflow.jobs.publish;
    const publishStep = publishJob.steps.find((step) => step.name === "Publish package");

    expect(publishStep.env.KEIKO_RELEASE_VERIFY_ATTEMPTS).toBe("80");
    expect(publishStep.env.KEIKO_RELEASE_VERIFY_DELAY_MS).toBe("60000");
    const attempts = Number(publishStep.env.KEIKO_RELEASE_VERIFY_ATTEMPTS);
    const delayMs = Number(publishStep.env.KEIKO_RELEASE_VERIFY_DELAY_MS);
    // Every read timing out is the slowest the verification can be. It, plus the work before the
    // publish (install, build, gates) and after it (registry install smoke), stays inside the job
    // timeout, so the timeout still bounds the whole wait.
    const worstCaseMs = attempts * REGISTRY_OBSERVATION_TIMEOUT_MS * 2 + (attempts - 1) * delayMs;
    const surroundingWorkMs = 30 * 60 * 1_000;
    expect(worstCaseMs + surroundingWorkMs).toBeLessThanOrEqual(
      publishJob["timeout-minutes"] * 60 * 1_000,
    );
    expect(publishStep.env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(publishStep.env.NPM_TOKEN).toBeUndefined();
  });

  // Release 1.3.2: npm accepted the publish at 06:48:46 UTC and first served the version at 07:44,
  // 56 minutes later; the 15-minute window then failed a successful publish (#4125).
  it("waits out the 56-minute quarantine release 1.3.2 met, with margin (#4125)", () => {
    const publishStep = workflow.jobs.publish.steps.find((step) => step.name === "Publish package");
    const attempts = Number(publishStep.env.KEIKO_RELEASE_VERIFY_ATTEMPTS);
    const delayMs = Number(publishStep.env.KEIKO_RELEASE_VERIFY_DELAY_MS);
    const pkg = {
      name: "@oscharko-dev/keiko",
      spec: "@oscharko-dev/keiko@1.3.2",
      version: "1.3.2",
    };
    const visibleAfterMs = 75 * 60 * 1_000;
    let clockMs = 0;
    const read = () => {
      const state =
        clockMs >= visibleAfterMs
          ? { kind: "available", version: pkg.version }
          : { kind: "missing" };
      return { tag: state, version: state };
    };

    const state = waitForVerifiedPackageState({
      attempts,
      onPending: () => undefined,
      pkg,
      read,
      wait: () => {
        clockMs += delayMs;
      },
    });

    expect(state.version).toEqual({ kind: "available", version: "1.3.2" });
  });
});
