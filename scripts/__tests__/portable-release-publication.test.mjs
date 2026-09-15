import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  checkPublishedManifestBinding,
  checkRemotePortableAsset,
  createdDraftId,
  downloadPortableReleaseAsset,
  immutableReleaseRepairFailure,
  manifestBindingsFromAssets,
  nonManifestEvidenceExpected,
  openPortableRelease,
  publishVerifiedPortableRelease,
  refuseIncompletePublishedRelease,
  releaseSnapshotPath,
  releaseTagAtHeadFailure,
  remoteDigestFailures,
  resumableDraftFailure,
  uploadIntoDraft,
  verifyPublishedPortableEvidence,
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
    ["a draft without an asset list", { databaseId: 7, isDraft: true }, "invalid asset listing"],
    [
      "an asset list that is not a list",
      { assets: {}, databaseId: 7, isDraft: true },
      "invalid asset listing",
    ],
    [
      "an asset without a name",
      { assets: [{}], databaseId: 7, isDraft: true },
      "invalid asset listing",
    ],
    [
      "an asset with a hostile name",
      { assets: [{ name: 42 }], databaseId: 7, isDraft: true },
      "invalid asset listing",
    ],
    ["a null asset", { assets: [null], databaseId: 7, isDraft: true }, "invalid asset listing"],
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

describe("verifyPublishedPortableEvidence", () => {
  // A rerun of the publish job on a published release cannot reproduce the released
  // portable-manifest bytes when the draft was signed at one instant and the published release now
  // carries a different `created_at` (v1.0.1's draft was signed 2026-09-14T20:38:54Z; the published
  // release carries `created_at` 2026-09-14T23:19:18Z). Verify the released bytes by their trusted
  // Ed25519 signature and their commit/tag binding instead of by a byte match against a rebuild.
  const RELEASE_INFO = { published: true, repo: REPO, tag: TAG };
  const MANIFEST_ASSET_NAME = "linux-x64-portable-manifest.json";
  const MANIFEST_BYTES = '{"artifact":{"platformTarget":"linux-x64"}}\n';
  const MANIFEST_SHA = "e".repeat(64);
  const HEAD_COMMIT = "a".repeat(40);
  const REMOTE_ASSETS = [{ digest: `sha256:${MANIFEST_SHA}`, name: MANIFEST_ASSET_NAME }];
  const BINDING = {
    assetName: MANIFEST_ASSET_NAME,
    commitSha: HEAD_COMMIT,
    releaseTag: TAG,
  };

  function fakeEvidencePublisher(overrides = {}) {
    const downloadResult = Object.prototype.hasOwnProperty.call(overrides, "downloadResult")
      ? overrides.downloadResult
      : { text: MANIFEST_BYTES, sha256: MANIFEST_SHA };
    const { verifyResult } = overrides;
    const calls = [];
    const publisher = {
      downloadReleaseAsset: (releaseInfo, assetName) => {
        calls.push(["downloadReleaseAsset", releaseInfo.tag, assetName]);
        return downloadResult;
      },
      fail: (message) => {
        throw new Error(message);
      },
      verifyPublishedManifestBinding: (manifest, expected) => {
        calls.push(["verifyPublishedManifestBinding", manifest, expected]);
        return verifyResult;
      },
    };
    return { calls, publisher };
  }

  it("accepts a released manifest whose signature and commit/tag binding verify", () => {
    const { calls, publisher } = fakeEvidencePublisher();
    expect(() =>
      verifyPublishedPortableEvidence(publisher, RELEASE_INFO, REMOTE_ASSETS, [BINDING]),
    ).not.toThrow();
    expect(calls).toStrictEqual([
      ["downloadReleaseAsset", TAG, MANIFEST_ASSET_NAME],
      ["verifyPublishedManifestBinding", { artifact: { platformTarget: "linux-x64" } }, BINDING],
    ]);
  });

  it.each([
    ["a missing digest", [{ name: MANIFEST_ASSET_NAME }], "has no SHA-256 digest"],
    ["a missing asset", [], "has no SHA-256 digest"],
    [
      "a malformed digest",
      [{ digest: `sha1:${MANIFEST_SHA}`, name: MANIFEST_ASSET_NAME }],
      "has no SHA-256 digest",
    ],
  ])("refuses %s", (_label, remote, message) => {
    const { publisher } = fakeEvidencePublisher();
    expect(() =>
      verifyPublishedPortableEvidence(publisher, RELEASE_INFO, remote, [BINDING]),
    ).toThrow(message);
  });

  it("refuses a manifest whose download bytes do not match the digest GitHub reports", () => {
    const { publisher } = fakeEvidencePublisher({
      downloadResult: { text: MANIFEST_BYTES, sha256: "f".repeat(64) },
    });
    expect(() =>
      verifyPublishedPortableEvidence(publisher, RELEASE_INFO, REMOTE_ASSETS, [BINDING]),
    ).toThrow("bytes do not match the digest GitHub reports");
  });

  it("refuses a manifest whose signature verification failed", () => {
    const { publisher } = fakeEvidencePublisher({
      verifyResult: "signature invalid (signature-invalid)",
    });
    expect(() =>
      verifyPublishedPortableEvidence(publisher, RELEASE_INFO, REMOTE_ASSETS, [BINDING]),
    ).toThrow("signature invalid");
  });

  it("refuses a manifest whose commit binding does not match the checked-out HEAD", () => {
    const { publisher } = fakeEvidencePublisher({
      verifyResult: "commitSha does not match the checked-out HEAD",
    });
    expect(() =>
      verifyPublishedPortableEvidence(publisher, RELEASE_INFO, REMOTE_ASSETS, [BINDING]),
    ).toThrow("commitSha does not match");
  });

  it("refuses a download that could not be read from GitHub", () => {
    const { publisher } = fakeEvidencePublisher({ downloadResult: undefined });
    expect(() =>
      verifyPublishedPortableEvidence(publisher, RELEASE_INFO, REMOTE_ASSETS, [BINDING]),
    ).toThrow("could not be downloaded");
  });

  it("refuses a manifest that is not valid JSON", () => {
    const { publisher } = fakeEvidencePublisher({
      downloadResult: { text: "<html/>", sha256: MANIFEST_SHA },
    });
    expect(() =>
      verifyPublishedPortableEvidence(publisher, RELEASE_INFO, REMOTE_ASSETS, [BINDING]),
    ).toThrow("is not valid JSON");
  });

  it("aggregates every failure across the four portable targets", () => {
    const bindings = [
      { assetName: "linux-x64-portable-manifest.json", commitSha: HEAD_COMMIT, releaseTag: TAG },
      { assetName: "macos-arm64-portable-manifest.json", commitSha: HEAD_COMMIT, releaseTag: TAG },
    ];
    const remote = [
      { digest: `sha256:${MANIFEST_SHA}`, name: bindings[0].assetName },
      { digest: `sha256:${MANIFEST_SHA}`, name: bindings[1].assetName },
    ];
    const { publisher } = fakeEvidencePublisher({
      verifyResult: "commitSha does not match the checked-out HEAD",
    });
    let error;
    try {
      verifyPublishedPortableEvidence(publisher, RELEASE_INFO, remote, bindings);
    } catch (thrown) {
      error = thrown;
    }
    expect(error?.message).toContain(bindings[0].assetName);
    expect(error?.message).toContain(bindings[1].assetName);
  });
});

