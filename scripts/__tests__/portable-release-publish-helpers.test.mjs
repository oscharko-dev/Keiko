import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
      archiveSnapshot,
      verifyAssets: (remoteAssets, expected, info) =>
        verifyCalls.push({ remoteAssets, expected, info }),
      headOfCheckout: () => HEAD,
      log: (message) => logs.push(message),
    });
    expect(verifyCalls).toHaveLength(1);
    // Only the non-manifest evidence must reach verifyAssets — the manifest goes through the
    // signature path instead.
    expect(verifyCalls[0].expected).toStrictEqual([]);
    expect(logs.at(-1)).toContain(`portable assets verified on published ${TAG}`);
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
        archiveSnapshot,
        verifyAssets: () => undefined,
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
      archiveSnapshot,
      verifyAssets: () => undefined,
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
