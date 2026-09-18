import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  AUTOMATION_ACTOR,
  gatherAdvanceFacts,
  newestOwnerRequest,
  newestStableBuild,
  readBuildRuns,
  readCommitChecks,
  readRootPackageAt,
  releaseAdvancePlan,
  releaseAuthorizePlan,
  releaseAutomationMain,
  runReleaseAdvance,
  runReleaseAuthorize,
} from "../lib/release-automation.mjs";
import { isOwnerReleaseRequest, releaseOwners } from "../lib/release-candidate.mjs";

// ADR-0177 D9. Until 1.0.5 the stable build ended in a handoff that printed a long
// `gh workflow run release.yml ... -f portable_assets_run_id=...` command, and the owner had to wait
// for the build, copy the run identity and dispatch the publish by hand. The release button now
// authorizes the dev commit up front, and these decisions carry it to npm without a second human step.

const REPO = "oscharko-dev/Keiko";
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const TAG = "v1.0.5";
const OWNERS = releaseOwners('["oscharko"]');
const REQUIRED = JSON.stringify(["ci", "ui"]);
const RUNS_PATH = `repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`;
const BUILDS_PATH = `repos/${REPO}/actions/workflows/portable-assets.yml/runs?event=push&head_sha=${SHA}&per_page=100`;
const CHECKS_PATH = `repos/${REPO}/commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`;

function ok(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: "" };
}

const NOT_FOUND = { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
const NPM_MISSING = () => ({ status: 1, stdout: "", stderr: "npm error code E404" });

function request(overrides = {}) {
  return {
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: "dev",
    head_sha: SHA,
    run_number: 10,
    status: "completed",
    triggering_actor: { login: "oscharko", type: "User" },
    ...overrides,
  };
}

function build(overrides = {}) {
  return {
    conclusion: "success",
    event: "push",
    head_branch: TAG,
    head_sha: SHA,
    id: 35326313586,
    path: ".github/workflows/portable-assets.yml",
    run_attempt: 1,
    run_number: 7,
    status: "completed",
    ...overrides,
  };
}

function checkRun(name, conclusion = "success", status = "completed") {
  return { completed_at: "2026-09-18T09:00:00Z", conclusion, id: 1, name, status };
}

function packageFile(version = "1.0.5") {
  const text = JSON.stringify({ name: "@oscharko-dev/keiko", version });
  return ok({ content: Buffer.from(text).toString("base64"), encoding: "base64" });
}

function fakeGithub(overrides = {}) {
  const routes = {
    [RUNS_PATH]: ok({ workflow_runs: [request()] }),
    [`repos/${REPO}/contents/package.json?ref=${SHA}`]: packageFile(),
    [`repos/${REPO}/releases/tags/${TAG}`]: NOT_FOUND,
    [`repos/${REPO}/git/ref/tags/${TAG}`]: ok({ object: { sha: SHA, type: "commit" } }),
    [BUILDS_PATH]: ok({ workflow_runs: [build()] }),
    [CHECKS_PATH]: ok({ check_runs: [checkRun("ci"), checkRun("ui")] }),
    [`repos/${REPO}/commits/${SHA}/status`]: ok({ statuses: [] }),
    [`repos/${REPO}/actions/workflows/release.yml/dispatches`]: {
      status: 0,
      stdout: "",
      stderr: "",
    },
    ...overrides,
  };
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    const path = args.includes("--method") ? args[3] : args.at(-1);
    const route = routes[path];
    if (route === undefined) throw new Error(`unexpected gh call: ${args.join(" ")}`);
    return route;
  };
  return { calls, runGh };
}

function readyFacts(overrides = {}) {
  return {
    build: build(),
    checks: { failed: [], missing: [], ok: true, passed: ["ci", "ui"], pending: [] },
    publishAttempt: undefined,
    published: false,
    remoteTagSha: SHA,
    request: request(),
    tag: TAG,
    ...overrides,
  };
}

describe("releaseOwners", () => {
  it("lower-cases the allowlisted logins", () => {
    expect(releaseOwners('["OSCharko", "second"]')).toStrictEqual(new Set(["oscharko", "second"]));
  });

  it.each([
    ["an unset variable", undefined],
    ["an empty value", ""],
    ["an empty list", "[]"],
    ["a non-array", '"oscharko"'],
    ["malformed JSON", "[oscharko"],
    ["an empty login", '[""]'],
    ["a bot login", '["github-actions[bot]"]'],
    ["a non-string login", "[42]"],
  ])("refuses %s", (_label, value) => {
    expect(() => releaseOwners(value)).toThrow("is not a JSON array of human logins");
  });
});

