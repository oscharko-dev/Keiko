import { describe, expect, it } from "vitest";

import {
  releasePublishRequestMain,
  releasePublishRequestPlan,
  runReleasePublishRequest,
} from "../lib/release-publish-request.mjs";

// ADR-0177 D8. The v1.0.0 publish was dispatched by hand from a scratch script with a copied run id
// and attempt. A stable tag build now asks for its own publish; the approval stays human.

const REPO = "oscharko-dev/Keiko";
const TAG = "v1.0.1";
const BUILD = "a".repeat(40);
const OLDER = "b".repeat(40);
const RUNS_PATH = `repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`;

function run(overrides) {
  return {
    event: "workflow_dispatch",
    head_branch: TAG,
    head_sha: BUILD,
    id: 7,
    status: "waiting",
    ...overrides,
  };
}

function plan(overrides) {
  return releasePublishRequestPlan({
    releaseRuns: [],
    remoteTagSha: BUILD,
    sourceSha: BUILD,
    tag: TAG,
    ...overrides,
  });
}

describe("releasePublishRequestPlan", () => {
  it("dispatches the publish of the build the tag points at", () => {
    expect(plan({})).toStrictEqual({
      action: "dispatch",
      cancel: [],
      reason: `${TAG} at ${BUILD} is ready for the npm-publish approval`,
    });
  });

  it("leaves the publish to the newer build once the tag has moved", () => {
    const result = plan({ releaseRuns: [run({ head_sha: OLDER })], remoteTagSha: OLDER });
    expect(result).toMatchObject({ action: "skip", cancel: [] });
    expect(result.reason).toContain(`now points at ${OLDER}`);
  });

  it("names a deleted tag", () => {
    expect(plan({ remoteTagSha: undefined }).reason).toContain("now points at nothing");
  });

  it("cancels an older candidate's publish that still waits for approval, and only that", () => {
    const releaseRuns = [
      run({ head_sha: OLDER, id: 11 }),
      run({ head_sha: OLDER, id: 12, status: "in_progress" }),
      run({ head_branch: "v1.0.0", head_sha: OLDER, id: 13 }),
      run({ event: "push", head_sha: OLDER, id: 14 }),
      run({ head_sha: OLDER, id: 15, status: "completed" }),
    ];
    expect(plan({ releaseRuns })).toMatchObject({ action: "dispatch", cancel: [11] });
  });

  it.each(["waiting", "queued", "in_progress", "requested", "pending"])(
    "does not dispatch twice while a publish of this build is %s",
    (status) => {
      expect(plan({ releaseRuns: [run({ status })] }).action).toBe("skip");
    },
  );

  it("dispatches again when the earlier publish of this build has completed", () => {
    expect(plan({ releaseRuns: [run({ status: "completed" })] }).action).toBe("dispatch");
  });

  it.each([
    ["a prerelease tag", { tag: "v1.0.1-beta.1" }, "not a stable release tag"],
    ["a malformed build commit", { sourceSha: "HEAD" }, "not a full SHA"],
    [
      "a malformed superseded run id",
      { releaseRuns: [run({ head_sha: OLDER, id: "7" })] },
      "superseded run id",
    ],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => plan(overrides)).toThrow(message);
  });
});

