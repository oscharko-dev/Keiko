import { describe, expect, it } from "vitest";

import {
  applyReleaseCandidatePlan,
  PORTABLE_BUILD_OWNERS,
  planReleaseCandidate,
  releaseCandidateMain,
  releaseCandidatePlan,
  releaseOwners,
  remoteTagCommit,
  runReleaseCandidate,
} from "../lib/release-candidate.mjs";

// ADR-0177 D8. On 2026-09-14 the v1.0.0 tag was cut by hand while dev CI was still running, and every
// target failed its required-check wait one minute before ci turned green. The candidate workflow now
// points the tag at the exact dev head and the stable build waits for that head's required checks.

const REPO = "oscharko-dev/Keiko";
const CANDIDATE = "a".repeat(40);
const OLDER = "b".repeat(40);
const TAG = "v1.0.1";
const READY = {
  ready: true,
  releaseTag: TAG,
  reason: `${TAG} is approved for every portable target`,
};
const ROOT_PACKAGE = { name: "@oscharko-dev/keiko", version: "1.0.1" };
const OWNERS = releaseOwners('["oscharko"]');

function ok(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: "" };
}

const NOT_FOUND = { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
const SERVER_ERROR = { status: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)" };

function fakeGithub(overrides = {}) {
  const routes = {
    [`repos/${REPO}/git/ref/heads/dev`]: ok({ object: { sha: CANDIDATE, type: "commit" } }),
    [`repos/${REPO}/git/ref/tags/${TAG}`]: NOT_FOUND,
    [`repos/${REPO}/releases/tags/${TAG}`]: NOT_FOUND,
    [`repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`]:
      ok({
        workflow_runs: [],
      }),
    ...overrides,
  };
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    const path = args.at(-1);
    const route = routes[path];
    if (route !== undefined) return route;
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, runGh };
}

const NPM_MISSING = () => ({ status: 1, stdout: "", stderr: "npm error code E404" });

function plan(overrides) {
  return releaseCandidatePlan({
    candidateSha: CANDIDATE,
    devHeadSha: CANDIDATE,
    publishRunActive: false,
    published: false,
    readiness: READY,
    remoteTagSha: undefined,
    ...overrides,
  });
}

describe("releaseCandidatePlan", () => {
  it("creates the tag for an approved, unpublished version whose dev head is green", () => {
    expect(plan({})).toStrictEqual({
      action: "create",
      portableBuild: PORTABLE_BUILD_OWNERS.STABLE_TAG,
      tag: TAG,
      reason: `${TAG} does not exist yet`,
    });
  });

  it("moves an unpublished tag to the newer green dev head", () => {
    expect(plan({ remoteTagSha: OLDER }).action).toBe("move");
  });

  it("keeps a tag that already points at the candidate", () => {
    expect(plan({ remoteTagSha: CANDIDATE }).action).toBe("keep");
  });

  it("leaves a tag an owner's release request holds, and builds nothing for the newer head", () => {
    // ADR-0177 D9: an agent merge after the owner pressed the release button must not move the tag
    // away from the commit the owner authorized; the newer head belongs to the next release.
    expect(plan({ ownerRequestHeld: true, remoteTagSha: OLDER })).toStrictEqual({
      action: "skip",
      portableBuild: PORTABLE_BUILD_OWNERS.NONE,
      tag: TAG,
      reason: `a release owner requested ${TAG} at ${OLDER}, so the tag stays there`,
    });
  });

  it("keeps a held tag that already points at the candidate", () => {
    expect(plan({ ownerRequestHeld: true, remoteTagSha: CANDIDATE }).action).toBe("keep");
  });

  it.each([
    [
      "an unapproved version",
      { readiness: { ready: false, releaseTag: TAG, reason: "not approved" } },
    ],
    ["a candidate dev has moved past", { devHeadSha: OLDER }],
    ["a published version", { published: true, remoteTagSha: OLDER }],
    ["a tag whose publish is open", { publishRunActive: true, remoteTagSha: OLDER }],
  ])("skips %s", (_label, overrides) => {
    expect(plan(overrides).action).toBe("skip");
  });

  it("assigns exactly one portable build owner for every candidate state", () => {
    expect(plan({}).portableBuild).toBe(PORTABLE_BUILD_OWNERS.STABLE_TAG);
    expect(plan({ remoteTagSha: CANDIDATE }).portableBuild).toBe(PORTABLE_BUILD_OWNERS.STABLE_TAG);
    expect(plan({ published: true }).portableBuild).toBe(PORTABLE_BUILD_OWNERS.DEV_REHEARSAL);
    expect(plan({ devHeadSha: OLDER }).portableBuild).toBe(PORTABLE_BUILD_OWNERS.NONE);
    expect(plan({ publishRunActive: true, remoteTagSha: OLDER }).portableBuild).toBe(
      PORTABLE_BUILD_OWNERS.NONE,
    );
  });

  it.each([
    ["already published", { published: true }],
    ["tag absent", { remoteTagSha: undefined }],
    ["tag at candidate", { remoteTagSha: CANDIDATE }],
    ["tag at an older commit", { remoteTagSha: OLDER }],
  ])("gives an active publish sole build ownership when the version is %s", (_label, state) => {
    expect(plan({ ...state, publishRunActive: true })).toMatchObject({
      action: "skip",
      portableBuild: PORTABLE_BUILD_OWNERS.NONE,
      reason: expect.stringContaining("no second portable build"),
    });
  });

  it.each([
    ["candidate", { candidateSha: "HEAD" }],
    ["dev head", { devHeadSha: undefined }],
    ["release tag commit", { remoteTagSha: "abc" }],
  ])("refuses a malformed %s", (_label, overrides) => {
    expect(() => plan(overrides)).toThrow("is not a full commit SHA");
  });
});

