import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// ADR-0177 D8 pins. The release candidate is the one place a workflow may write a release tag, and
// the stable build's publish request is the one place a workflow may dispatch release.yml, so their
// triggers, grants, secrets and step order are fixed here.

const workflows = resolve(import.meta.dirname, "../../.github/workflows");
const candidateSource = readFileSync(resolve(workflows, "release-candidate.yml"), "utf8");
const candidate = parse(candidateSource);
const portable = parse(readFileSync(resolve(workflows, "portable-assets.yml"), "utf8"));
const release = parse(readFileSync(resolve(workflows, "release.yml"), "utf8"));

function stepIndex(job, predicate, label) {
  const index = job.steps.findIndex(predicate);
  expect(index, label).toBeGreaterThanOrEqual(0);
  return index;
}

describe("release candidate workflow", () => {
  it("runs on every dev push, or on a manual dispatch", () => {
    expect(candidate.on).toStrictEqual({ push: { branches: ["dev"] }, workflow_dispatch: null });
    expect(candidate.permissions).toStrictEqual({});
    expect(candidate.concurrency).toStrictEqual({
      "cancel-in-progress": true,
      group: "release-candidate",
    });
  });

  it("plans only on dev, with read grants and no secrets", () => {
    const { plan } = candidate.jobs;
    expect(plan.if).toBe("${{ github.ref == 'refs/heads/dev' }}");
    expect(plan.permissions).toStrictEqual({ actions: "read", contents: "read" });
    expect(plan.environment).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain("secrets.");
    expect(plan.steps.at(-1)).toMatchObject({
      id: "plan",
      run: "node scripts/release-candidate.mjs --plan",
    });
  });

  it("writes the tag at once, with a contents-only App token from its environment", () => {
    // The tag build now runs beside the commit's CI; the release-required checks gate the publish
    // request at the end of that build instead (see the stable build publish request below).
    const { tag } = candidate.jobs;
    expect(tag.needs).toBe("plan");
    // Explicit !cancelled() guard added in Epic #3495 (#3502): the tag job needs the plan job,
    // and plan is legitimately skipped on any non-dev ref. Without an explicit status function
    // GitHub's implicit success() gate silently skips the tag job too. The `!cancelled() &&`
    // prefix makes the intent visible and satisfies the implicit-success-trap regression pin.
    expect(tag.if).toBe(
      "${{ !cancelled() && (needs.plan.outputs.action == 'create' || needs.plan.outputs.action == 'move') }}",
    );
    expect(tag.environment).toBe("release-tagging");
    expect(tag.permissions).toStrictEqual({ actions: "read", contents: "read" });

    const token = stepIndex(
      tag,
      (step) => String(step.uses).startsWith("actions/create-github-app-token@"),
      "token",
    );
    const apply = stepIndex(
      tag,
      (step) => step.run === "node scripts/release-candidate.mjs --apply",
      "apply",
    );
    expect(token).toBeLessThan(apply);
    expect(tag.steps[token].uses).toBe(
      "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
    );
    expect(tag.steps[token].with).toStrictEqual({
      "client-id": "${{ vars.KEIKO_RELEASE_TAG_APP_CLIENT_ID }}",
      "permission-contents": "write",
      "private-key": "${{ secrets.KEIKO_RELEASE_TAG_APP_PRIVATE_KEY }}",
    });
    expect(tag.steps[apply].env.KEIKO_RELEASE_TAG_TOKEN).toBe(
      "${{ steps.tag-token.outputs.token }}",
    );
  });

  it("references exactly one secret, the App key, in exactly one place", () => {
    expect(candidateSource.match(/secrets\.[A-Z_]+/gu)).toStrictEqual([
      "secrets.KEIKO_RELEASE_TAG_APP_PRIVATE_KEY",
    ]);
  });
});

describe("release workflow commit binding", () => {
  it.each(["publish"])(
    "checks out exactly the commit %s was started for and proves it",
    (jobName) => {
      // An explicit ref followed a tag moved after dispatch, so an approval given for one commit
      // could publish another (review finding on #3488).
      const job = release.jobs[jobName];
      const checkout = stepIndex(
        job,
        (step) => String(step.uses).startsWith("actions/checkout@"),
        "checkout",
      );
      expect(job.steps[checkout].with.ref).toBeUndefined();
      expect(job.steps[checkout + 1]).toMatchObject({
        name: "Verify checked-out commit",
        run: 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
      });
    },
  );

  it("re-verifies the required checks in the publish job without waiting for CI", () => {
    const { publish } = release.jobs;
    const verify = publish.steps.find(
      (step) => step.name === "Verify required checks for release SHA",
    );
    const budget = Number(verify.env.RELEASE_CHECK_TIMEOUT_SECONDS);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(publish["timeout-minutes"] * 60);
  });
});

describe("stable build publish request", () => {
  it("asks for a publish only after a stable tag build assembled, with no secrets", () => {
    const job = portable.jobs["request-publish"];
    expect(job.needs).toBe("assemble");
    expect(job.if).toBe(
      "${{ !cancelled() && needs.assemble.result == 'success' && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name, '-') }}",
    );
    expect(job.permissions).toStrictEqual({
      actions: "write",
      checks: "read",
      contents: "read",
      statuses: "read",
    });
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job.steps.some((step) => /npm (ci|install)/u.test(String(step.run)))).toBe(false);
    const verify = stepIndex(
      job,
      (step) =>
        step.run === 'RELEASE_SHA="$GITHUB_SHA" node scripts/verify-release-required-checks.mjs',
      "required checks",
    );
    expect(verify).toBe(job.steps.length - 2);
    expect(job.steps.at(-1)).toMatchObject({
      env: {
        GITHUB_TOKEN: "${{ github.token }}",
        RELEASE_TAG: "${{ github.ref_name }}",
        RUN_ATTEMPT: "${{ github.run_attempt }}",
        RUN_ID: "${{ github.run_id }}",
        SOURCE_SHA: "${{ github.sha }}",
      },
      run: "node scripts/request-release-publish.mjs",
    });
  });
});