describe("downloadPortableReleaseAsset", () => {
  const RELEASE_INFO = { published: true, repo: REPO, tag: TAG };
  const ASSET = "linux-x64-portable-manifest.json";

  function fakeSeams({
    ghResult,
    exists = true,
    fileBytes = Buffer.from("{}\n"),
    hex = "e".repeat(64),
  } = {}) {
    const calls = [];
    const seams = {
      mkdtemp: (prefix) => {
        calls.push(["mkdtemp", prefix]);
        return `/tmp/${prefix}xyz`;
      },
      runGh: (args) => {
        calls.push(["runGh", ...args]);
        return ghResult ?? { status: 0, stdout: "", stderr: "" };
      },
      pathJoin: (...parts) => parts.join("/"),
      exists: (path) => {
        calls.push(["exists", path]);
        return exists;
      },
      readFile: (path) => {
        calls.push(["readFile", path]);
        return fileBytes;
      },
      sha256: (bytes) => {
        calls.push(["sha256", bytes.length]);
        return hex;
      },
      toUtf8: (bytes) => bytes.toString("utf8"),
      rm: (path, opts) => calls.push(["rm", path, opts]),
    };
    return { calls, seams };
  }

  it("downloads a released asset and returns its text with the computed sha", () => {
    const { calls, seams } = fakeSeams();
    const result = downloadPortableReleaseAsset(seams, RELEASE_INFO, ASSET);
    expect(result).toStrictEqual({ sha256: "e".repeat(64), text: "{}\n" });
    expect(
      calls.some((c) => c[0] === "runGh" && c.includes("--pattern") && c.includes(ASSET)),
    ).toBe(true);
    expect(calls.at(-1)).toStrictEqual([
      "rm",
      "/tmp/keiko-portable-verify-xyz",
      { force: true, recursive: true },
    ]);
  });

  it("returns undefined when gh release download exits non-zero", () => {
    const { seams } = fakeSeams({ ghResult: { status: 1, stdout: "", stderr: "gh: 404" } });
    expect(downloadPortableReleaseAsset(seams, RELEASE_INFO, ASSET)).toBeUndefined();
  });

  it("returns undefined when gh release download reported an error but no exit", () => {
    const { seams } = fakeSeams({ ghResult: { status: 0, error: new Error("ENOENT") } });
    expect(downloadPortableReleaseAsset(seams, RELEASE_INFO, ASSET)).toBeUndefined();
  });

  it("returns undefined when gh did not write the asset where it should be", () => {
    const { seams } = fakeSeams({ exists: false });
    expect(downloadPortableReleaseAsset(seams, RELEASE_INFO, ASSET)).toBeUndefined();
  });

  it("always removes the temporary directory, even after a failure inside runGh", () => {
    const { calls, seams } = fakeSeams({ ghResult: { status: 1, stderr: "boom" } });
    downloadPortableReleaseAsset(seams, RELEASE_INFO, ASSET);
    expect(calls.some((c) => c[0] === "rm")).toBe(true);
  });
});