describe("remoteTagCommit", () => {
  it("peels an annotated tag to its commit", () => {
    const { runGh } = fakeGithub({
      [`repos/${REPO}/git/ref/tags/${TAG}`]: ok({ object: { sha: "c".repeat(40), type: "tag" } }),
      [`repos/${REPO}/git/tags/${"c".repeat(40)}`]: ok({ object: { sha: OLDER, type: "commit" } }),
    });
    expect(remoteTagCommit(runGh, REPO, TAG)).toBe(OLDER);
  });

  it.each([
    [
      "a ref that points at a tree",
      ok({ object: { sha: OLDER, type: "tree" } }),
      "points at a tree",
    ],
    ["an unreadable ref", SERVER_ERROR, "could not be read"],
    [
      "a ref whose body is not JSON",
      { status: 0, stdout: "<html>", stderr: "" },
      "could not be read",
    ],
  ])("refuses %s", (_label, response, message) => {
    const { runGh } = fakeGithub({ [`repos/${REPO}/git/ref/tags/${TAG}`]: response });
    expect(() => remoteTagCommit(runGh, REPO, TAG)).toThrow(message);
  });

  it("refuses an annotated tag that does not point at a commit", () => {
    const { runGh } = fakeGithub({
      [`repos/${REPO}/git/ref/tags/${TAG}`]: ok({ object: { sha: "c".repeat(40), type: "tag" } }),
      [`repos/${REPO}/git/tags/${"c".repeat(40)}`]: ok({ object: { sha: OLDER, type: "tag" } }),
    });
    expect(() => remoteTagCommit(runGh, REPO, TAG)).toThrow("does not point at a commit");
  });
});