describe("owner requests and stable builds", () => {
  it("accepts an owner's dev dispatch in any letter case", () => {
    expect(
      isOwnerReleaseRequest(request({ triggering_actor: { login: "OSCHARKO" } }), OWNERS),
    ).toBe(true);
  });

  it.each([
    ["an account outside the allowlist", request({ triggering_actor: { login: "contributor" } })],
    ["the automation", request({ triggering_actor: { login: AUTOMATION_ACTOR } })],
    ["a substring of an owner", request({ triggering_actor: { login: "osch" } })],
    ["a dispatch on the tag", request({ head_branch: TAG })],
  ])("refuses %s as a request", (_label, run) => {
    expect(isOwnerReleaseRequest(run, OWNERS)).toBe(false);
  });

  it("takes the newest successful owner request", () => {
    const runs = [
      request({ head_sha: OTHER, run_number: 3 }),
      request({ run_number: 12, conclusion: "failure" }),
      request({ run_number: 9 }),
      request({ run_number: 14, triggering_actor: { login: "contributor" } }),
    ];
    expect(newestOwnerRequest(runs, OWNERS)).toMatchObject({ run_number: 9 });
    expect(newestOwnerRequest([], OWNERS)).toBeUndefined();
  });

  it("takes the newest push build of exactly this tag and commit", () => {
    const runs = [
      build({ run_number: 1 }),
      build({ run_number: 5, head_branch: "dev" }),
      build({ run_number: 6, event: "workflow_dispatch" }),
      build({ run_number: 8, head_sha: OTHER }),
      build({ run_number: 9, path: ".github/workflows/ci.yml" }),
      build({ run_number: 4, path: ".github/workflows/portable-assets.yml@refs/tags/v1.0.5" }),
    ];
    expect(newestStableBuild(runs, TAG, SHA)).toMatchObject({ run_number: 4 });
    expect(newestStableBuild([], TAG, SHA)).toBeUndefined();
  });
});

describe("releaseAdvancePlan", () => {
  it("dispatches the publish when the requested commit is built and green", () => {
    expect(releaseAdvancePlan(readyFacts())).toStrictEqual({
      action: "dispatch",
      reason: `${TAG} at ${SHA} is built and green`,
    });
  });

  it.each([
    ["no request", { request: undefined }, "idle", "no release has been requested"],
    ["a published version", { published: true }, "idle", `${TAG} is published`],
    [
      "a tag that moved away",
      { remoteTagSha: OTHER },
      "idle",
      `${TAG} points at ${OTHER}, not the requested ${SHA}`,
    ],
    [
      "a missing tag",
      { remoteTagSha: undefined },
      "idle",
      `${TAG} points at nothing, not the requested ${SHA}`,
    ],
    [
      "a publish that is running",
      { publishAttempt: { status: "in_progress" } },
      "idle",
      `the publish of ${TAG} is running`,
    ],
    [
      "a publish that already failed once",
      { publishAttempt: { conclusion: "failure", status: "completed" } },
      "idle",
      `the publish of ${TAG} ended failure; a new press of the release button retries it`,
    ],
    ["a build not started", { build: undefined }, "wait", `the ${TAG} build has not started`],
    [
      "a running build",
      { build: build({ status: "in_progress", conclusion: null }) },
      "wait",
      `the ${TAG} build is running`,
    ],
    [
      "a failed build",
      { build: build({ conclusion: "failure" }) },
      "blocked",
      `the ${TAG} build ended failure; re-run it to continue`,
    ],
    [
      "a failed required check",
      {
        checks: {
          failed: [{ name: "ci", state: "failure" }],
          missing: [],
          ok: false,
          passed: [],
          pending: [],
        },
      },
      "blocked",
      "release-required checks failed: ci (failure)",
    ],
    [
      "pending and missing required checks",
      {
        checks: {
          failed: [],
          missing: ["ui"],
          ok: false,
          passed: [],
          pending: [{ name: "ci", state: "in_progress" }],
        },
      },
      "wait",
      "waiting for ci, ui",
    ],
  ])("does not dispatch for %s", (_label, overrides, action, reason) => {
    expect(releaseAdvancePlan(readyFacts(overrides))).toStrictEqual({ action, reason });
  });
});

