// Wrappers that wire the portable-published verification helpers in portable-release-publication.mjs
// to the concrete IO, git and crypto primitives release-publish.mjs itself uses. Kept here (not in
// release-publish.mjs) so every branch is reachable from a vitest unit — release-publish.mjs is a
// top-level script no test can import. Its `verifyPortableReleaseTrust` and trusted-keys inputs
// remain seams so a rerun can be exercised without a real Ed25519 signature.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "./digest.mjs";
import {
  checkPublishedManifestBinding,
  downloadPortableReleaseAsset,
  manifestBindingsFromAssets,
  nonManifestEvidenceExpected,
  verifyPublishedPortableEvidence,
} from "./portable-release-publication.mjs";

function readFileSha256(path) {
  return sha256(readFileSync(path));
}

/** IO seams for downloadPortableReleaseAsset, wired to node:fs, node:os, node:path and this run's gh. */
export function makeDownloadSeams(runGh) {
  return {
    mkdtemp: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
    runGh,
    pathJoin: join,
    exists: existsSync,
    readFile: readFileSync,
    sha256,
    toUtf8: (bytes) => bytes.toString("utf8"),
    rm: rmSync,
  };
}

/**
 * The two publisher seams for the already-published verification path: an asset downloader that
 * returns `{ text, sha256 }`, and a manifest binding check that returns undefined on success or a
 * one-line failure otherwise. `runGh` and the crypto seams are injected so the tests can drive
 * this without spawning gh or generating an Ed25519 key.
 *
 * @param runGh (args) → { status, error?, stdout, stderr } — used by `gh release download`.
 * @param verifyReleaseTrust (manifest, { now, trustedKeys }) → { ok, reason? }.
 * @param trustedKeys the trusted verification keys — evaluated at call time so a test's key set can
 *                    override the default without patching modules.
 */
export function makePublishedPortableSeams({ runGh, verifyReleaseTrust, trustedKeys }) {
  const downloadSeams = makeDownloadSeams(runGh);
  return {
    downloadReleaseAsset: (releaseInfo, assetName) =>
      downloadPortableReleaseAsset(downloadSeams, releaseInfo, assetName),
    verifyPublishedManifestBinding: (manifest, expected) =>
      checkPublishedManifestBinding(manifest, expected, {
        verifyReleaseTrust,
        now: new Date(),
        trustedKeys,
      }),
  };
}

/**
 * The published-release verification path itself: verify every non-manifest evidence file's digest
 * against GitHub (its bytes are byte-reproducible from the assemble stage), then verify each
 * portable manifest by its trusted Ed25519 signature and its commit/tag binding (a rerun cannot
 * reproduce the released manifest bytes once release.created_at has drifted).
 *
 * @param verifyAssets  the archive/evidence digest checker in release-publish.mjs.
 * @param headOfCheckout () → sha of the checked-out HEAD.
 */
export function runVerifyPublishedPortableAssets({
  publisher,
  releaseInfo,
  assets,
  archiveSnapshot,
  verifyAssets,
  headOfCheckout,
  log = console.log,
}) {
  const evidenceExpected = nonManifestEvidenceExpected(assets, {
    sha256File: readFileSha256,
    statFile: statSync,
  });
  verifyAssets(archiveSnapshot.assets, evidenceExpected, releaseInfo);
  const head = headOfCheckout();
  const bindings = manifestBindingsFromAssets(assets, head, releaseInfo.tag);
  verifyPublishedPortableEvidence(publisher, releaseInfo, archiveSnapshot.assets, bindings);
  log(`release-publish: portable assets verified on published ${releaseInfo.tag}.`);
}
