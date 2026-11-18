import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sha256 } from "../lib/digest.mjs";

import {
  makeDownloadSeams,
  makePublishedPortableSeams,
  runVerifyPublishedPortableAssets,
} from "../lib/portable-release-publish-helpers.mjs";

// These wire release-publish.mjs's concrete IO/crypto/gh primitives to the pure verification helpers
// in scripts/lib/portable-release-publication.mjs. release-publish.mjs is a top-level script no test
// can import, so the wiring lives here where each function is directly reachable.

const TAG = "v1.0.1";
const REPO = "oscharko-dev/Keiko";
const HEAD = "a".repeat(40);

describe("makeDownloadSeams", () => {
  it("exposes the exact seam names downloadPortableReleaseAsset needs", () => {
    const seams = makeDownloadSeams(() => ({ status: 0, stdout: "", stderr: "" }));
    for (const name of [
      "mkdtemp",
      "runGh",
      "pathJoin",
      "exists",
      "readFile",
      "sha256",
      "toUtf8",
      "rm",
    ]) {
      expect(typeof seams[name]).toBe("function");
    }
    // sha256 is the shared crypto seam; a well-known constant proves it is really SHA-256.
    expect(seams.sha256(Buffer.from("hello"))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("forwards the runGh seam so the caller can drive gh through its own subprocess seam", () => {
    const calls = [];
    const seams = makeDownloadSeams((args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    });
    seams.runGh(["release", "download", TAG]);
    expect(calls).toStrictEqual([["release", "download", TAG]]);
  });
});

describe("makeDownloadSeams bounds (PR #4464)", () => {
  it("gives the gh download a subprocess deadline", () => {
    const seen = [];
    const seams = makeDownloadSeams((_args, options) => {
      seen.push(options);
      return { status: 0, stdout: "", stderr: "" };
    });
    seams.runGh(["release", "download"]);
    expect(seen[0]?.timeout).toBeGreaterThan(0);
    expect(seen[0]?.timeout).toBeLessThan(10 * 60_000);
  });

  it("refuses a manifest file larger than the updater's limit before reading it", () => {
    const asset = "linux-x64-portable-manifest.json";
    const runGh = (args) => {
      const outDir = args[args.indexOf("--dir") + 1];
      writeFileSync(join(outDir, asset), Buffer.alloc(1_048_576 + 1, 0x20));
      return { status: 0, stdout: "", stderr: "" };
    };
    const seams = makePublishedPortableSeams({
      runGh,
      verifyReleaseTrust: () => ({ ok: true }),
      trustedKeys: [],
    });
    expect(
      seams.downloadReleaseAsset({ published: true, repo: REPO, tag: TAG }, asset),
    ).toBeUndefined();
  });
});

describe("published rerun reconciles signed ids (PR #4464)", () => {
  const manifestName = "linux-x64-portable-manifest.json";
  const smoked = [];
  function run(live, { setup = true } = {}) {
    smoked.length = 0;
    const manifest = {
      artifact: { assetId: 11 },
      provenance: { sourceCommitSha: HEAD },
      release: { commitSha: HEAD, releaseId: 10, releaseTag: TAG },
      releaseImpact: {
        reviewedBinding: { assetId: 11, releaseId: 10, setupAsset: { assetId: 12 } },
      },
    };
    const text = JSON.stringify(manifest);
    const runGh = (args) => {
      writeFileSync(join(args[args.indexOf("--dir") + 1], manifestName), text);
      return { status: 0, stdout: "", stderr: "" };
    };
    const seams = makePublishedPortableSeams({
      runGh,
      verifyReleaseTrust: () => ({ ok: true }),
      trustedKeys: [],
    });
    const digest = `sha256:${sha256(Buffer.from(text))}`;
    runVerifyPublishedPortableAssets({
      publisher: {
        ...seams,
        fail: (message) => {
          throw new Error(message);
        },
      },
      releaseInfo: { published: true, repo: REPO, tag: TAG },
      assets: [
        {
          archiveAssetName: "keiko-linux-x64.zip",
          platformTarget: "linux-x64",
          ...(setup ? { setupAssetName: "keiko-linux-x64-setup.zip" } : {}),
          evidenceFiles: [
            {
              assetName: manifestName,
              relativePath: "manifest/portable-manifest.json",
              sourcePath: "/x",
            },
          ],
        },
      ],
      archiveExpected: ["keiko-linux-x64.zip", ...(setup ? ["keiko-linux-x64-setup.zip"] : [])].map(
        (assetName) => ({
          assetName,
          expectedSha256: "f".repeat(64),
          expectedSize: 3,
          firstClassArchive: false,
        }),
      ),
      archiveSnapshot: {
        id: live.releaseId,
        assets: [
          { name: manifestName, digest, size: text.length },
          { name: "keiko-linux-x64.zip", id: live.archiveId },
          ...(setup ? [{ name: "keiko-linux-x64-setup.zip", id: live.setupId }] : []),
        ],
      },
      verifyAssets: () => undefined,
      smokeDownloads: () => smoked.push(true),
      headOfCheckout: () => HEAD,
      log: () => undefined,
    });
    return smoked;
  }

  it("fails closed naming the target and the differing ids", () => {
    expect(() => run({ releaseId: 90, archiveId: 99, setupId: 12 })).toThrow(
      /linux-x64: signed release id 10 differs from the live GitHub id 90.*signed archive asset id 11 differs from the live GitHub id 99/su,
    );
    // The recovery refused before the public smoke step, so nothing proceeds toward npm.
    expect(smoked).toStrictEqual([]);
  });

  it("refuses a signed setup asset for a target the live release has none for", () => {
    // Independent audit of PR #4464: the setup id was compared only when the target expects one.
    expect(() => run({ releaseId: 10, archiveId: 11 }, { setup: false })).toThrow(
      /linux-x64: signed setup asset id 12 differs from the live GitHub id undefined/u,
    );
    expect(smoked).toStrictEqual([]);
  });

  it("accepts a rerun whose live ids equal the signed ones", () => {
    expect(run({ releaseId: 10, archiveId: 11, setupId: 12 })).toStrictEqual([true]);
  });
});

describe("makePublishedPortableSeams", () => {
  const RELEASE_INFO = { published: true, repo: REPO, tag: TAG };

  it("downloads a released asset through its runGh seam", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-test-download-"));
    const asset = "linux-x64-portable-manifest.json";
    try {
      const runGh = (args) => {
        // The download seam writes the asset next to itself; do the same for the fake.
        const outDir = args[args.indexOf("--dir") + 1];
        writeFileSync(join(outDir, asset), '{"artifact":{"platformTarget":"linux-x64"}}\n');
        return { status: 0, stdout: "", stderr: "" };
      };
      const seams = makePublishedPortableSeams({
        runGh,
        verifyReleaseTrust: () => ({ ok: true }),
        trustedKeys: [],
      });
      const result = seams.downloadReleaseAsset(RELEASE_INFO, asset);
      expect(result?.text).toContain("platformTarget");
      expect(typeof result?.sha256).toBe("string");
      expect(result?.sha256).toHaveLength(64);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("returns undefined when gh release download fails", () => {
    const seams = makePublishedPortableSeams({
      runGh: () => ({ status: 1, stdout: "", stderr: "gh: 404" }),
      verifyReleaseTrust: () => ({ ok: true }),
      trustedKeys: [],
    });
    expect(seams.downloadReleaseAsset(RELEASE_INFO, "not-there.json")).toBeUndefined();
  });

  it("verifies a manifest through the trusted verifyReleaseTrust seam", () => {
    const seen = [];
    const seams = makePublishedPortableSeams({
      runGh: () => ({ status: 0, stdout: "", stderr: "" }),
      verifyReleaseTrust: (manifest, options) => {
        seen.push([manifest, options.trustedKeys]);
        return { ok: true };
      },
      trustedKeys: ["trusted-key"],
    });
    const manifest = {
      release: { commitSha: HEAD, releaseTag: TAG },
      provenance: { sourceCommitSha: HEAD },
    };
    const expected = { commitSha: HEAD, releaseTag: TAG };
    expect(seams.verifyPublishedManifestBinding(manifest, expected)).toBeUndefined();
    expect(seen).toStrictEqual([[manifest, ["trusted-key"]]]);
  });

  it("reports the underlying binding failure from checkPublishedManifestBinding", () => {
    const seams = makePublishedPortableSeams({
      runGh: () => ({ status: 0, stdout: "", stderr: "" }),
      verifyReleaseTrust: () => ({ ok: false, reason: "signature-invalid" }),
      trustedKeys: [],
    });
    const manifest = {
      release: { commitSha: HEAD, releaseTag: TAG },
      provenance: { sourceCommitSha: HEAD },
    };
    const expected = { commitSha: HEAD, releaseTag: TAG };
    expect(seams.verifyPublishedManifestBinding(manifest, expected)).toContain(
      "release-trust signature invalid",
    );
  });
});

describe("runVerifyPublishedPortableAssets", () => {
  const RELEASE_INFO = { published: true, repo: REPO, tag: TAG };

  function fakePublisher({ verifyPublishedManifestBindingResult } = {}) {
    return {
      downloadReleaseAsset: (_info, name) => ({
        text: JSON.stringify({ artifact: { platformTarget: name.split("-portable-manifest")[0] } }),
        sha256: "e".repeat(64),
      }),
      fail: (message) => {
        throw new Error(message);
      },
      verifyPublishedManifestBinding: () => verifyPublishedManifestBindingResult,
    };
  }

  function makeAssets(platforms) {
    return platforms.map((platformTarget) => ({
      platformTarget,
      evidenceFiles: [
        {
          assetName: `${platformTarget}-portable-manifest.json`,
          relativePath: "manifest/portable-manifest.json",
          sourcePath: `/stage/${platformTarget}/manifest/portable-manifest.json`,
        },
      ],
    }));
  }

  it("verifies non-manifest evidence assets via verifyAssets and the manifests through the publisher", () => {
    const platforms = ["linux-x64"];
    const assets = makeAssets(platforms);
    const archiveSnapshot = {
      assets: [
        {
          digest: `sha256:${"e".repeat(64)}`,
          name: "linux-x64-portable-manifest.json",
        },
      ],
    };
    const logs = [];
    const verifyCalls = [];
    runVerifyPublishedPortableAssets({
      publisher: fakePublisher(),
      releaseInfo: RELEASE_INFO,
      assets,
      archiveExpected: [],
      archiveSnapshot,
      verifyAssets: (remoteAssets, expected, info) =>
        verifyCalls.push({ remoteAssets, expected, info }),
      smokeDownloads: () => undefined,
      headOfCheckout: () => HEAD,
      log: (message) => logs.push(message),
    });
    expect(verifyCalls).toHaveLength(1);
    // Only the non-manifest evidence must reach verifyAssets — the manifest goes through the
    // signature path instead.
    expect(verifyCalls[0].expected).toStrictEqual([]);
    expect(logs.at(-1)).toContain(`portable assets verified and downloaded on published ${TAG}`);
  });

  function recoveryRun({ remoteAssets, smokeDownloads = () => undefined }) {
    const archive = {
      assetName: "keiko-linux-x64.standalone.zip",
      expectedSha256: "f".repeat(64),
      expectedSize: 3,
      firstClassArchive: false,
    };
    runVerifyPublishedPortableAssets({
      publisher: fakePublisher(),
      releaseInfo: RELEASE_INFO,
      assets: makeAssets(["linux-x64"]),
      archiveExpected: [archive],
      archiveSnapshot: { assets: remoteAssets },
      verifyAssets: () => undefined,
      smokeDownloads,
      headOfCheckout: () => HEAD,
      log: () => undefined,
    });
    return archive;
  }

  const manifestAsset = {
    digest: `sha256:${"e".repeat(64)}`,
    name: "linux-x64-portable-manifest.json",
    size: 5,
  };
  const packageAsset = { name: "keiko-linux-x64.standalone.zip" };

  it("downloads every published asset again without credentials (PR #4464)", () => {
    // Review finding on PR #4464 (P2): a run whose public download failed left the release
    // published, and its rerun returned after the API checks, so npm published over a download
    // nobody could fetch.
    const smoked = [];
    const archive = recoveryRun({
      remoteAssets: [packageAsset, manifestAsset],
      smokeDownloads: (remote, expected) => smoked.push({ remote, expected }),
    });

    expect(smoked).toStrictEqual([
      {
        remote: [packageAsset, manifestAsset],
        expected: [
          archive,
          {
            assetName: "linux-x64-portable-manifest.json",
            expectedSha256: "e".repeat(64),
            expectedSize: 5,
            firstClassArchive: false,
          },
        ],
      },
    ]);
  });

  it("fails the rerun when a published asset still cannot be downloaded", () => {
    expect(() =>
      recoveryRun({
        remoteAssets: [packageAsset, manifestAsset],
        smokeDownloads: () => {
          throw new Error("unauthenticated portable asset download failed");
        },
      }),
    ).toThrow("unauthenticated portable asset download failed");
  });

  it("refuses a published release carrying an asset this run did not validate", () => {
    const smoked = [];
    expect(() =>
      recoveryRun({
        remoteAssets: [packageAsset, manifestAsset, { name: "keiko-linux-x64.npm-team.zip" }],
        smokeDownloads: () => smoked.push(true),
      }),
    ).toThrow(
      `GitHub release ${TAG} is already published and carries assets this run did not validate: keiko-linux-x64.npm-team.zip; an immutable release cannot be repaired`,
    );
    expect(smoked).toStrictEqual([]);
  });

  it("propagates a manifest binding failure through the publisher.fail seam", () => {
    const platforms = ["linux-x64"];
    const assets = makeAssets(platforms);
    const archiveSnapshot = {
      assets: [{ digest: `sha256:${"e".repeat(64)}`, name: "linux-x64-portable-manifest.json" }],
    };
    expect(() =>
      runVerifyPublishedPortableAssets({
        publisher: fakePublisher({
          verifyPublishedManifestBindingResult:
            "release.commitSha does not match the checked-out HEAD",
        }),
        releaseInfo: RELEASE_INFO,
        assets,
        archiveExpected: [],
        archiveSnapshot,
        verifyAssets: () => undefined,
        smokeDownloads: () => undefined,
        headOfCheckout: () => HEAD,
        log: () => undefined,
      }),
    ).toThrow("release.commitSha does not match");
  });

  it("passes the checked-out HEAD to every manifest binding", () => {
    const platforms = ["linux-x64", "windows-x64"];
    const assets = makeAssets(platforms);
    const archiveSnapshot = {
      assets: platforms.map((p) => ({
        digest: `sha256:${"e".repeat(64)}`,
        name: `${p}-portable-manifest.json`,
      })),
    };
    const seenBindings = [];
    const publisher = {
      downloadReleaseAsset: () => ({ text: "{}", sha256: "e".repeat(64) }),
      fail: () => undefined,
      verifyPublishedManifestBinding: (_m, binding) => {
        seenBindings.push(binding);
        return undefined;
      },
    };
    runVerifyPublishedPortableAssets({
      publisher,
      releaseInfo: RELEASE_INFO,
      assets,
      archiveExpected: [],
      archiveSnapshot,
      verifyAssets: () => undefined,
      smokeDownloads: () => undefined,
      headOfCheckout: () => HEAD,
      log: () => undefined,
    });
    for (const binding of seenBindings) {
      expect(binding.commitSha).toBe(HEAD);
      expect(binding.releaseTag).toBe(TAG);
    }
    expect(seenBindings.map((b) => b.assetName)).toStrictEqual([
      "linux-x64-portable-manifest.json",
      "windows-x64-portable-manifest.json",
    ]);
  });
});