describe("planReleaseCandidate", () => {
  function gather(github, runNpm = NPM_MISSING, readiness = READY, withAllowlist = true) {
    return planReleaseCandidate({
      candidateSha: CANDIDATE,
      owners: withAllowlist ? OWNERS : undefined,
      readiness,
      repository: REPO,
      rootPackage: ROOT_PACKAGE,
      runGh: github.runGh,
      runNpm,
    });
  }

  it("reads only the dev head for a version that is not approved", () => {
    const github = fakeGithub();
    let npmCalls = 0;
    const result = gather(
      github,
      () => {
        npmCalls += 1;
        return NPM_MISSING();
      },
      { ready: false, releaseTag: TAG, reason: "not approved" },
    );

    expect(result.action).toBe("skip");
    expect(github.calls).toStrictEqual([["api", `repos/${REPO}/git/ref/heads/dev`]]);
    expect(npmCalls).toBe(0);
  });

  it("creates when npm, GitHub and the tag know nothing of the version", () => {
    expect(gather(fakeGithub()).action).toBe("create");
  });

  it("treats a version npm already carries as published", () => {
    const published = () => ({ status: 0, stdout: '"1.0.1"\n', stderr: "" });
    expect(gather(fakeGithub(), published).reason).toContain("already published");
  });

  it("treats a version with a GitHub release as published", () => {
    const github = fakeGithub({ [`repos/${REPO}/releases/tags/${TAG}`]: ok({ id: 1 }) });
    expect(gather(github).reason).toContain("already published");
  });

  it.each(["waiting", "requested", "pending", "queued", "in_progress"])(
    "does not move a tag while a publish of it is %s",
    (status) => {
      // "waiting" is the npm-publish approval gate: moving the tag there would let an approval given
      // for one commit publish another (review finding on #3488).
      const github = fakeGithub({
        [`repos/${REPO}/git/ref/tags/${TAG}`]: ok({ object: { sha: OLDER, type: "commit" } }),
        [`repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`]:
          ok({
            workflow_runs: [
              { head_branch: "v1.0.0", status: "in_progress" },
              { head_branch: TAG, status },
            ],
          }),
      });
      expect(gather(github)).toMatchObject({ action: "skip" });
      expect(gather(github).reason).toContain(`a publish of ${TAG} is open`);
    },
  );

  it("moves a tag whose publish runs have all completed, or belong to another tag", () => {
    const github = fakeGithub({
      [`repos/${REPO}/git/ref/tags/${TAG}`]: ok({ object: { sha: OLDER, type: "commit" } }),
      [`repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`]:
        ok({
          workflow_runs: [
            { head_branch: TAG, status: "completed" },
            { head_branch: "v1.0.0", status: "waiting" },
          ],
        }),
    });
    expect(gather(github).action).toBe("move");
  });

  const RUNS_PATH = `repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`;
  const human = { login: "oscharko", type: "User" };
  const request = (overrides) => ({
    event: "workflow_dispatch",
    head_branch: "dev",
    head_sha: OLDER,
    status: "completed",
    conclusion: "success",
    triggering_actor: human,
    ...overrides,
  });
  const tagAtOlder = ok({ object: { sha: OLDER, type: "commit" } });

  it.each([
    ["a successful request", request({})],
    ["a request that is still running", request({ status: "in_progress", conclusion: null })],
  ])("does not move a tag %s holds at its commit", (_label, run) => {
    const github = fakeGithub({
      [`repos/${REPO}/git/ref/tags/${TAG}`]: tagAtOlder,
      [RUNS_PATH]: ok({ workflow_runs: [run] }),
    });
    expect(gather(github)).toMatchObject({
      action: "skip",
      portableBuild: PORTABLE_BUILD_OWNERS.NONE,
      reason: `a release owner requested ${TAG} at ${OLDER}, so the tag stays there`,
    });
  });

  it.each([
    ["a failed request", request({ conclusion: "failure" })],
    ["a request no owner could make (every job skipped)", request({ conclusion: "skipped" })],
    [
      "a running request of an account outside the allowlist",
      request({
        status: "in_progress",
        conclusion: null,
        triggering_actor: { login: "contributor" },
      }),
    ],
    [
      "a successful run of an account outside the allowlist",
      request({ triggering_actor: { login: "contributor" } }),
    ],
    ["a request for another commit", request({ head_sha: "c".repeat(40) })],
    ["a bot dispatch on dev", request({ triggering_actor: { login: "github-actions[bot]" } })],
    ["a dispatch without an actor", request({ triggering_actor: undefined })],
    ["a publish run on the tag", request({ head_branch: TAG })],
    ["a push run on dev", request({ event: "push" })],
  ])("moves the tag past %s", (_label, run) => {
    const github = fakeGithub({
      [`repos/${REPO}/git/ref/tags/${TAG}`]: tagAtOlder,
      [RUNS_PATH]: ok({ workflow_runs: [run] }),
    });
    expect(gather(github).action).toBe("move");
  });

  it("computes no hold without an allowlist, as the dev rehearsal's readiness runs it", () => {
    // The readiness job reads no repository variable (release-portable-assets-workflow.test.mjs pins
    // that). Held or moved, the commit gets no dev rehearsal, so the answer it needs is the same.
    const github = fakeGithub({
      [`repos/${REPO}/git/ref/tags/${TAG}`]: tagAtOlder,
      [RUNS_PATH]: ok({ workflow_runs: [request({})] }),
    });
    const withoutAllowlist = gather(github, NPM_MISSING, READY, false);
    expect(withoutAllowlist.action).toBe("move");
    expect(withoutAllowlist.portableBuild).not.toBe(PORTABLE_BUILD_OWNERS.DEV_REHEARSAL);
    expect(gather(github).portableBuild).not.toBe(PORTABLE_BUILD_OWNERS.DEV_REHEARSAL);
  });

  it("creates a missing tag even when a request run carries no commit", () => {
    const github = fakeGithub({
      [RUNS_PATH]: ok({ workflow_runs: [request({ head_sha: undefined })] }),
    });
    expect(gather(github).action).toBe("create");
  });

  describe("for the release button", () => {
    function press(github) {
      return planReleaseCandidate({
        candidateSha: CANDIDATE,
        readiness: READY,
        repository: REPO,
        request: true,
        rootPackage: ROOT_PACKAGE,
        runGh: github.runGh,
        runNpm: NPM_MISSING,
      });
    }

    it("binds the pressed commit without reading the dev head, even after dev moved on", () => {
      const github = fakeGithub({
        [`repos/${REPO}/git/ref/heads/dev`]: ok({ object: { sha: OLDER, type: "commit" } }),
      });
      expect(press(github).action).toBe("create");
      expect(github.calls).not.toContainEqual(["api", `repos/${REPO}/git/ref/heads/dev`]);
    });

    it("moves a tag an older request holds: the newest press wins", () => {
      const github = fakeGithub({
        [`repos/${REPO}/git/ref/tags/${TAG}`]: tagAtOlder,
        [RUNS_PATH]: ok({ workflow_runs: [request({})] }),
      });
      expect(press(github).action).toBe("move");
    });

    it("still refuses to move a tag whose publish is open", () => {
      const github = fakeGithub({
        [`repos/${REPO}/git/ref/tags/${TAG}`]: tagAtOlder,
        [RUNS_PATH]: ok({ workflow_runs: [{ head_branch: TAG, status: "in_progress" }] }),
      });
      expect(press(github)).toMatchObject({ action: "skip" });
    });
  });

  it.each([
    [
      "the dev head",
      { [`repos/${REPO}/git/ref/heads/dev`]: SERVER_ERROR },
      "the dev head could not be read",
    ],
    ["the release", { [`repos/${REPO}/releases/tags/${TAG}`]: SERVER_ERROR }, "GitHub release"],
    [
      "the release runs",
      {
        [`repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`]:
          ok({}),
      },
      "release workflow runs are malformed",
    ],
  ])("fails closed when %s cannot be read", (_label, overrides, message) => {
    expect(() => gather(fakeGithub(overrides))).toThrow(message);
  });

  it("fails closed when npm cannot answer", () => {
    const broken = () => ({ status: 1, stdout: "", stderr: "npm error code ETIMEDOUT" });
    expect(() => gather(fakeGithub(), broken)).toThrow("npm could not say");
  });
});

