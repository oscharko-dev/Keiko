import { describe, expect, it } from "vitest";

import {
  releasePublishHandoffMain,
  releasePublishHandoffPlan,
  runReleasePublishHandoff,
} from "../lib/release-publish-handoff.mjs";

const REPO = "oscharko-dev/Keiko";
const TAG = "v1.0.5";
const BUILD = "a".repeat(40);
const OLDER = "b".repeat(40);
const RUNS_PATH = `repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`;
const ENV = {
  GITHUB_REPOSITORY: REPO,
  RELEASE_TAG: TAG,
  RUN_ATTEMPT: "2",
  RUN_ID: "35311806746",
  SOURCE_SHA: BUILD,
};

function run(overrides = {}) {
  return {
    actor: { login: "oscharko" },
    event: "workflow_dispatch",
    head_branch: TAG,
    head_sha: BUILD,
    id: 7,
    status: "waiting",
    triggering_actor: { login: "oscharko" },
    ...overrides,
  };
}

function plan(overrides = {}) {
  return releasePublishHandoffPlan({
    releaseRuns: [],
    remoteTagSha: BUILD,
    sourceSha: BUILD,
    tag: TAG,
    ...overrides,
  });
}

function fakeGh({ runs = [], tagSha = BUILD } = {}) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args.at(-1) === RUNS_PATH) {
      return { status: 0, stdout: JSON.stringify({ workflow_runs: runs }), stderr: "" };
    }
    if (args.at(-1) === `repos/${REPO}/git/ref/tags/${TAG}`) {
      return {
        status: 0,
        stdout: JSON.stringify({ object: { sha: tagSha, type: "commit" } }),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, runGh };
}

describe("releasePublishHandoffPlan", () => {
  it("offers explicit authorization for the exact build", () => {
    expect(plan()).toStrictEqual({
      action: "authorize",
      reason: `${TAG} at ${BUILD} is ready for explicit human authorization`,
    });
  });

  it.each([OLDER, undefined])("blocks a build after its tag moved to %s", (remoteTagSha) => {
    expect(plan({ remoteTagSha })).toMatchObject({ action: "blocked" });
  });

  it.each(["waiting", "queued", "in_progress", "requested", "pending"])(
    "recognizes an exact human publish that is %s",
    (status) => {
      expect(plan({ releaseRuns: [run({ status })] })).toMatchObject({ action: "existing" });
    },
  );

  it("blocks while a superseded publish remains open", () => {
    expect(plan({ releaseRuns: [run({ head_sha: OLDER })] })).toMatchObject({
      action: "blocked",
    });
  });

  it.each([
    ["a workflow token", { triggering_actor: { login: "github-actions[bot]" } }],
    ["missing trigger identity", { triggering_actor: undefined }],
  ])("blocks an exact open publish with %s", (_label, overrides) => {
    expect(plan({ releaseRuns: [run(overrides)] })).toMatchObject({ action: "blocked" });
  });

  it("ignores completed, other-tag, and non-dispatch runs", () => {
    expect(
      plan({
        releaseRuns: [
          run({ status: "completed" }),
          run({ head_branch: "v1.0.4" }),
          run({ event: "push" }),
        ],
      }).action,
    ).toBe("authorize");
  });

  it.each([
    ["a prerelease tag", { tag: "v1.0.5-rc.1" }, "stable release tag"],
    ["a malformed build SHA", { sourceSha: "HEAD" }, "full SHA"],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => plan(overrides)).toThrow(message);
  });
});

describe("runReleasePublishHandoff", () => {
  it("returns the exact owner command without making a write call", () => {
    const github = fakeGh();
    const report = runReleasePublishHandoff({ env: ENV, runGh: github.runGh });

    expect(report.command).toBe(
      `gh workflow run release.yml --repo ${REPO} --ref ${TAG} -f publish=true -f npm_dist_tag=latest -f portable_assets_run_id=35311806746 -f portable_assets_run_attempt=2 -f portable_assets_artifact_name=portable-release-assets`,
    );
    expect(github.calls.every((args) => args[0] === "api" && args[1] !== "--method")).toBe(true);
  });

  it("emits no duplicate command for an open exact publish", () => {
    const report = runReleasePublishHandoff({
      env: ENV,
      runGh: fakeGh({ runs: [run()] }).runGh,
    });
    expect(report.plan.action).toBe("existing");
    expect(report.command).toBeUndefined();
  });

  it("fails closed on a superseded tag or publish", () => {
    expect(() =>
      runReleasePublishHandoff({ env: ENV, runGh: fakeGh({ tagSha: OLDER }).runGh }),
    ).toThrow("now points at");
    expect(() =>
      runReleasePublishHandoff({
        env: ENV,
        runGh: fakeGh({ runs: [run({ head_sha: OLDER })] }).runGh,
      }),
    ).toThrow("superseded publish");
  });

  it.each([
    ["repository", { GITHUB_REPOSITORY: "Keiko" }, "owner/repo"],
    ["run id", { RUN_ID: "12a" }, "RUN_ID"],
    ["run attempt", { RUN_ATTEMPT: "0" }, "RUN_ATTEMPT"],
  ])("refuses a malformed %s", (_label, override, message) => {
    expect(() =>
      runReleasePublishHandoff({ env: { ...ENV, ...override }, runGh: fakeGh().runGh }),
    ).toThrow(message);
  });
});

describe("releasePublishHandoffMain", () => {
  function main(env = ENV, runGh = fakeGh().runGh) {
    const appended = [];
    const written = [];
    const code = releasePublishHandoffMain({
      appendFile: (path, value) => appended.push([path, value]),
      env,
      runGh,
      write: (stream, value) => written.push([stream, value]),
    });
    return { appended, code, written };
  }

  it("writes the exact command to the summary and a body-free stdout line", () => {
    const result = main({ ...ENV, GITHUB_STEP_SUMMARY: "/summary" });
    expect(result.code).toBe(0);
    expect(result.written).toStrictEqual([
      ["stdout", expect.stringContaining(`Publish handoff for ${TAG}: authorize`)],
    ]);
    expect(result.appended[0][1]).toContain("gh workflow run release.yml");
  });

  it("reports known and unexpected failures without a summary", () => {
    expect(main({ ...ENV, RUN_ID: "x" }).written[0][1]).toContain(
      "release-publish-handoff: RUN_ID",
    );
    expect(
      main(ENV, () => {
        throw new TypeError("spawn failed");
      }).written,
    ).toStrictEqual([["stderr", "release-publish-handoff: spawn failed\n"]]);
    expect(
      main(ENV, () => {
        throw "gh vanished";
      }).written,
    ).toStrictEqual([["stderr", "release-publish-handoff: gh vanished\n"]]);
  });
});
