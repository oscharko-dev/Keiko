import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { PORTABLE_BUILD_OWNERS, releaseCandidatePlan } from "../lib/release-candidate.mjs";
import { releasePublishHandoffPlan } from "../lib/release-publish-handoff.mjs";

const SHA = "a".repeat(40);
const TAG = "v1.0.5";
const workflows = resolve(import.meta.dirname, "../../.github/workflows");
const candidate = parse(readFileSync(resolve(workflows, "release-candidate.yml"), "utf8"));
const portable = parse(readFileSync(resolve(workflows, "portable-assets.yml"), "utf8"));
const release = parse(readFileSync(resolve(workflows, "release.yml"), "utf8"));

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

describe("release orchestration integration (#3548)", () => {
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

  it("joins tag creation, one canonical bundle, read-only handoff, and human publish", () => {
    const handoff = releasePublishHandoffPlan({
      releaseRuns: [],
      remoteTagSha: SHA,
      sourceSha: SHA,
      tag: TAG,
    });
    const upload = portable.jobs.assemble.steps.filter((step) =>
      step.with?.name?.includes("portable-release-assets"),
    );

    expect(candidate.jobs.plan.steps.at(-1).run).toBe("node scripts/release-candidate.mjs --plan");
    expect(portable.jobs["rehearsal-readiness"].steps.at(-1).run).toBe(
      "node scripts/release-candidate.mjs --plan",
    );
    expect(upload).toHaveLength(1);
    expect(portable.jobs["publish-handoff"].needs).toBe("assemble");
    expect(portable.jobs["publish-handoff"].permissions).toStrictEqual({
      actions: "read",
      checks: "read",
      contents: "read",
      statuses: "read",
    });
    expect(handoff.action).toBe("authorize");
    expect(release.on).toStrictEqual({ workflow_dispatch: expect.any(Object) });
    expect(release.jobs.publish.if).toContain("!endsWith(github.triggering_actor, '[bot]')");
    expect(release.jobs.publish.if).toContain(
      "contains(fromJSON(vars.KEIKO_RELEASE_OWNER_GITHUB_LOGINS), github.triggering_actor)",
    );
  });
});