describe("releaseAuthorizePlan", () => {
  function authorize(overrides = {}) {
    return releaseAuthorizePlan({
      actor: AUTOMATION_ACTOR,
      build: build(),
      owners: OWNERS,
      releaseRuns: [request()],
      remoteTagSha: SHA,
      sha: SHA,
      tag: TAG,
      ...overrides,
    });
  }

  it("lets the automation publish a commit an owner requested, naming the exact build", () => {
    expect(authorize()).toStrictEqual({
      reason: `a release owner requested this commit with the release button; ${TAG} at ${SHA} publishes the build of run 35326313586`,
      runAttempt: 1,
      runId: 35326313586,
    });
  });

  it("lets an allowlisted owner dispatch the tag directly", () => {
    expect(authorize({ actor: "oscharko", releaseRuns: [] }).reason).toMatch(
      /^release owner oscharko dispatched the publish; /u,
    );
  });

  it.each([
    ["no request at all", { releaseRuns: [] }, `no release owner requested the release of ${SHA}`],
    [
      "a request for another commit",
      { releaseRuns: [request({ head_sha: OTHER })] },
      `no release owner requested the release of ${SHA}`,
    ],
    [
      "a failed request",
      { releaseRuns: [request({ conclusion: "failure" })] },
      `no release owner requested the release of ${SHA}`,
    ],
    [
      "a request by an account outside the allowlist",
      { releaseRuns: [request({ triggering_actor: { login: "contributor" } })] },
      `no release owner requested the release of ${SHA}`,
    ],
    ["another bot", { actor: "dependabot[bot]" }, "dependabot[bot] may not publish a release"],
    ["a human outside the allowlist", { actor: "contributor" }, "contributor may not publish"],
    [
      "a tag that moved",
      { remoteTagSha: OTHER },
      `${TAG} points at ${OTHER}, not the release commit ${SHA}`,
    ],
    ["a missing build", { build: undefined }, `${TAG} has no successful stable build at ${SHA}`],
    [
      "a failed build",
      { build: build({ conclusion: "failure" }) },
      `${TAG} has no successful stable build at ${SHA}`,
    ],
    [
      "a running build",
      { build: build({ status: "in_progress" }) },
      `${TAG} has no successful stable build at ${SHA}`,
    ],
    ["a prerelease tag", { tag: "v1.0.5-rc.1" }, "is not a stable release tag"],
    ["a short commit", { sha: "abc" }, "the release commit is not a full commit SHA"],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => authorize(overrides)).toThrow(message);
  });
});

describe("GitHub reads", () => {
  it("decodes the root package at the requested commit", () => {
    expect(readRootPackageAt(fakeGithub().runGh, REPO, SHA)).toStrictEqual({
      name: "@oscharko-dev/keiko",
      version: "1.0.5",
    });
  });

  it.each([
    ["a non-base64 answer", ok({ content: "{}", encoding: "utf-8" }), "is not a base64 file"],
    [
      "a body that is not JSON",
      ok({ content: Buffer.from("{").toString("base64"), encoding: "base64" }),
      "is not JSON",
    ],
    ["a missing file", NOT_FOUND, "could not be read"],
  ])("refuses %s for package.json", (_label, response, message) => {
    const { runGh } = fakeGithub({ [`repos/${REPO}/contents/package.json?ref=${SHA}`]: response });
    expect(() => readRootPackageAt(runGh, REPO, SHA)).toThrow(message);
  });

  it.each([
    ["a malformed listing", ok({}), "the portable-assets runs are malformed"],
    [
      "a full page",
      ok({ workflow_runs: Array.from({ length: 100 }, () => build()) }),
      "has too many portable-assets runs",
    ],
  ])("refuses %s of builds", (_label, response, message) => {
    const { runGh } = fakeGithub({ [BUILDS_PATH]: response });
    expect(() => readBuildRuns(runGh, REPO, SHA)).toThrow(message);
  });

  it("reads every page of check runs before it reads the statuses", () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => checkRun(`job ${String(index)}`));
    const { calls, runGh } = fakeGithub({
      [CHECKS_PATH]: ok({ check_runs: firstPage }),
      [`repos/${REPO}/commits/${SHA}/check-runs?filter=latest&per_page=100&page=2`]: ok({
        check_runs: [checkRun("ci")],
      }),
      [`repos/${REPO}/commits/${SHA}/status`]: ok({
        statuses: [{ context: "ui", state: "success" }],
      }),
    });
    const evidence = readCommitChecks(runGh, REPO, SHA);
    expect(evidence.checkRuns).toHaveLength(101);
    expect(evidence.statuses).toStrictEqual([{ context: "ui", state: "success" }]);
    expect(calls.map((args) => args.at(-1))).toStrictEqual([
      CHECKS_PATH,
      `repos/${REPO}/commits/${SHA}/check-runs?filter=latest&per_page=100&page=2`,
      `repos/${REPO}/commits/${SHA}/status`,
    ]);
  });

  it("refuses malformed check runs and an unbounded listing", () => {
    expect(() => readCommitChecks(fakeGithub({ [CHECKS_PATH]: ok({}) }).runGh, REPO, SHA)).toThrow(
      "are malformed",
    );
    const full = ok({ check_runs: Array.from({ length: 100 }, () => checkRun("x")) });
    const endless = (args) => (args.at(-1).includes("/check-runs") ? full : NOT_FOUND);
    expect(() => readCommitChecks(endless, REPO, SHA)).toThrow("span more than 10 pages");
  });
});

