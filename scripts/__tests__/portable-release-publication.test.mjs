import { describe, expect, it } from "vitest";

import {
  createdDraftId,
  immutableReleaseRepairFailure,
  openPortableRelease,
  publishVerifiedPortableRelease,
  refuseIncompletePublishedRelease,
  releaseSnapshotPath,
  releaseTagAtHeadFailure,
  remoteDigestFailures,
  resumableDraftFailure,
  uploadIntoDraft,
} from "../lib/portable-release-publication.mjs";

// v1.0.0 was lost on 2026-09-14: the publisher created the release as published and then uploaded
// its downloads, which GitHub immutable releases refuse. These are the decisions of the draft-first
// publication that replaced it.

const TAG = "v1.0.1";
const REPO = "oscharko-dev/Keiko";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const SHA = "c".repeat(64);

function answer(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: "" };
}

describe("createdDraftId", () => {
  it("takes the id from GitHub's answer to the create call", () => {
    expect(createdDraftId({ draft: true, id: 388722230, tag_name: TAG }, TAG)).toStrictEqual({
      id: 388722230,
    });
  });

  it.each([
    ["an unparseable answer", undefined, "did not answer"],
    ["an answer for another tag", { draft: true, id: 1, tag_name: "v1.0.2" }, "did not answer"],
    ["a published release", { draft: false, id: 1, tag_name: TAG }, "did not answer"],
    ["an invalid id", { draft: true, id: "2", tag_name: TAG }, "no valid id"],
  ])("refuses %s", (_label, release, message) => {
    expect(createdDraftId(release, TAG).failure).toContain(message);
  });
});

