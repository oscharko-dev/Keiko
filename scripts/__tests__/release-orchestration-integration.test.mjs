import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  AUTOMATION_ACTOR,
  newestOwnerRequest,
  releaseAdvancePlan,
  releaseAuthorizePlan,
} from "../lib/release-automation.mjs";
import {
  PORTABLE_BUILD_OWNERS,
  releaseCandidatePlan,
  releaseOwners,
} from "../lib/release-candidate.mjs";

const SHA = "a".repeat(40);
const TAG = "v1.0.5";
const workflows = resolve(import.meta.dirname, "../../.github/workflows");
const candidate = parse(readFileSync(resolve(workflows, "release-candidate.yml"), "utf8"));
const portable = parse(readFileSync(resolve(workflows, "portable-assets.yml"), "utf8"));
const release = parse(readFileSync(resolve(workflows, "release.yml"), "utf8"));
const advance = parse(readFileSync(resolve(workflows, "release-advance.yml"), "utf8"));
const OWNERS = releaseOwners('["oscharko"]');

function candidatePlan(overrides = {}) {
  return releaseCandidatePlan({
    candidateSha: SHA,
    devHeadSha: SHA,
    publishRunActive: false,
    published: false,
    readiness: { ready: true, reason: `${TAG} is approved`, releaseTag: TAG },
    remoteTagSha: undefined,
    ...overrides,
  });
}

function buildOwners(plan) {
  return [
    plan.portableBuild === PORTABLE_BUILD_OWNERS.DEV_REHEARSAL,
    plan.portableBuild === PORTABLE_BUILD_OWNERS.STABLE_TAG,
  ].filter(Boolean);
}

describe("release orchestration integration (#3548, ADR-0177 D9)", () => {
  it("assigns an approved unpublished SHA to exactly one stable-tag build", () => {
    const plan = candidatePlan();

    expect(plan).toMatchObject({ action: "create", portableBuild: "stable-tag", tag: TAG });
    expect(buildOwners(plan)).toHaveLength(1);
    expect(portable.jobs["rehearsal-readiness"].outputs.ready).toContain(
      "portable-build == 'dev-rehearsal'",
    );
    expect(portable.jobs.stage.if).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(portable.jobs.stage.if).toContain("outputs.ready == 'true'");
  });

  it("assigns an ordinary post-release dev SHA to exactly one rehearsal build", () => {
    const plan = candidatePlan({ published: true, remoteTagSha: SHA });

    expect(plan).toMatchObject({ action: "skip", portableBuild: "dev-rehearsal", tag: TAG });
    expect(buildOwners(plan)).toHaveLength(1);
  });

  it("keeps the tag on the commit an owner requested while dev moves on", () => {
    const newer = "c".repeat(40);
    const plan = candidatePlan({
      candidateSha: newer,
      devHeadSha: newer,
      ownerRequestHeld: true,
      remoteTagSha: SHA,
    });

    expect(plan).toMatchObject({ action: "skip", portableBuild: "none", tag: TAG });
    expect(buildOwners(plan)).toHaveLength(0);
  });

  it("joins the button, one canonical bundle, the event-driven start, and the authorized publish", () => {
    // One press on dev is the whole human part; every later step is a decision over GitHub state.
    const pressed = {
      conclusion: "success",
      event: "workflow_dispatch",
      head_branch: "dev",
      head_sha: SHA,
      run_number: 20,
      status: "completed",
      triggering_actor: { login: "oscharko" },
    };
    const build = {
      conclusion: "success",
      event: "push",
      head_branch: TAG,
      head_sha: SHA,
      id: 42,
      path: ".github/workflows/portable-assets.yml",
      run_attempt: 1,
      status: "completed",
    };
    const request = newestOwnerRequest([pressed], OWNERS);
    const start = releaseAdvancePlan({
      build,
      checks: { failed: [], missing: [], ok: true, passed: [], pending: [] },
      publishAttempt: undefined,
      published: false,
      remoteTagSha: SHA,
      request,
      tag: TAG,
    });
    const authorized = releaseAuthorizePlan({
      actor: AUTOMATION_ACTOR,
      build,
      owners: OWNERS,
      releaseRuns: [pressed],
      remoteTagSha: SHA,
      sha: SHA,
      tag: TAG,
    });
    const upload = portable.jobs.assemble.steps.filter((step) =>
      step.with?.name?.includes("portable-release-assets"),
    );

    expect(candidate.jobs.plan.steps.at(-1).run).toBe("node scripts/release-candidate.mjs --plan");
    expect(portable.jobs["rehearsal-readiness"].steps.at(-1).run).toBe(
      "node scripts/release-candidate.mjs --plan",
    );
    expect(release.jobs.request.steps.at(-1).run).toBe(
      "node scripts/release-candidate.mjs --request",
    );
    expect(upload).toHaveLength(1);
    expect(portable.jobs["publish-handoff"]).toBeUndefined();
    expect(advance.on.workflow_run.workflows).toEqual(
      expect.arrayContaining(["Release", "Portable assets"]),
    );
    expect(advance.jobs.advance.steps.at(-1).run).toBe("node scripts/release-advance.mjs");
    expect(start.action).toBe("dispatch");
    expect(authorized).toMatchObject({ runAttempt: 1, runId: 42 });
    expect(release.on).toStrictEqual({ workflow_dispatch: null });
    expect(release.jobs.publish.needs).toStrictEqual(["authorize", "qualify-customer-shape"]);
  });
});