describe("gatherAdvanceFacts", () => {
  function gather(github, runNpm = NPM_MISSING) {
    return gatherAdvanceFacts({
      owners: OWNERS,
      repository: REPO,
      requiredChecks: ["ci", "ui"],
      runGh: github.runGh,
      runNpm,
    });
  }

  it("reads only the release runs while nothing is requested", () => {
    const github = fakeGithub({ [RUNS_PATH]: ok({ workflow_runs: [] }) });
    expect(gather(github)).toStrictEqual({ request: undefined });
    expect(github.calls).toStrictEqual([["api", RUNS_PATH]]);
  });

  it("stops at a published version", () => {
    const published = () => ({ status: 0, stdout: '"1.0.5"\n', stderr: "" });
    const github = fakeGithub();
    expect(gather(github, published)).toMatchObject({ published: true, tag: TAG });
    expect(github.calls.map((args) => args.at(-1))).not.toContain(BUILDS_PATH);
  });

  it("reads the build, the checks, the tag and the publish attempts of the requested commit", () => {
    const attempt = { head_branch: TAG, run_number: 11, status: "queued" };
    const github = fakeGithub({
      [RUNS_PATH]: ok({
        workflow_runs: [
          request(),
          attempt,
          { head_branch: TAG, run_number: 4, status: "completed" },
        ],
      }),
    });
    const facts = gather(github);
    expect(facts).toMatchObject({
      build: { id: 35326313586 },
      checks: { ok: true },
      publishAttempt: attempt,
      published: false,
      remoteTagSha: SHA,
      tag: TAG,
    });
    expect(releaseAdvancePlan(facts).action).toBe("idle");
  });

  it("refuses a requested commit whose version is not a stable release", () => {
    const github = fakeGithub({
      [`repos/${REPO}/contents/package.json?ref=${SHA}`]: packageFile("1.0.6-rc.1"),
    });
    expect(() => gather(github)).toThrow("v1.0.6-rc.1 is not a stable release tag");
  });
});

describe("runReleaseAdvance", () => {
  const ENV = {
    GITHUB_REPOSITORY: REPO,
    KEIKO_RELEASE_OWNER_GITHUB_LOGINS: '["oscharko"]',
    RELEASE_REQUIRED_CHECKS: REQUIRED,
  };

  it("dispatches release.yml on the tag once everything is green", () => {
    const github = fakeGithub();
    const result = runReleaseAdvance({ env: ENV, runGh: github.runGh, runNpm: NPM_MISSING });
    expect(result.line).toBe(
      `Release ${TAG}: publish started, ${TAG} at ${SHA} is built and green.`,
    );
    expect(github.calls.at(-1)).toStrictEqual([
      "api",
      "--method",
      "POST",
      `repos/${REPO}/actions/workflows/release.yml/dispatches`,
      "-f",
      `ref=${TAG}`,
    ]);
  });

  it("dispatches nothing while a required check is still running", () => {
    const github = fakeGithub({
      [CHECKS_PATH]: ok({ check_runs: [checkRun("ci"), checkRun("ui", null, "in_progress")] }),
    });
    const result = runReleaseAdvance({ env: ENV, runGh: github.runGh, runNpm: NPM_MISSING });
    expect(result.line).toBe(`Release ${TAG}: wait, waiting for ui.`);
    expect(github.calls.some((args) => args.includes("--method"))).toBe(false);
  });

  it("reports an idle run without a tag when nothing is requested", () => {
    const github = fakeGithub({ [RUNS_PATH]: ok({ workflow_runs: [] }) });
    expect(runReleaseAdvance({ env: ENV, runGh: github.runGh, runNpm: NPM_MISSING }).line).toBe(
      "Release: idle, no release has been requested.",
    );
  });

  it("fails when GitHub refuses the dispatch", () => {
    const github = fakeGithub({
      [`repos/${REPO}/actions/workflows/release.yml/dispatches`]: {
        status: 1,
        stdout: "",
        stderr: "HTTP 403",
      },
    });
    expect(() => runReleaseAdvance({ env: ENV, runGh: github.runGh, runNpm: NPM_MISSING })).toThrow(
      `the publish of ${TAG} could not be dispatched`,
    );
  });

  it.each([
    [
      "no required checks",
      { RELEASE_REQUIRED_CHECKS: "" },
      "RELEASE_REQUIRED_CHECKS names no check",
    ],
    [
      "a malformed repository",
      { GITHUB_REPOSITORY: "Keiko" },
      "GITHUB_REPOSITORY is not owner/repo",
    ],
    [
      "a missing allowlist",
      { KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "" },
      "is not a JSON array of human logins",
    ],
  ])("refuses %s", (_label, env, message) => {
    expect(() =>
      runReleaseAdvance({
        env: { ...ENV, ...env },
        runGh: fakeGithub().runGh,
        runNpm: NPM_MISSING,
      }),
    ).toThrow(message);
  });
});

