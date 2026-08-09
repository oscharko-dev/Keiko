/**
 * The evidence contract for portable downloads that were published onto a release tag by the
 * governed evaluation lane rather than uploaded by the npm publisher.
 *
 * The qualified production lane binds its assets through per-target portable manifests that carry
 * GitHub release and asset ids, digests, provenance and signing status. The evaluation lane
 * publishes the archives directly, so without an equivalent artifact the publisher could only see
 * four file names and their sizes — and a name plus a non-zero size authorizes nothing. Stale,
 * tampered or hand-uploaded files would have been enough to promote the npm `latest` tag (Codex
 * and CodeRabbit findings on #3054).
 *
 * This manifest is that equivalent: ONE release asset, written by the producer that verified the
 * bytes, naming every published download with its exact size and SHA-256 and binding the set to
 * the release tag, the source commit, and the workflow run that built it. The publisher
 * re-downloads each download over the same unauthenticated URL a customer uses and refuses unless
 * the bytes hash to what this manifest declares.
 *
 * It is deliberately content-free: names, sizes, digests and identifiers only.
 */

export const PORTABLE_EVALUATION_MANIFEST_ASSET_NAME = "keiko-portable-evaluation-manifest.json";

/**
 * The only verification policy this artifact may declare; the signed lane never uses it. Module
 * scope on purpose — the producer stamps it and the validator requires it, both from here, so
 * there is no caller that should be able to name a different policy.
 */
const PORTABLE_EVALUATION_POLICY = "evaluation";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function buildPortableEvaluationManifest(input) {
  return {
    schemaVersion: 1,
    verificationPolicy: PORTABLE_EVALUATION_POLICY,
    release: { releaseTag: input.releaseTag, sourceCommitSha: input.sourceCommitSha },
    provenance: {
      repository: input.repository,
      workflowPath: input.workflowPath,
      workflowRunId: String(input.workflowRunId),
    },
    assets: input.assets.map((asset) => ({
      assetName: asset.assetName,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    })),
  };
}

function assetFailures(manifest, expectedAssetNames) {
  const failures = [];
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const names = new Set();
  for (const asset of assets) {
    if (!isRecord(asset) || !nonEmptyString(asset.assetName)) {
      failures.push("every asset entry must name an asset.");
      continue;
    }
    names.add(asset.assetName);
    if (!positiveInteger(asset.sizeBytes)) {
      failures.push(`${asset.assetName}.sizeBytes must be a positive integer.`);
    }
    if (!SHA256_RE.test(asset.sha256 ?? "")) {
      failures.push(`${asset.assetName}.sha256 must be a lowercase SHA-256 digest.`);
    }
  }
  // Exactly the expected set — a manifest that omits a download could not bind it, and one that
  // adds an entry would declare evidence for something the release does not publish.
  const missing = expectedAssetNames.filter((name) => !names.has(name));
  if (missing.length > 0) failures.push(`manifest does not declare ${missing.join(", ")}.`);
  const extra = [...names].filter((name) => !expectedAssetNames.includes(name));
  if (extra.length > 0) failures.push(`manifest declares unpublished assets: ${extra.join(", ")}.`);
  return failures;
}

/**
 * Fail-closed validation. Returns the list of reasons the manifest may NOT authorize a promotion;
 * an empty list means every field is well-formed and bound to the expected tag.
 */
function bindingFailures(manifest, expected) {
  return [
    [manifest.schemaVersion === 1, "schemaVersion must be 1."],
    [
      manifest.verificationPolicy === PORTABLE_EVALUATION_POLICY,
      `verificationPolicy must be "${PORTABLE_EVALUATION_POLICY}".`,
    ],
    [
      manifest.release?.releaseTag === expected.releaseTag,
      `release.releaseTag must be ${expected.releaseTag}.`,
    ],
    [
      COMMIT_RE.test(manifest.release?.sourceCommitSha ?? ""),
      "release.sourceCommitSha must be an exact commit SHA.",
    ],
    [
      manifest.provenance?.repository === expected.repository,
      `provenance.repository must be ${expected.repository}.`,
    ],
    [
      manifest.provenance?.workflowPath === expected.workflowPath,
      `provenance.workflowPath must be ${expected.workflowPath}.`,
    ],
    [
      /^\d+$/u.test(manifest.provenance?.workflowRunId ?? ""),
      "provenance.workflowRunId must be a numeric run id.",
    ],
  ]
    .filter(([satisfied]) => !satisfied)
    .map(([, reason]) => reason);
}

export function portableEvaluationManifestFailures(manifest, expected) {
  if (!isRecord(manifest)) return ["portable evaluation manifest must be a JSON object."];
  return [...bindingFailures(manifest, expected), ...assetFailures(manifest, expected.assetNames)];
}