describe("applyReleaseCandidatePlan", () => {
  const writeBody = (sha) => ok({ ref: `refs/tags/${TAG}`, object: { sha, type: "commit" } });

  function apply(action, { write = writeBody(CANDIDATE) } = {}) {
    const writes = [];
    const result = applyReleaseCandidatePlan({
      candidateSha: CANDIDATE,
      plan: { action, reason: "test", tag: TAG },
      repository: REPO,
      runGhWithTagToken: (args) => {
        writes.push(args);
        return write;
      },
    });
    return { result, writes };
  }

  it("creates the tag ref with the tag token and verifies from the write response", () => {
    // GitHub's git-refs API is eventually consistent for read-after-write: a POST that returns
    // 201 can be invisible to the next GET for a short window. On 2026-09-15 the v1.0.2 tag was
    // written correctly (the ref points at the candidate SHA), but the subsequent verify-read
    // returned 404 and turned "Point the release tag at the candidate" red. The write response
    // body carries the ref just written, atomic with the write — that is what proves the write,
    // not a subsequent GET.
    const { result, writes } = apply("create");
    expect(result).toBe(true);
    expect(writes).toStrictEqual([
      [
        "api",
        "--method",
        "POST",
        `repos/${REPO}/git/refs`,
        "-f",
        `ref=refs/tags/${TAG}`,
        "-f",
        `sha=${CANDIDATE}`,
      ],
    ]);
  });

  it("moves the tag ref with a forced update", () => {
    expect(apply("move").writes).toStrictEqual([
      [
        "api",
        "--method",
        "PATCH",
        `repos/${REPO}/git/refs/tags/${TAG}`,
        "-f",
        `sha=${CANDIDATE}`,
        "-F",
        "force=true",
      ],
    ]);
  });

  it.each(["skip", "keep"])("writes nothing for %s", (action) => {
    expect(apply(action)).toStrictEqual({ result: false, writes: [] });
  });

  it("fails when GitHub refuses the write", () => {
    expect(() => apply("create", { write: { status: 1, stdout: "", stderr: "HTTP 422" } })).toThrow(
      "could not be written (create)",
    );
  });

  it("fails when the write response body reports a different SHA", () => {
    expect(() => apply("move", { write: writeBody(OLDER) })).toThrow(
      `points at ${OLDER} after the write (move), not ${CANDIDATE}`,
    );
  });

  it("fails when the write response body is not JSON", () => {
    expect(() => apply("create", { write: { status: 0, stdout: "not-json", stderr: "" } })).toThrow(
      "write response (create) could not be parsed as JSON",
    );
  });

  it("fails when the write response body is empty", () => {
    // An empty stdout is a distinct boundary input from "not-json": both reach the same
    // parse-error catch, but the empty case is what a gh subprocess actually produces when it
    // returns status 0 but writes nothing (a runner that drops the response body before we
    // read it, a piped shim that swallowed stdout). Refuse it the same way — never let a
    // silent write pass as a proof.
    expect(() => apply("create", { write: { status: 0, stdout: "", stderr: "" } })).toThrow(
      "write response (create) could not be parsed as JSON",
    );
  });

  it("fails when the write response body points at an annotated tag instead of a commit", () => {
    // The candidate flow writes the ref straight to the commit SHA (POST /git/refs with
    // sha=<commit>), so the response object.type must be "commit". An object.type of "tag"
    // means the server did something we did not ask for — refuse rather than trust it.
    expect(() =>
      apply("create", {
        write: ok({ ref: `refs/tags/${TAG}`, object: { sha: CANDIDATE, type: "tag" } }),
      }),
    ).toThrow(`points at ? after the write (create), not ${CANDIDATE}`);
  });
});