describe("checkPublishedManifestBinding", () => {
  const EXPECTED = { commitSha: "a".repeat(40), releaseTag: TAG };
  const OK_MANIFEST = {
    release: { commitSha: EXPECTED.commitSha, releaseTag: TAG },
    provenance: { sourceCommitSha: EXPECTED.commitSha },
  };
  const TRUSTED_KEYS = [];
  const NOW = new Date("2026-09-15T00:00:00Z");

  function seams(verification = { ok: true }) {
    return {
      verifyReleaseTrust: () => verification,
      now: NOW,
      trustedKeys: TRUSTED_KEYS,
    };
  }

  it("returns undefined when signature and every binding match", () => {
    expect(checkPublishedManifestBinding(OK_MANIFEST, EXPECTED, seams())).toBeUndefined();
  });

  it("reports a rejected signature", () => {
    expect(
      checkPublishedManifestBinding(
        OK_MANIFEST,
        EXPECTED,
        seams({ ok: false, reason: "signature-invalid" }),
      ),
    ).toContain("release-trust signature invalid (signature-invalid)");
  });

  it("reports a commit that does not match the checked-out HEAD", () => {
    const manifest = {
      ...OK_MANIFEST,
      release: { ...OK_MANIFEST.release, commitSha: "b".repeat(40) },
    };
    expect(checkPublishedManifestBinding(manifest, EXPECTED, seams())).toContain(
      "release.commitSha does not match",
    );
  });

  it("reports a release tag that does not match", () => {
    const manifest = { ...OK_MANIFEST, release: { ...OK_MANIFEST.release, releaseTag: "v0.0.1" } };
    expect(checkPublishedManifestBinding(manifest, EXPECTED, seams())).toContain(
      `release.releaseTag does not match ${TAG}`,
    );
  });

  it("reports a provenance commit that does not match the checked-out HEAD", () => {
    const manifest = {
      ...OK_MANIFEST,
      provenance: { sourceCommitSha: "b".repeat(40) },
    };
    expect(checkPublishedManifestBinding(manifest, EXPECTED, seams())).toContain(
      "provenance.sourceCommitSha does not match",
    );
  });
});

describe("nonManifestEvidenceExpected", () => {
  const seams = {
    sha256File: (path) => `sha-of-${path}`,
    statFile: (path) => ({ size: path.length }),
  };

  it("keeps every non-manifest evidence file with its byte digest and size", () => {
    const assets = [
      {
        evidenceFiles: [
          {
            assetName: "linux-x64-portable-manifest.json",
            relativePath: "manifest/portable-manifest.json",
            sourcePath: "/stage/manifest/portable-manifest.json",
          },
          {
            assetName: "linux-x64-SHA256SUMS.txt",
            relativePath: "evidence/SHA256SUMS.txt",
            sourcePath: "/stage/evidence/SHA256SUMS.txt",
          },
          {
            assetName: "linux-x64-sbom.cdx.json",
            relativePath: "evidence/sbom.cdx.json",
            sourcePath: "/stage/evidence/sbom.cdx.json",
          },
        ],
      },
    ];
    expect(nonManifestEvidenceExpected(assets, seams)).toStrictEqual([
      {
        assetName: "linux-x64-SHA256SUMS.txt",
        expectedSha256: "sha-of-/stage/evidence/SHA256SUMS.txt",
        expectedSize: "/stage/evidence/SHA256SUMS.txt".length,
        firstClassArchive: false,
      },
      {
        assetName: "linux-x64-sbom.cdx.json",
        expectedSha256: "sha-of-/stage/evidence/sbom.cdx.json",
        expectedSize: "/stage/evidence/sbom.cdx.json".length,
        firstClassArchive: false,
      },
    ]);
  });

  it("returns an empty list when every evidence file is the portable manifest itself", () => {
    const assets = [
      {
        evidenceFiles: [
          {
            assetName: "linux-x64-portable-manifest.json",
            relativePath: "manifest/portable-manifest.json",
            sourcePath: "/stage/manifest/portable-manifest.json",
          },
        ],
      },
    ];
    expect(nonManifestEvidenceExpected(assets, seams)).toStrictEqual([]);
  });
});

