import { describe, expect, it } from "vitest";

import {
  applyVersionBumpRequest,
  isVersionBumpAuthorizationPr,
  nextReviewedVersion,
  readVersionBumpAuthorization,
  VERSION_BUMP_APP_LOGIN,
  VERSION_BUMP_BRANCH_PREFIX,
  versionBumpBranch,
} from "../lib/release-version-bump.mjs";

// ADR-0177 D9 follow-up. The button used to fail outright once dev's current version was already
// published (#3551's own known gap). release-impact.catalog.json entries are written ahead of time
// during normal feature review -- 1.0.6's own entry sat reviewed on dev before any bump existed -- so
// preparing the next release needs no new human judgment, only a mechanical version move and a
// non-forgeable way to recognize its own PR's merge as the same owner authorization that opened it.

const REPO = "oscharko-dev/Keiko";
const ROOT_PACKAGE = { name: "@oscharko-dev/keiko", version: "1.0.5" };

function reviewedEntry(overrides = {}) {
  return {
    packageName: ROOT_PACKAGE.name,
    packageVersion: "1.0.6",
    review: { humanApproved: true, status: "reviewed" },
    ...overrides,
  };
}

describe("nextReviewedVersion", () => {
  it("finds the lowest stable version above the current one with a reviewed entry", () => {
    const catalog = { entries: [reviewedEntry({ packageVersion: "1.0.7" }), reviewedEntry()] };
    expect(nextReviewedVersion(catalog, ROOT_PACKAGE)).toBe("1.0.6");
  });

  it("returns undefined when nothing newer is reviewed", () => {
    expect(nextReviewedVersion({ entries: [] }, ROOT_PACKAGE)).toBeUndefined();
    expect(
      nextReviewedVersion({ entries: [reviewedEntry({ packageVersion: "1.0.4" })] }, ROOT_PACKAGE),
    ).toBeUndefined();
  });

  it.each([
    ["a different package", { packageName: "other" }],
    ["a correction entry", { correctionOf: "some-id" }],
    ["a superseding entry", { supersedes: ["some-id"] }],
    ["a prerelease version", { packageVersion: "1.0.6-beta.0" }],
    ["a non-semver version", { packageVersion: "not-a-version" }],
    ["a pending review", { review: { humanApproved: false, status: "pending" } }],
    ["a review missing humanApproved", { review: { status: "reviewed" } }],
  ])("ignores %s", (_label, overrides) => {
    const catalog = { entries: [reviewedEntry(overrides)] };
    expect(nextReviewedVersion(catalog, ROOT_PACKAGE)).toBeUndefined();
  });

  it("refuses two reviewed entries that claim the same next version", () => {
    const catalog = {
      entries: [
        reviewedEntry({ id: "a" }),
        reviewedEntry({ id: "b" }),
        reviewedEntry({ id: "c", packageVersion: "1.0.7" }),
      ],
    };
    expect(() => nextReviewedVersion(catalog, ROOT_PACKAGE)).toThrow(
      "2 reviewed catalog entries claim 1.0.6; consolidate them",
    );
  });

  it("refuses a root package whose own version is not stable", () => {
    expect(() =>
      nextReviewedVersion({ entries: [] }, { ...ROOT_PACKAGE, version: "1.0.5-rc.1" }),
    ).toThrow("1.0.5-rc.1 is not a stable version");
  });
});

describe("versionBumpBranch", () => {
  it("prefixes the reserved branch namespace", () => {
    expect(versionBumpBranch("1.0.6")).toBe(`${VERSION_BUMP_BRANCH_PREFIX}1.0.6`);
  });

  it("refuses a non-semantic version", () => {
    expect(() => versionBumpBranch("not-a-version")).toThrow("is not a semantic version");
  });
});

describe("isVersionBumpAuthorizationPr", () => {
  const validPr = {
    base: { ref: "dev" },
    commits: 1,
    head: { ref: `${VERSION_BUMP_BRANCH_PREFIX}1.0.6` },
    merged: true,
    user: { login: VERSION_BUMP_APP_LOGIN },
  };

  it("accepts a merged, single-commit, App-authored bump PR into dev", () => {
    expect(isVersionBumpAuthorizationPr(validPr)).toBe(true);
  });

  it.each([
    ["not an object", null],
    ["not merged yet", { ...validPr, merged: false }],
    ["opened by anyone else", { ...validPr, user: { login: "a-collaborator" } }],
    ["targeting another branch", { ...validPr, base: { ref: "release/1.0" } }],
    ["off the reserved branch prefix", { ...validPr, head: { ref: "feat/something" } }],
    ["carrying a second, unreviewed commit", { ...validPr, commits: 2 }],
  ])("refuses a PR %s", (_label, pr) => {
    expect(isVersionBumpAuthorizationPr(pr)).toBe(false);
  });
});

function ok(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: "" };
}

const NOT_FOUND = { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
const SHA = "c".repeat(40);

function fakeGithub(routes) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    const route = routes[args.at(-1)];
    if (route === undefined) throw new Error(`unexpected gh call: ${args.join(" ")}`);
    return route;
  };
  return { calls, runGh };
}

