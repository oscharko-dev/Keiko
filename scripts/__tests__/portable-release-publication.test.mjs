import { describe, expect, it } from "vitest";

import {
  draftReleaseId,
  immutableReleaseRepairFailure,
  releaseTagAtHeadFailure,
  remoteDigestFailures,
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

describe("draftReleaseId", () => {
  it("finds the one draft for the tag among published releases", () => {
    const releases = [
      { draft: false, id: 1, tag_name: TAG },
      { draft: true, id: 2, tag_name: TAG },
      { draft: true, id: 3, tag_name: "v1.0.2" },
    ];
    expect(draftReleaseId(releases, TAG)).toStrictEqual({ id: 2 });
  });

  it.each([
    ["a malformed listing", {}, "listing is malformed"],
    ["no draft", [{ draft: false, id: 1, tag_name: TAG }], "found 0"],
    [
      "two drafts",
      [
        { draft: true, id: 1, tag_name: TAG },
        { draft: true, id: 2, tag_name: TAG },
      ],
      "found 2",
    ],
    ["an invalid id", [{ draft: true, id: "2", tag_name: TAG }], "no valid id"],
  ])("refuses %s", (_label, releases, message) => {
    expect(draftReleaseId(releases, TAG).failure).toContain(message);
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