describe("runReleaseAuthorize", () => {
  const ENV = {
    GITHUB_REPOSITORY: REPO,
    GITHUB_SHA: SHA,
    KEIKO_RELEASE_OWNER_GITHUB_LOGINS: '["oscharko"]',
    RELEASE_TAG: TAG,
    TRIGGERING_ACTOR: AUTOMATION_ACTOR,
  };

  it("hands the exact build run and attempt to the publish job", () => {
    expect(runReleaseAuthorize({ env: ENV, runGh: fakeGithub().runGh })).toStrictEqual({
      line: `Publish of ${TAG} authorized: a release owner requested this commit with the release button; ${TAG} at ${SHA} publishes the build of run 35326313586.`,
      outputs: "run-id=35326313586\nrun-attempt=1\n",
    });
  });

  it.each([
    ["a prerelease tag", { RELEASE_TAG: "v1.0.5-rc.1" }, "is not a stable release tag"],
    ["a short commit", { GITHUB_SHA: "abc" }, "GITHUB_SHA is not a full commit SHA"],
  ])("refuses %s before it reads anything", (_label, env, message) => {
    const github = fakeGithub();
    expect(() => runReleaseAuthorize({ env: { ...ENV, ...env }, runGh: github.runGh })).toThrow(
      message,
    );
    expect(github.calls).toStrictEqual([]);
  });
});

describe("releaseAutomationMain", () => {
  function main(run, env = { GITHUB_OUTPUT: "/out", GITHUB_STEP_SUMMARY: "/summary" }) {
    const appended = [];
    const written = [];
    const code = releaseAutomationMain({
      appendFile: (path, text) => appended.push([path, text]),
      env,
      prefix: "release-advance",
      run,
      write: (stream, text) => written.push([stream, text]),
    });
    return { appended, code, written };
  }

  it("writes the outputs, the summary and one stdout line", () => {
    expect(main(() => ({ line: "done", outputs: "run-id=1\n" }))).toStrictEqual({
      appended: [
        ["/out", "run-id=1\n"],
        ["/summary", "done\n"],
      ],
      code: 0,
      written: [["stdout", "done\n"]],
    });
  });

  it("writes no output file for a report without outputs, or without the runner files", () => {
    expect(main(() => ({ line: "idle" })).appended).toStrictEqual([["/summary", "idle\n"]]);
    expect(main(() => ({ line: "idle", outputs: "x=1\n" }), {}).appended).toStrictEqual([]);
  });

  it("prefixes a failure, keeps a planner refusal as it is, and exits 1", () => {
    expect(
      main(() => {
        throw new Error("the publish of v1.0.5 could not be dispatched.");
      }),
    ).toMatchObject({
      code: 1,
      written: [["stderr", "release-advance: the publish of v1.0.5 could not be dispatched.\n"]],
    });
    expect(
      main(() => {
        throw new Error("release-candidate: the release workflow runs are malformed.");
      }).written,
    ).toStrictEqual([["stderr", "release-candidate: the release workflow runs are malformed.\n"]]);
    expect(
      main(() => {
        throw "gone";
      }).written,
    ).toStrictEqual([["stderr", "release-advance: gone\n"]]);
  });
});