describe("runReleasePublishRequest", () => {
  const ENV = {
    GITHUB_REPOSITORY: REPO,
    RELEASE_TAG: TAG,
    RUN_ATTEMPT: "2",
    RUN_ID: "34844310850",
    SOURCE_SHA: BUILD,
  };

  function fakeGh({ runs = [], tagSha = BUILD, cancelStatus = 0, dispatchStatus = 0 } = {}) {
    const calls = [];
    const runGh = (args) => {
      calls.push(args);
      if (args[0] === "workflow") return { status: dispatchStatus, stdout: "", stderr: "" };
      if (args[1] === "--method") return { status: cancelStatus, stdout: "", stderr: "" };
      if (args.at(-1) === RUNS_PATH)
        return { status: 0, stdout: JSON.stringify({ workflow_runs: runs }), stderr: "" };
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

  it("cancels the superseded waiting publish and dispatches this build with its run identity", () => {
    const gh = fakeGh({ runs: [run({ head_sha: OLDER, id: 21 })] });
    const line = runReleasePublishRequest({ env: ENV, runGh: gh.runGh });

    expect(
      gh.calls.filter((args) => args[1] === "--method" || args[0] === "workflow"),
    ).toStrictEqual([
      ["api", "--method", "POST", `repos/${REPO}/actions/runs/21/cancel`],
      [
        "workflow",
        "run",
        "release.yml",
        "--repo",
        REPO,
        "--ref",
        TAG,
        "-f",
        "publish=true",
        "-f",
        "npm_dist_tag=latest",
        "-f",
        "portable_assets_run_id=34844310850",
        "-f",
        "portable_assets_run_attempt=2",
        "-f",
        "portable_assets_artifact_name=portable-release-assets",
      ],
    ]);
    expect(line).toBe(
      `Publish request for ${TAG}: dispatch, ${TAG} at ${BUILD} is ready for the npm-publish approval; cancelled 1 superseded run(s).`,
    );
  });

  it("cancels a superseded waiting publish that is listed on the second page", () => {
    // One page of 100 completed runs hid the waiting one on page two, and the dispatch then put a
    // second approval for the tag in the queue (review finding on #3488).
    const completed = Array.from({ length: 100 }, (_, index) =>
      run({ head_sha: OLDER, id: 1000 + index, status: "completed" }),
    );
    const gh = fakeGh({ runs: completed });
    const page2 = RUNS_PATH.replace("&page=1", "&page=2");
    const runGh = (args) =>
      args.at(-1) === page2
        ? {
            status: 0,
            stdout: JSON.stringify({ workflow_runs: [run({ head_sha: OLDER, id: 21 })] }),
            stderr: "",
          }
        : gh.runGh(args);

    runReleasePublishRequest({ env: ENV, runGh });

    expect(gh.calls).toContainEqual([
      "api",
      "--method",
      "POST",
      `repos/${REPO}/actions/runs/21/cancel`,
    ]);
  });

  it("refuses to decide on a run listing that never ends", () => {
    const full = Array.from({ length: 100 }, (_, index) =>
      run({ head_sha: OLDER, id: 1000 + index, status: "completed" }),
    );
    const runGh = (args) =>
      String(args.at(-1)).startsWith(RUNS_PATH.replace("&page=1", "&page="))
        ? { status: 0, stdout: JSON.stringify({ workflow_runs: full }), stderr: "" }
        : fakeGh().runGh(args);

    expect(() => runReleasePublishRequest({ env: ENV, runGh })).toThrow(
      "the release workflow runs span more than 20 pages",
    );
  });

  it("refuses to dispatch while a superseded publish could not be cancelled", () => {
    const gh = fakeGh({ cancelStatus: 1, runs: [run({ head_sha: OLDER, id: 21 })] });
    expect(() => runReleasePublishRequest({ env: ENV, runGh: gh.runGh })).toThrow(
      "superseded publish run(s) 21 could not be cancelled",
    );
    expect(gh.calls.some((args) => args[0] === "workflow")).toBe(false);
  });

  it("dispatches nothing once the tag has moved", () => {
    const gh = fakeGh({ tagSha: OLDER });
    expect(runReleasePublishRequest({ env: ENV, runGh: gh.runGh })).toContain(": skip,");
    expect(gh.calls.some((args) => args[0] === "workflow")).toBe(false);
  });

  it("fails when GitHub refuses the dispatch", () => {
    const gh = fakeGh({ dispatchStatus: 1 });
    expect(() => runReleasePublishRequest({ env: ENV, runGh: gh.runGh })).toThrow(
      "could not be dispatched",
    );
  });

  it.each([
    [
      "a malformed repository",
      { GITHUB_REPOSITORY: "Keiko" },
      "GITHUB_REPOSITORY is not owner/repo",
    ],
    ["a malformed run id", { RUN_ID: "12a" }, "RUN_ID is not a positive integer"],
    ["a zero run attempt", { RUN_ATTEMPT: "0" }, "RUN_ATTEMPT is not a positive integer"],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() =>
      runReleasePublishRequest({ env: { ...ENV, ...overrides }, runGh: fakeGh().runGh }),
    ).toThrow(message);
  });

  it("fails closed on a malformed run listing", () => {
    const runGh = (args) =>
      args.at(-1) === RUNS_PATH ? { status: 0, stdout: "{}", stderr: "" } : fakeGh().runGh(args);
    expect(() => runReleasePublishRequest({ env: ENV, runGh })).toThrow(
      "release workflow runs are malformed",
    );
  });
});

describe("releasePublishRequestMain", () => {
  const ENV = {
    GITHUB_REPOSITORY: REPO,
    RELEASE_TAG: TAG,
    RUN_ATTEMPT: "1",
    RUN_ID: "77",
    SOURCE_SHA: BUILD,
  };
  const runGh = (args) => {
    if (args.at(-1) === RUNS_PATH)
      return { status: 0, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    if (args.at(-1) === `repos/${REPO}/git/ref/tags/${TAG}`) {
      return {
        status: 0,
        stdout: JSON.stringify({ object: { sha: BUILD, type: "commit" } }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  function main(env, gh = runGh) {
    const written = [];
    const appended = [];
    const code = releasePublishRequestMain({
      appendFile: (path, text) => appended.push([path, text]),
      env,
      runGh: gh,
      write: (stream, text) => written.push([stream, text]),
    });
    return { appended, code, written };
  }

  it("prints the report and records it in the step summary", () => {
    const { appended, code, written } = main({ ...ENV, GITHUB_STEP_SUMMARY: "/summary" });
    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0][0]).toBe("stdout");
    expect(appended).toStrictEqual([["/summary", written[0][1]]]);
  });

  it("prints a known refusal as it is and exits 1", () => {
    const { code, written } = main({ ...ENV, RUN_ID: "x" });
    expect(code).toBe(1);
    expect(written).toStrictEqual([
      ["stderr", "request-release-publish: RUN_ID is not a positive integer.\n"],
    ]);
  });

  it("prefixes an unexpected failure", () => {
    const { code, written } = main(ENV, () => {
      throw new TypeError("spawn failed");
    });
    expect(code).toBe(1);
    expect(written).toStrictEqual([["stderr", "request-release-publish: spawn failed\n"]]);
  });

  it("reports a thrown value that is not an Error", () => {
    const { written } = main(ENV, () => {
      throw "gh vanished";
    });
    expect(written).toStrictEqual([["stderr", "request-release-publish: gh vanished\n"]]);
  });
});