describe("manifestBindingsFromAssets", () => {
  it("returns one binding per portable target using its platformTarget for the asset name", () => {
    const head = "a".repeat(40);
    const assets = [{ platformTarget: "linux-x64" }, { platformTarget: "macos-arm64" }];
    expect(manifestBindingsFromAssets(assets, head, TAG)).toStrictEqual([
      { assetName: "linux-x64-portable-manifest.json", commitSha: head, releaseTag: TAG },
      { assetName: "macos-arm64-portable-manifest.json", commitSha: head, releaseTag: TAG },
    ]);
  });
});

describe("checkRemotePortableAsset", () => {
  // The rerun path relies on this digest check: without it a same-size asset with different bytes
  // would pass, because no download smoke runs after a published-release rerun (CodeRabbit
  // finding, 2026-09-15). Also proves the original invariants (id, size, browser_download_url,
  // asset missing) still fail closed.
  const EXPECTED = {
    assetName: "keiko-linux-x64.zip",
    expectedSize: 1024,
    expectedSha256: "c".repeat(64),
  };
  const REMOTE = {
    id: 42,
    size: EXPECTED.expectedSize,
    digest: `sha256:${EXPECTED.expectedSha256}`,
    browser_download_url:
      "https://github.com/oscharko-dev/Keiko/releases/download/v1.0.1/keiko-linux-x64.zip",
  };
  const seams = {
    isRecord: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
    validBrowserDownloadUrl: (value) => typeof value === "string" && value.startsWith("https://"),
  };

  it("accepts a released asset whose id, size, digest and download url match", () => {
    expect(checkRemotePortableAsset(REMOTE, EXPECTED, seams)).toStrictEqual([]);
  });

  it("refuses an asset that is not on the release at all", () => {
    expect(checkRemotePortableAsset(undefined, EXPECTED, seams)).toStrictEqual([
      "keiko-linux-x64.zip is missing from the GitHub Release.",
    ]);
  });

  it("refuses an asset with no non-zero asset id", () => {
    const failures = checkRemotePortableAsset({ ...REMOTE, id: 0 }, EXPECTED, seams);
    expect(failures.some((f) => f.includes("must have a non-zero GitHub asset id"))).toBe(true);
  });

  it("refuses an asset whose size does not match the reviewed local asset", () => {
    const failures = checkRemotePortableAsset({ ...REMOTE, size: 2048 }, EXPECTED, seams);
    expect(failures.some((f) => f.includes("size does not match"))).toBe(true);
  });

  it("refuses an asset whose SHA-256 digest does not match the reviewed local asset", () => {
    const failures = checkRemotePortableAsset(
      { ...REMOTE, digest: `sha256:${"d".repeat(64)}` },
      EXPECTED,
      seams,
    );
    expect(failures.some((f) => f.includes("SHA-256 digest on GitHub does not match"))).toBe(true);
  });

  it("refuses an asset carrying no digest, even when its size matches", () => {
    const { digest: _digest, ...withoutDigest } = REMOTE;
    const failures = checkRemotePortableAsset(withoutDigest, EXPECTED, seams);
    expect(failures.some((f) => f.includes("SHA-256 digest on GitHub does not match"))).toBe(true);
    expect(failures.some((f) => f.includes("size does not match"))).toBe(false);
  });

  it("refuses an asset with a non-string digest", () => {
    const failures = checkRemotePortableAsset({ ...REMOTE, digest: 42 }, EXPECTED, seams);
    expect(failures.some((f) => f.includes("SHA-256 digest on GitHub does not match"))).toBe(true);
  });

  it("refuses an asset without a browser_download_url", () => {
    const failures = checkRemotePortableAsset(
      { ...REMOTE, browser_download_url: "" },
      EXPECTED,
      seams,
    );
    expect(failures.some((f) => f.includes("HTTPS browser_download_url"))).toBe(true);
  });
});