describe("runReleaseCandidate", () => {
  const writeResponse = ok({
    ref: `refs/tags/${TAG}`,
    object: { sha: CANDIDATE, type: "commit" },
  });

  function run(mode, env = {}, github = fakeGithub()) {
    const appended = [];
    const writes = [];
    const result = runReleaseCandidate({
      appendFile: (path, text) => appended.push([path, text]),
      decideReadiness: () => READY,
      env: {
        CANDIDATE_SHA: CANDIDATE,
        GITHUB_OUTPUT: "/out",
        GITHUB_REPOSITORY: REPO,
        GITHUB_STEP_SUMMARY: "/summary",
        ...env,
      },
      mode,
      readText: (path) =>
        path === "package.json" ? JSON.stringify(ROOT_PACKAGE) : '{"entries":[]}',
      runGh: github.runGh,
      runGhWithTagToken: (args) => {
        writes.push(args);
        return writeResponse;
      },
      runNpm: NPM_MISSING,
    });
    return { appended, result, writes };
  }

  it("plans without writing and hands the action to the workflow", () => {
    const { appended, result, writes } = run("--plan");
    expect(result.plan.action).toBe("create");
    expect(writes).toStrictEqual([]);
    expect(appended).toStrictEqual([
      ["/out", `action=create\ntag=${TAG}\nportable-build=stable-tag\n`],
      ["/summary", `Release candidate ${CANDIDATE}: create, ${TAG} does not exist yet.\n`],
    ]);
  });

  it("applies a create with the tag token and says so", () => {
    const github = fakeGithub();
    const appended = [];
    const result = runReleaseCandidate({
      appendFile: (path, text) => appended.push([path, text]),
      decideReadiness: () => READY,
      env: {
        CANDIDATE_SHA: CANDIDATE,
        GITHUB_REPOSITORY: REPO,
        KEIKO_RELEASE_TAG_TOKEN: "app-token",
      },
      mode: "--apply",
      readText: (path) =>
        path === "package.json" ? JSON.stringify(ROOT_PACKAGE) : '{"entries":[]}',
      runGh: github.runGh,
      runGhWithTagToken: () =>
        ok({ ref: `refs/tags/${TAG}`, object: { sha: CANDIDATE, type: "commit" } }),
      runNpm: NPM_MISSING,
    });
    expect(result.line).toBe(
      `Release candidate ${CANDIDATE}: ${TAG} written (create), ${TAG} does not exist yet.`,
    );
    expect(appended).toStrictEqual([]);
  });

  it("refuses to apply a write without the tag token", () => {
    expect(() => run("--apply", { KEIKO_RELEASE_TAG_TOKEN: "" })).toThrow(
      "release tag token is missing",
    );
  });

  it("applies nothing for a plan that does not write", () => {
    const github = fakeGithub({
      [`repos/${REPO}/git/ref/tags/${TAG}`]: ok({ object: { sha: CANDIDATE, type: "commit" } }),
    });
    const { result, writes } = run("--apply", {}, github);
    expect(result.plan.action).toBe("keep");
    expect(writes).toStrictEqual([]);
  });

  it("requests a release: writes the tag with the tag token and says the rest is automatic", () => {
    const { appended, result, writes } = run("--request", { KEIKO_RELEASE_TAG_TOKEN: "app-token" });
    expect(result.plan.action).toBe("create");
    expect(writes).toHaveLength(1);
    expect(result.line).toBe(
      `Release ${TAG} requested for ${CANDIDATE}: ${TAG} written (create). The publish starts by ` +
        "itself once the tag build and every release-required check are green.",
    );
    // The request hands nothing to later jobs; only the summary reports it.
    expect(appended).toStrictEqual([["/summary", `${result.line}\n`]]);
  });

  it("requests a release whose tag already points at the pressed commit without a write", () => {
    const github = fakeGithub({
      [`repos/${REPO}/git/ref/tags/${TAG}`]: ok({ object: { sha: CANDIDATE, type: "commit" } }),
    });
    const { result, writes } = run("--request", {}, github);
    expect(writes).toStrictEqual([]);
    expect(result.line).toContain(`${TAG} already points at ${CANDIDATE}`);
  });

  it("fails a request for a tag whose publish is still running, so the run is no authorization", () => {
    const overrides = {
      [`repos/${REPO}/git/ref/tags/${TAG}`]: ok({ object: { sha: OLDER, type: "commit" } }),
      [`repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`]:
        ok({ workflow_runs: [{ head_branch: TAG, status: "queued" }] }),
    };
    expect(() =>
      run("--request", { KEIKO_RELEASE_TAG_TOKEN: "app-token" }, fakeGithub(overrides)),
    ).toThrow(
      `release-candidate: ${TAG} cannot be released from ${CANDIDATE}: a publish of ${TAG} is open`,
    );
  });

  // #3565. The button used to answer an already-published dev version by moving the version itself on
  // an App-opened pull request. That second, purely mechanical pull request cost every release a
  // second full required matrix, and its merge never satisfied the publish authorization. The pull
  // request that declares a release carries its version now (check:release-impact), so the button
  // only ever releases what dev already is, and says so when there is nothing to release.
  it("refuses a request for an already-published version and never moves a version", () => {
    const github = fakeGithub({ [`repos/${REPO}/releases/tags/${TAG}`]: ok({ id: 1 }) });
    expect(() => run("--request", { KEIKO_RELEASE_TAG_TOKEN: "app-token" }, github)).toThrow(
      `${TAG} cannot be released from ${CANDIDATE}: ${TAG} is already published, and its tag ` +
        "never moves.",
    );
    expect(github.calls.some((args) => args.includes("--method"))).toBe(false);
  });

  it("fails a request for an unapproved version", () => {
    const appended = [];
    expect(() =>
      runReleaseCandidate({
        appendFile: (path, text) => appended.push([path, text]),
        decideReadiness: () => ({ ready: false, releaseTag: TAG, reason: "not approved" }),
        env: { CANDIDATE_SHA: CANDIDATE, GITHUB_REPOSITORY: REPO },
        mode: "--request",
        readText: (path) =>
          path === "package.json" ? JSON.stringify(ROOT_PACKAGE) : '{"entries":[]}',
        runGh: fakeGithub().runGh,
        runGhWithTagToken: () => {
          throw new Error("no write expected");
        },
        runNpm: NPM_MISSING,
      }),
    ).toThrow(`${TAG} cannot be released from ${CANDIDATE}: not approved.`);
    expect(appended).toStrictEqual([]);
  });

  it("holds the tag for an owner's request when the tag-writing job passes the allowlist", () => {
    const github = fakeGithub({
      [`repos/${REPO}/git/ref/tags/${TAG}`]: ok({ object: { sha: OLDER, type: "commit" } }),
      [`repos/${REPO}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&page=1`]:
        ok({
          workflow_runs: [
            {
              conclusion: "success",
              event: "workflow_dispatch",
              head_branch: "dev",
              head_sha: OLDER,
              status: "completed",
              triggering_actor: { login: "oscharko" },
            },
          ],
        }),
    });
    const { result, writes } = run(
      "--apply",
      { KEIKO_RELEASE_OWNER_GITHUB_LOGINS: '["oscharko"]', KEIKO_RELEASE_TAG_TOKEN: "app-token" },
      github,
    );
    expect(result.plan.action).toBe("skip");
    expect(writes).toStrictEqual([]);
  });

  it("fails a tag-writing plan closed on an empty or malformed allowlist", () => {
    expect(() => run("--plan", { KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "" })).toThrow(
      "KEIKO_RELEASE_OWNER_GITHUB_LOGINS is not a JSON array of human logins",
    );
    expect(() => run("--apply", { KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "oscharko" })).toThrow(
      "is not a JSON array of human logins",
    );
  });

  it("refuses to request a release without the tag token", () => {
    expect(() => run("--request", { KEIKO_RELEASE_TAG_TOKEN: "" })).toThrow(
      "release tag token is missing",
    );
  });

  it.each([
    ["an unknown mode", "--publish", {}, "pass --plan, --apply or --request"],
    [
      "a malformed candidate",
      "--plan",
      { CANDIDATE_SHA: "dev" },
      "CANDIDATE_SHA is not a full commit SHA",
    ],
    [
      "a malformed repository",
      "--plan",
      { GITHUB_REPOSITORY: "Keiko" },
      "GITHUB_REPOSITORY is not owner/repo",
    ],
  ])("refuses %s", (_label, mode, env, message) => {
    expect(() => run(mode, env)).toThrow(message);
  });
});