describe("resumableDraftFailure", () => {
  const MANIFEST = "keiko-portable-evaluation-manifest.json";

  it("resumes an interrupted draft of this lane", () => {
    expect(
      resumableDraftFailure(
        { assets: [{ name: "keiko-linux-x64.zip" }], databaseId: 7, isDraft: true },
        TAG,
        MANIFEST,
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "a draft carrying the evaluation manifest",
      { assets: [{ name: MANIFEST }], databaseId: 7, isDraft: true },
      "evaluation lane's manifest",
    ],
    ["a draft without a valid id", { assets: [], databaseId: 0, isDraft: true }, "no valid id"],
  ])("refuses %s", (_label, view, message) => {
    expect(resumableDraftFailure(view, TAG, MANIFEST)).toContain(message);
  });
});

describe("remoteDigestFailures", () => {
  const expected = [{ assetName: "keiko-linux-x64.zip", expectedSha256: SHA }];

  it("accepts an asset whose GitHub digest is the verified SHA-256", () => {
    expect(
      remoteDigestFailures([{ digest: `sha256:${SHA}`, name: "keiko-linux-x64.zip" }], expected),
    ).toStrictEqual([]);
  });

  it.each([
    ["a missing asset", []],
    ["an asset without a digest", [{ name: "keiko-linux-x64.zip" }]],
    ["a digest of another algorithm", [{ digest: `sha512:${SHA}`, name: "keiko-linux-x64.zip" }]],
    ["a malformed listing", undefined],
  ])("reports %s as having no digest", (_label, remote) => {
    expect(remoteDigestFailures(remote, expected)).toStrictEqual([
      "keiko-linux-x64.zip has no SHA-256 digest on GitHub.",
    ]);
  });

  it("reports different bytes", () => {
    expect(
      remoteDigestFailures(
        [{ digest: `sha256:${"d".repeat(64)}`, name: "keiko-linux-x64.zip" }],
        expected,
      ),
    ).toStrictEqual(["keiko-linux-x64.zip on GitHub does not carry the bytes this run verified."]);
  });
});

describe("immutableReleaseRepairFailure", () => {
  it("tells the operator to publish the next patch version", () => {
    expect(immutableReleaseRepairFailure(TAG, "lacks keiko-linux-x64.zip")).toBe(
      `GitHub release ${TAG} is already published and lacks keiko-linux-x64.zip; an immutable release cannot be repaired, so publish the next patch version instead.`,
    );
  });
});

describe("releaseTagAtHeadFailure", () => {
  function check(routes) {
    const runGh = (args) => {
      const route = routes[args.at(-1)];
      if (route === undefined) throw new Error(`unexpected gh call: ${args.join(" ")}`);
      return route;
    };
    return releaseTagAtHeadFailure({ head: HEAD, repository: REPO, runGh, tag: TAG });
  }
  const REF = `repos/${REPO}/git/ref/tags/${TAG}`;
  const ANNOTATED = `repos/${REPO}/git/tags/${"e".repeat(40)}`;

  it("passes a lightweight tag at the checked-out commit", () => {
    expect(check({ [REF]: answer({ object: { sha: HEAD, type: "commit" } }) })).toBeUndefined();
  });

  it("peels an annotated tag", () => {
    expect(
      check({
        [ANNOTATED]: answer({ object: { sha: HEAD, type: "commit" } }),
        [REF]: answer({ object: { sha: "e".repeat(40), type: "tag" } }),
      }),
    ).toBeUndefined();
  });

  it("refuses a tag that points at another commit", () => {
    expect(check({ [REF]: answer({ object: { sha: OTHER, type: "commit" } }) })).toContain(
      `points at ${OTHER} on GitHub, not at the checked-out ${HEAD}`,
    );
  });

  it.each([
    [
      "a missing tag",
      { [REF]: { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" } },
      "does not exist on GitHub",
    ],
    [
      "an unreadable tag",
      { [REF]: { status: 1, stdout: "", stderr: "HTTP 502" } },
      "could not be read",
    ],
    [
      "a tag body that is not JSON",
      { [REF]: { status: 0, stdout: "<html>", stderr: "" } },
      "could not be read",
    ],
    [
      "a tag on a tree",
      { [REF]: answer({ object: { sha: OTHER, type: "tree" } }) },
      "does not resolve to a commit",
    ],
    [
      "an annotated tag that cannot be read",
      {
        [ANNOTATED]: { status: 1, stdout: "", stderr: "HTTP 502" },
        [REF]: answer({ object: { sha: "e".repeat(40), type: "tag" } }),
      },
      "does not resolve to a commit",
    ],
    [
      "an annotated tag on another tag",
      {
        [ANNOTATED]: answer({ object: { sha: HEAD, type: "tag" } }),
        [REF]: answer({ object: { sha: "e".repeat(40), type: "tag" } }),
      },
      "does not resolve to a commit",
    ],
  ])("refuses %s", (_label, routes, message) => {
    expect(check(routes)).toContain(message);
  });
});

function fakePublisher({
  view = { status: 1, stdout: "", stderr: "release not found" },
  listing,
  publicAssets = [],
} = {}) {
  const calls = [];
  const logs = [];
  const publisher = {
    assertTagAtHead: (tag) => calls.push(["assertTagAtHead", tag]),
    evaluationManifestAssetName: "keiko-portable-evaluation-manifest.json",
    fail: (message) => {
      throw new Error(message);
    },
    gh: (args) => {
      calls.push(["gh", ...args]);
      return view;
    },
    log: (message) => logs.push(message),
    refuseEvaluationOwnedRelease: (_result, tag) =>
      calls.push(["refuseEvaluationOwnedRelease", tag]),
    runGh: (args) => {
      calls.push(["runGh", ...args]);
      return args[0] === "api" ? listing : { status: 0, stdout: "", stderr: "" };
    },
    snapshot: (releaseInfo) => {
      calls.push(["snapshot", releaseInfo.tag, releaseInfo.id]);
      return { assets: publicAssets, createdAt: "2026-09-14T12:00:00Z", id: 7 };
    },
    verifyAssets: (assets, expected) =>
      calls.push(["verifyAssets", assets.length, expected.length]),
  };
  return { calls, logs, publisher };
}

const OPEN = {
  head: HEAD,
  latest: true,
  notes: "notes",
  prerelease: false,
  repo: REPO,
  tag: TAG,
  title: "Keiko 1.0.1",
};
const CREATED = answer({ draft: true, id: 42, tag_name: TAG });

describe("openPortableRelease", () => {
  it("creates a draft after checking the tag, and returns the id GitHub answered with", () => {
    const { calls, logs, publisher } = fakePublisher({ listing: CREATED });
    expect(openPortableRelease(publisher, OPEN)).toStrictEqual({
      draft: true,
      id: 42,
      latestArgs: ["--latest"],
      repo: REPO,
      tag: TAG,
    });
    expect(calls[0]).toStrictEqual(["assertTagAtHead", TAG]);
    expect(calls).toContainEqual([
      "runGh",
      "api",
      "--method",
      "POST",
      `repos/${REPO}/releases`,
      "-f",
      `tag_name=${TAG}`,
      "-f",
      `target_commitish=${HEAD}`,
      "-f",
      "name=Keiko 1.0.1",
      "-f",
      "body=notes",
      "-F",
      "draft=true",
      "-F",
      "prerelease=false",
    ]);
    // No second read: the listing lags behind the create (v1.0.1, 2026-09-14: "found 0").
    expect(calls.filter((call) => call[0] === "runGh")).toHaveLength(1);
    expect(logs).toStrictEqual([`creating draft GitHub release ${TAG}.`]);
  });

  it("creates a prerelease draft that never claims Latest", () => {
    const { calls, publisher } = fakePublisher({ listing: CREATED });
    expect(openPortableRelease(publisher, { ...OPEN, prerelease: true }).latestArgs).toStrictEqual([
      "--latest=false",
    ]);
    expect(calls.find((call) => call[3] === "POST")).toContain("prerelease=true");
  });

  it("resumes the draft an interrupted publish left, by its id, without creating another", () => {
    const { calls, logs, publisher } = fakePublisher({
      view: answer({ assets: [], databaseId: 388722230, isDraft: true, name: "Keiko 1.0.1" }),
    });
    expect(openPortableRelease(publisher, OPEN)).toStrictEqual({
      draft: true,
      id: 388722230,
      latestArgs: ["--latest"],
      repo: REPO,
      tag: TAG,
    });
    expect(calls.some((call) => call[0] === "runGh")).toBe(false);
    expect(calls).not.toContainEqual(["refuseEvaluationOwnedRelease", TAG]);
    expect(logs).toStrictEqual([
      `resuming draft GitHub release ${TAG} (id 388722230) left by an interrupted publish.`,
    ]);
  });

  it("refuses to resume a draft under this title that carries the evaluation manifest", () => {
    const { publisher } = fakePublisher({
      view: answer({
        assets: [{ name: "keiko-portable-evaluation-manifest.json" }],
        databaseId: 7,
        isDraft: true,
        name: "Keiko 1.0.1",
      }),
    });
    expect(() => openPortableRelease(publisher, OPEN)).toThrow("evaluation lane's manifest");
  });

  it("leaves a draft under the evaluation lane's title to that lane's refusal", () => {
    const { calls, publisher } = fakePublisher({
      view: answer({ assets: [], databaseId: 7, isDraft: true, name: "Keiko 1.0.1 (v1.0.1)" }),
    });
    openPortableRelease(publisher, OPEN);
    expect(calls).toContainEqual(["refuseEvaluationOwnedRelease", TAG]);
    expect(calls.some((call) => call[0] === "runGh")).toBe(false);
  });

  it("verifies an already published release instead of creating one", () => {
    const { calls, logs, publisher } = fakePublisher({
      view: answer({ assets: [], isDraft: false }),
    });
    expect(openPortableRelease(publisher, { ...OPEN, latest: false })).toStrictEqual({
      published: true,
      repo: REPO,
      tag: TAG,
    });
    expect(calls).toContainEqual(["refuseEvaluationOwnedRelease", TAG]);
    expect(calls.some((call) => call[2] === "create")).toBe(false);
    expect(logs).toStrictEqual([`GitHub release ${TAG} is already published; verifying it.`]);
  });

  it.each([
    ["an answer that is not JSON", { status: 0, stdout: "<html>", stderr: "" }, "did not answer"],
    [
      "an answer for another tag",
      answer({ draft: true, id: 1, tag_name: "v1.0.2" }),
      "did not answer",
    ],
    ["an answer without a valid id", answer({ draft: true, tag_name: TAG }), "no valid id"],
  ])("fails for %s", (_label, listing, message) => {
    const { publisher } = fakePublisher({ listing });
    expect(() => openPortableRelease(publisher, OPEN)).toThrow(message);
  });
});

describe("uploadIntoDraft", () => {
  it("uploads into a draft with --clobber", () => {
    const { calls, publisher } = fakePublisher();
    uploadIntoDraft(publisher, { draft: true, repo: REPO, tag: TAG }, ["a.zip", "b.zip"]);
    expect(calls).toStrictEqual([
      ["runGh", "release", "upload", TAG, "--repo", REPO, "--clobber", "a.zip", "b.zip"],
    ]);
  });

  it("never uploads into a published release", () => {
    const { calls, publisher } = fakePublisher();
    uploadIntoDraft(publisher, { published: true, repo: REPO, tag: TAG }, ["a.zip"]);
    expect(calls).toStrictEqual([]);
  });
});

describe("refuseIncompletePublishedRelease", () => {
  const expected = [{ assetName: "keiko-linux-x64.zip", expectedSha256: SHA }];
  const published = { published: true, repo: REPO, tag: TAG };

  it("ignores a draft, which this run completes itself", () => {
    const { publisher } = fakePublisher();
    expect(() =>
      refuseIncompletePublishedRelease(publisher, { draft: true }, [], expected),
    ).not.toThrow();
  });

  it("accepts a published release carrying exactly the verified bytes", () => {
    const { publisher } = fakePublisher();
    const remote = [{ digest: `sha256:${SHA}`, name: "keiko-linux-x64.zip" }];
    expect(() =>
      refuseIncompletePublishedRelease(publisher, published, remote, expected),
    ).not.toThrow();
  });

  it("refuses a published release that lacks a download", () => {
    const { publisher } = fakePublisher();
    expect(() =>
      refuseIncompletePublishedRelease(publisher, published, undefined, expected),
    ).toThrow(immutableReleaseRepairFailure(TAG, "lacks keiko-linux-x64.zip"));
  });

  it("refuses a published release that carries other bytes", () => {
    const { publisher } = fakePublisher();
    const remote = [{ digest: `sha256:${"d".repeat(64)}`, name: "keiko-linux-x64.zip" }];
    expect(() => refuseIncompletePublishedRelease(publisher, published, remote, expected)).toThrow(
      "differs:",
    );
  });
});

describe("publishVerifiedPortableRelease", () => {
  const expected = [{ assetName: "keiko-linux-x64.zip", expectedSha256: SHA }];
  const verified = [{ digest: `sha256:${SHA}`, name: "keiko-linux-x64.zip" }];

  it("publishes a verified draft as the last GitHub step and returns the public assets", () => {
    const { calls, logs, publisher } = fakePublisher({ publicAssets: verified });
    const releaseInfo = { draft: true, id: 42, latestArgs: ["--latest"], repo: REPO, tag: TAG };
    expect(
      publishVerifiedPortableRelease(publisher, releaseInfo, verified, expected),
    ).toStrictEqual(verified);
    expect(calls).toStrictEqual([
      ["verifyAssets", 1, 1],
      ["assertTagAtHead", TAG],
      [
        "runGh",
        "release",
        "edit",
        TAG,
        "--repo",
        REPO,
        "--verify-tag",
        "--draft=false",
        "--latest",
      ],
      ["snapshot", TAG, undefined],
      ["verifyAssets", 1, 1],
    ]);
    expect(logs).toStrictEqual([`published GitHub release ${TAG}.`]);
  });

  it("only verifies a release that is already published", () => {
    const { calls, publisher } = fakePublisher();
    expect(
      publishVerifiedPortableRelease(
        publisher,
        { published: true, repo: REPO, tag: TAG },
        verified,
        expected,
      ),
    ).toStrictEqual(verified);
    expect(calls).toStrictEqual([["verifyAssets", 1, 1]]);
  });

  it("refuses to publish a draft whose digests do not match", () => {
    const { calls, publisher } = fakePublisher();
    const releaseInfo = { draft: true, id: 42, latestArgs: ["--latest"], repo: REPO, tag: TAG };
    expect(() =>
      publishVerifiedPortableRelease(
        publisher,
        releaseInfo,
        [{ name: "keiko-linux-x64.zip" }],
        expected,
      ),
    ).toThrow("GitHub Release portable asset digests failed");
    expect(calls.some((call) => call[2] === "edit")).toBe(false);
  });
});

describe("releaseSnapshotPath", () => {
  it("reads this run's draft by id and any other release by tag", () => {
    expect(releaseSnapshotPath({ id: 42, repo: REPO, tag: TAG })).toBe(`repos/${REPO}/releases/42`);
    expect(releaseSnapshotPath({ repo: REPO, tag: TAG })).toBe(
      `repos/${REPO}/releases/tags/${TAG}`,
    );
  });
});