describe("readVersionBumpAuthorization", () => {
  const authorizationPr = {
    base: { ref: "dev" },
    commits: 1,
    head: { ref: `${VERSION_BUMP_BRANCH_PREFIX}1.0.6` },
    merge_commit_sha: SHA,
    merged: true,
    number: 7,
    user: { login: VERSION_BUMP_APP_LOGIN },
  };

  it("finds the PR associated with the commit through GitHub's own index", () => {
    const { runGh } = fakeGithub({
      [`repos/${REPO}/commits/${SHA}/pulls`]: ok([authorizationPr]),
      [`repos/${REPO}/pulls/7`]: ok(authorizationPr),
    });
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toStrictEqual(authorizationPr);
  });

  it("returns undefined when no associated PR was opened by the release App", () => {
    const { runGh } = fakeGithub({
      [`repos/${REPO}/commits/${SHA}/pulls`]: ok([
        { ...authorizationPr, user: { login: "someone-else" } },
      ]),
    });
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  it("returns undefined when no PR is associated with the commit at all", () => {
    const { runGh } = fakeGithub({ [`repos/${REPO}/commits/${SHA}/pulls`]: ok([]) });
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  it("returns undefined when the associated PR's own merge commit does not match", () => {
    const { runGh } = fakeGithub({
      [`repos/${REPO}/commits/${SHA}/pulls`]: ok([
        { ...authorizationPr, merge_commit_sha: "d".repeat(40) },
      ]),
    });
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  it("returns undefined when the matched PR's full detail fails isVersionBumpAuthorizationPr", () => {
    const { runGh } = fakeGithub({
      [`repos/${REPO}/commits/${SHA}/pulls`]: ok([authorizationPr]),
      [`repos/${REPO}/pulls/7`]: ok({ ...authorizationPr, commits: 2 }),
    });
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  it("fails closed on a malformed or unreadable commit-pulls listing", () => {
    const malformed = fakeGithub({
      [`repos/${REPO}/commits/${SHA}/pulls`]: ok({ not: "an array" }),
    });
    expect(() => readVersionBumpAuthorization(malformed.runGh, REPO, SHA)).toThrow("malformed");
    const unreadable = fakeGithub({ [`repos/${REPO}/commits/${SHA}/pulls`]: NOT_FOUND });
    expect(() => readVersionBumpAuthorization(unreadable.runGh, REPO, SHA)).toThrow(
      "could not be read",
    );
  });
});

describe("applyVersionBumpRequest", () => {
  function fakeRunner() {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      if (args[0] === "api" && args[3] === `repos/${REPO}/pulls`) {
        return ok({ number: 9 });
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  }

  it("branches, commits, pushes, opens the PR and arms auto-merge in order", () => {
    const git = fakeRunner();
    const gh = fakeRunner();
    const applySetVersion = (version) => {
      expect(version).toBe("1.0.6");
    };
    const result = applyVersionBumpRequest({
      applySetVersion,
      remoteUrl: "https://x-access-token:t@github.com/oscharko-dev/Keiko.git",
      repository: REPO,
      runGhWithTagToken: gh.run,
      runGit: git.run,
      version: "1.0.6",
    });
    expect(result).toStrictEqual({
      branch: `${VERSION_BUMP_BRANCH_PREFIX}1.0.6`,
      prNumber: 9,
      version: "1.0.6",
    });
    expect(git.calls.map((args) => args[0])).toStrictEqual([
      "remote",
      "checkout",
      "config",
      "config",
      "add",
      "commit",
      "push",
    ]);
    expect(gh.calls[0]).toStrictEqual([
      "api",
      "--method",
      "POST",
      `repos/${REPO}/pulls`,
      "-f",
      expect.stringContaining("title="),
      "-f",
      `head=${VERSION_BUMP_BRANCH_PREFIX}1.0.6`,
      "-f",
      "base=dev",
      "-F",
      expect.stringContaining("body="),
    ]);
    expect(gh.calls[1]).toStrictEqual(["pr", "merge", "--auto", "--squash", "9", "--repo", REPO]);
  });

  it("fails closed when a git step fails", () => {
    const git = {
      run: (args) =>
        args[0] === "push"
          ? { status: 1, stdout: "", stderr: "denied" }
          : { status: 0, stdout: "", stderr: "" },
    };
    expect(() =>
      applyVersionBumpRequest({
        applySetVersion: () => undefined,
        remoteUrl: "https://x-access-token:t@github.com/oscharko-dev/Keiko.git",
        repository: REPO,
        runGhWithTagToken: () => ok({ number: 1 }),
        runGit: git.run,
        version: "1.0.6",
      }),
    ).toThrow("pushing the version-bump branch failed: denied");
  });

  it("fails closed when the opened pull request has no number", () => {
    expect(() =>
      applyVersionBumpRequest({
        applySetVersion: () => undefined,
        remoteUrl: "https://x-access-token:t@github.com/oscharko-dev/Keiko.git",
        repository: REPO,
        runGhWithTagToken: () => ok({}),
        runGit: () => ({ status: 0, stdout: "", stderr: "" }),
        version: "1.0.6",
      }),
    ).toThrow("the opened pull request has no number");
  });
});