describe("releaseCandidateMain", () => {
  function main({ argv = ["--plan"], env = {}, spawn } = {}) {
    const written = [];
    const spawns = [];
    const github = fakeGithub();
    const code = releaseCandidateMain({
      appendFile: (_path, text) => written.push(["summary", text]),
      argv,
      decideReadiness: () => READY,
      env: {
        CANDIDATE_SHA: CANDIDATE,
        GITHUB_REPOSITORY: REPO,
        GITHUB_TOKEN: "workflow-token",
        ...env,
      },
      readText: (file) =>
        file === "package.json" ? JSON.stringify(ROOT_PACKAGE) : '{"entries":[]}',
      spawn:
        spawn ??
        ((executable, args, spawnEnv) => {
          spawns.push([executable, spawnEnv.GH_TOKEN]);
          return executable === "npm" ? NPM_MISSING() : github.runGh(args);
        }),
      write: (stream, text) => written.push([stream, text]),
    });
    return { code, spawns, written };
  }

  it("plans with the workflow token for gh and no token override for npm", () => {
    const { code, spawns, written } = main();
    expect(code).toBe(0);
    expect(written).toStrictEqual([
      ["stdout", `Release candidate ${CANDIDATE}: create, ${TAG} does not exist yet.\n`],
    ]);
    expect(spawns).toContainEqual(["gh", "workflow-token"]);
    expect(spawns).toContainEqual(["npm", undefined]);
  });

  it("prints a known refusal as it is and exits 1", () => {
    const { code, written } = main({ argv: ["--publish"] });
    expect(code).toBe(1);
    expect(written).toStrictEqual([
      ["stderr", "release-candidate: pass --plan, --apply or --request.\n"],
    ]);
  });

  it("prefixes an unexpected failure and a thrown non-Error", () => {
    expect(
      main({
        spawn: () => {
          throw new TypeError("spawn failed");
        },
      }).written,
    ).toStrictEqual([["stderr", "release-candidate: spawn failed\n"]]);
    expect(
      main({
        spawn: () => {
          throw "gone";
        },
      }).written,
    ).toStrictEqual([["stderr", "release-candidate: gone\n"]]);
  });

  it("spawns gh without a token override when the workflow token is absent", () => {
    const { spawns } = main({ env: { GITHUB_TOKEN: undefined } });
    expect(spawns).toContainEqual(["gh", undefined]);
  });
});
