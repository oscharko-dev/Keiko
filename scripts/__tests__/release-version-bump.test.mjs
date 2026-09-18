import { Buffer } from "node:buffer";

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
import { versionedManifest } from "../lib/set-version.mjs";

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

// #3555 review: isVersionBumpAuthorizationPr checks only PR metadata (opener, base, head prefix,
// commit count) -- fields that all survive unchanged when a collaborator with ordinary repo write
// access force-pushes a same-commit-count REPLACEMENT onto release/bump-<version> before it merges.
// readVersionBumpAuthorization must also verify the merge commit's own content, so a same-count
// substitution -- extra file, extra property, or a value that doesn't match a clean mechanical bump
// -- is refused even though every metadata field still reads exactly as an honest App-opened PR.
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

  const PARENT_SHA = "b".repeat(40);
  const WORKSPACE = "@oscharko-dev/keiko-a";
  const parentRoot = { name: ROOT_PACKAGE.name, version: "1.0.5" };
  const parentWorkspace = { name: WORKSPACE, version: "1.0.5" };
  const parentLockfile = {
    version: "1.0.5",
    lockfileVersion: 3,
    packages: {
      "": { name: ROOT_PACKAGE.name, version: "1.0.5" },
      "packages/keiko-a": { name: WORKSPACE, version: "1.0.5" },
    },
  };
  const headRoot = versionedManifest(JSON.stringify(parentRoot), new Set([WORKSPACE]), "1.0.6");
  const headWorkspace = versionedManifest(
    JSON.stringify(parentWorkspace),
    new Set([WORKSPACE]),
    "1.0.6",
  );
  const headLockfile = {
    ...parentLockfile,
    version: "1.0.6",
    packages: {
      "": { name: ROOT_PACKAGE.name, version: "1.0.6" },
      "packages/keiko-a": { name: WORKSPACE, version: "1.0.6" },
    },
  };

  function base64File(text) {
    return ok({ content: Buffer.from(text, "utf8").toString("base64"), encoding: "base64" });
  }

  function jsonFile(value) {
    return base64File(JSON.stringify(value));
  }

  /** A genuinely clean bump: root + one workspace manifest + the lockfile, nothing else. */
  function cleanBumpRoutes(overrides = {}) {
    return {
      [`repos/${REPO}/commits/${SHA}`]: ok({
        files: [
          { filename: "package.json", status: "modified" },
          { filename: "packages/keiko-a/package.json", status: "modified" },
          { filename: "package-lock.json", status: "modified" },
        ],
        parents: [{ sha: PARENT_SHA }],
      }),
      [`repos/${REPO}/commits/${SHA}/pulls`]: ok([authorizationPr]),
      [`repos/${REPO}/contents/package.json?ref=${PARENT_SHA}`]: jsonFile(parentRoot),
      [`repos/${REPO}/contents/package.json?ref=${SHA}`]: base64File(headRoot),
      [`repos/${REPO}/contents/package-lock.json?ref=${PARENT_SHA}`]: jsonFile(parentLockfile),
      [`repos/${REPO}/contents/package-lock.json?ref=${SHA}`]: jsonFile(headLockfile),
      [`repos/${REPO}/contents/packages?ref=${PARENT_SHA}`]: ok([
        { path: "packages/keiko-a", type: "dir" },
      ]),
      [`repos/${REPO}/contents/packages/keiko-a/package.json?ref=${PARENT_SHA}`]:
        jsonFile(parentWorkspace),
      [`repos/${REPO}/contents/packages/keiko-a/package.json?ref=${SHA}`]:
        base64File(headWorkspace),
      [`repos/${REPO}/pulls/7`]: ok(authorizationPr),
      ...overrides,
    };
  }

  it("finds the PR associated with the commit through GitHub's own index", () => {
    const { runGh } = fakeGithub(cleanBumpRoutes());
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toStrictEqual(authorizationPr);
  });

  it("refuses a same-count commit that touches a file outside the mechanical bump set", () => {
    const { runGh } = fakeGithub(
      cleanBumpRoutes({
        [`repos/${REPO}/commits/${SHA}`]: ok({
          files: [
            { filename: "package.json", status: "modified" },
            { filename: "packages/keiko-a/src/index.ts", status: "modified" },
          ],
          parents: [{ sha: PARENT_SHA }],
        }),
        [`repos/${REPO}/contents/packages/keiko-a/src/index.ts?ref=${PARENT_SHA}`]:
          base64File("export const a = 1;\n"),
        [`repos/${REPO}/contents/packages/keiko-a/src/index.ts?ref=${SHA}`]: base64File(
          "export const a = 2; /* smuggled */\n",
        ),
      }),
    );
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  it("refuses a same-count commit whose manifest content was replaced, not mechanically bumped", () => {
    // Formatted exactly like the real transform's own output (JSON.stringify(_, null, 2) + "\n"),
    // so this isolates the one property a force-push tampering could add -- not a formatting
    // difference the byte-exact comparison would also have caught on its own.
    const tamperedRoot = `${JSON.stringify({ ...JSON.parse(headRoot), extraField: "smuggled" }, null, 2)}\n`;
    const { runGh } = fakeGithub(
      cleanBumpRoutes({
        [`repos/${REPO}/contents/package.json?ref=${SHA}`]: base64File(tamperedRoot),
      }),
    );
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  it("refuses a lockfile that changed beyond a version bump", () => {
    const tamperedLockfile = {
      ...headLockfile,
      packages: {
        ...headLockfile.packages,
        "node_modules/left-pad": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
          integrity: "sha512-abc",
        },
      },
    };
    const { runGh } = fakeGithub(
      cleanBumpRoutes({
        [`repos/${REPO}/contents/package-lock.json?ref=${SHA}`]: jsonFile(tamperedLockfile),
      }),
    );
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  it("refuses a commit that added a file instead of only modifying existing ones", () => {
    const { runGh } = fakeGithub(
      cleanBumpRoutes({
        [`repos/${REPO}/commits/${SHA}`]: ok({
          files: [
            { filename: "package.json", status: "modified" },
            { filename: "packages/keiko-a/package.json", status: "modified" },
            { filename: "package-lock.json", status: "modified" },
            { filename: "packages/keiko-b/package.json", status: "added" },
          ],
          parents: [{ sha: PARENT_SHA }],
        }),
      }),
    );
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  it("refuses a merge commit with no single parent", () => {
    const { runGh } = fakeGithub(
      cleanBumpRoutes({ [`repos/${REPO}/commits/${SHA}`]: ok({ files: [], parents: [] }) }),
    );
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  // #3555 review: verifyMechanicalVersionBump derives its version from the head content alone and
  // never asserted it against the branch it came from, so a clean bump to a *different* reviewed
  // version than the branch name claims (release/bump-1.0.6 containing a verified 1.0.6 bump, but a
  // PR whose own head.ref claims a different target) passed every other check unchanged.
  it("refuses a clean bump whose verified version does not match the authorized branch name", () => {
    const { runGh } = fakeGithub(
      cleanBumpRoutes({
        [`repos/${REPO}/pulls/7`]: ok({
          ...authorizationPr,
          head: { ref: `${VERSION_BUMP_BRANCH_PREFIX}1.0.7` },
        }),
      }),
    );
    expect(readVersionBumpAuthorization(runGh, REPO, SHA)).toBeUndefined();
  });

  it("refuses when no associated PR was opened by the release App", () => {
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

// #3555 review: a partial failure from a prior press -- the PR API call refused before the App had
// pull_requests: write, a transient error arming auto-merge, or the button pressed twice before the
// first press's PR merged -- must never leave the deterministic branch name permanently stuck, since
// nothing here force-pushes over it. applyVersionBumpRequest must resume from whatever a prior press
// already did instead of blindly re-attempting the mechanical commit and push.
describe("applyVersionBumpRequest", () => {
  const BRANCH = `${VERSION_BUMP_BRANCH_PREFIX}1.0.6`;
  const REF_PATH = `repos/${REPO}/git/ref/heads/${BRANCH}`;
  const PRS_PATH = `repos/${REPO}/pulls?head=oscharko-dev:${BRANCH}&state=all&per_page=100`;

  function fakeGit() {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  }

  function fakeGh(routes) {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] !== "--method") return routes[args.at(-1)];
      if (args[0] === "api" && args[3] === `repos/${REPO}/pulls`) return routes.openPr;
      if (args[0] === "pr" && args[1] === "merge") return routes.mergeResult ?? ok({});
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    return { calls, run };
  }

  function pr(overrides) {
    return { merged_at: null, number: 5, state: "open", ...overrides };
  }

  function bump(overrides) {
    return applyVersionBumpRequest({
      applySetVersion: () => undefined,
      remoteUrl: "https://x-access-token:t@github.com/oscharko-dev/Keiko.git",
      repository: REPO,
      version: "1.0.6",
      ...overrides,
    });
  }

  it("branches, commits, pushes, opens the PR and arms auto-merge when nothing exists yet", () => {
    const git = fakeGit();
    const gh = fakeGh({ [PRS_PATH]: ok([]), [REF_PATH]: NOT_FOUND, openPr: ok({ number: 9 }) });
    const applySetVersion = (version) => {
      expect(version).toBe("1.0.6");
    };
    const result = bump({ applySetVersion, runGhWithTagToken: gh.run, runGit: git.run });
    expect(result).toStrictEqual({ branch: BRANCH, prNumber: 9, version: "1.0.6" });
    expect(git.calls.map((args) => args[0])).toStrictEqual([
      "remote",
      "checkout",
      "config",
      "config",
      "add",
      "commit",
      "push",
    ]);
    expect(gh.calls.at(-2)).toStrictEqual([
      "api",
      "--method",
      "POST",
      `repos/${REPO}/pulls`,
      "-f",
      expect.stringContaining("title="),
      "-f",
      `head=${BRANCH}`,
      "-f",
      "base=dev",
      "-F",
      expect.stringContaining("body="),
    ]);
    expect(gh.calls.at(-1)).toStrictEqual([
      "pr",
      "merge",
      "--auto",
      "--squash",
      "9",
      "--repo",
      REPO,
    ]);
  });

  it("resumes by opening a PR, without re-committing, when the branch was pushed but no PR exists", () => {
    const git = fakeGit();
    const gh = fakeGh({ [PRS_PATH]: ok([]), [REF_PATH]: ok({}), openPr: ok({ number: 9 }) });
    const result = bump({ runGhWithTagToken: gh.run, runGit: git.run });
    expect(result).toStrictEqual({ branch: BRANCH, prNumber: 9, version: "1.0.6" });
    expect(git.calls).toStrictEqual([]);
  });

  it("resumes by re-arming auto-merge, without touching git or opening a second PR, when open", () => {
    const git = fakeGit();
    const gh = fakeGh({ [PRS_PATH]: ok([pr({ number: 5 })]), [REF_PATH]: ok({}) });
    const result = bump({ runGhWithTagToken: gh.run, runGit: git.run });
    expect(result).toStrictEqual({ branch: BRANCH, prNumber: 5, version: "1.0.6" });
    expect(git.calls).toStrictEqual([]);
    expect(gh.calls).toStrictEqual([
      ["api", REF_PATH],
      ["api", PRS_PATH],
      ["pr", "merge", "--auto", "--squash", "5", "--repo", REPO],
    ]);
  });

  it("reports success without re-arming a pull request that already merged", () => {
    const git = fakeGit();
    const gh = fakeGh({
      [PRS_PATH]: ok([pr({ merged_at: "2026-09-18T00:00:00Z", number: 3, state: "closed" })]),
      [REF_PATH]: ok({}),
    });
    const result = bump({ runGhWithTagToken: gh.run, runGit: git.run });
    expect(result).toStrictEqual({ branch: BRANCH, prNumber: 3, version: "1.0.6" });
    expect(git.calls).toStrictEqual([]);
    expect(gh.calls.some((args) => args[0] === "pr")).toBe(false);
  });

  it("fails closed on a closed, unmerged pull request instead of reusing or replacing the branch", () => {
    const gh = fakeGh({
      [PRS_PATH]: ok([pr({ merged_at: null, number: 4, state: "closed" })]),
      [REF_PATH]: ok({}),
    });
    expect(() => bump({ runGhWithTagToken: gh.run, runGit: fakeGit().run })).toThrow(
      `${BRANCH} already exists with a closed, unmerged pull request #4; resolve or delete it`,
    );
  });

  it("fails closed rather than guess among too many pull requests to resume safely", () => {
    const gh = fakeGh({
      [PRS_PATH]: ok(
        Array.from({ length: 100 }, (_unused, index) => pr({ number: index, state: "closed" })),
      ),
      [REF_PATH]: ok({}),
    });
    expect(() => bump({ runGhWithTagToken: gh.run, runGit: fakeGit().run })).toThrow(
      "too many pull requests to resume safely",
    );
  });

  it("fails closed when a git step fails", () => {
    const git = {
      run: (args) =>
        args[0] === "push"
          ? { status: 1, stdout: "", stderr: "denied" }
          : { status: 0, stdout: "", stderr: "" },
    };
    const gh = fakeGh({ [PRS_PATH]: ok([]), [REF_PATH]: NOT_FOUND, openPr: ok({ number: 1 }) });
    expect(() => bump({ runGhWithTagToken: gh.run, runGit: git.run })).toThrow(
      "pushing the version-bump branch failed: denied",
    );
  });

  it("fails closed when the opened pull request has no number", () => {
    const gh = fakeGh({ [PRS_PATH]: ok([]), [REF_PATH]: NOT_FOUND, openPr: ok({}) });
    expect(() => bump({ runGhWithTagToken: gh.run, runGit: fakeGit().run })).toThrow(
      "the opened pull request has no number",
    );
  });

  it("fails closed on a malformed or unreadable pull request listing", () => {
    const malformedGh = fakeGh({ [PRS_PATH]: ok({ not: "an array" }), [REF_PATH]: ok({}) });
    expect(() => bump({ runGhWithTagToken: malformedGh.run, runGit: fakeGit().run })).toThrow(
      "malformed",
    );
    const unreadableGh = fakeGh({ [PRS_PATH]: NOT_FOUND, [REF_PATH]: ok({}) });
    expect(() => bump({ runGhWithTagToken: unreadableGh.run, runGit: fakeGit().run })).toThrow(
      "listing pull requests for the version-bump branch failed",
    );
  });
});
