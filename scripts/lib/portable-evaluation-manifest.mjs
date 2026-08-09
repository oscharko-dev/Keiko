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
      // A run id is reused across reruns; the attempt plus the immutable artifact ids pin the
      // exact execution and the exact uploaded bytes this evidence speaks about, so a later
      // rerun can neither substitute its own conclusion nor its own artifacts (Codex finding
      // on #3054).
      workflowRunAttempt: String(input.workflowRunAttempt),
      artifacts: input.artifacts.map((artifact) => ({
        name: artifact.name,
        id: artifact.id,
      })),
    },
    assets: input.assets.map((asset) => ({
      assetName: asset.assetName,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    })),
  };
}

/** Every entry must name an asset and carry a usable size and digest. */
function assetEntryFailures(asset) {
  if (!isRecord(asset) || !nonEmptyString(asset.assetName)) {
    return ["every asset entry must name an asset."];
  }
  return [
    [positiveInteger(asset.sizeBytes), `${asset.assetName}.sizeBytes must be a positive integer.`],
    [
      SHA256_RE.test(asset.sha256 ?? ""),
      `${asset.assetName}.sha256 must be a lowercase SHA-256 digest.`,
    ],
  ]
    .filter(([satisfied]) => !satisfied)
    .map(([, reason]) => reason);
}

/**
 * Exactly the expected set, each name once. A manifest that omits a download could not bind it;
 * one that adds an entry declares evidence for something the release does not publish; and a
 * DUPLICATE would let one asset be declared twice with different digests while every set-based
 * check still balanced (KfQ finding on #3054).
 */
function assetSetFailures(assets, expectedAssetNames) {
  const declaredNames = assets.filter(isRecord).map((asset) => asset.assetName);
  const names = new Set(declaredNames.filter(nonEmptyString));
  const failures = [];
  if (declaredNames.length !== new Set(declaredNames).size) {
    failures.push("manifest declares the same asset more than once.");
  }
  const missing = expectedAssetNames.filter((name) => !names.has(name));
  if (missing.length > 0) failures.push(`manifest does not declare ${missing.join(", ")}.`);
  const extra = [...names].filter((name) => !expectedAssetNames.includes(name));
  if (extra.length > 0) failures.push(`manifest declares unpublished assets: ${extra.join(", ")}.`);
  return failures;
}

function assetFailures(manifest, expectedAssetNames) {
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  return [...assets.flatMap(assetEntryFailures), ...assetSetFailures(assets, expectedAssetNames)];
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
      // Self-declared is not bound: without comparing against the commit the publisher is
      // actually releasing, a manually assembled release could ship portable bytes from one
      // revision and npm packages from another, and the run check would happily agree with the
      // manifest's own claim (Codex finding on #3054). When the caller knows its commit — the
      // publisher always does — the two must be the same revision.
      expected.sourceCommitSha === undefined ||
        manifest.release?.sourceCommitSha === expected.sourceCommitSha,
      `release.sourceCommitSha must be the commit being released (${String(expected.sourceCommitSha)}).`,
    ],
    ...provenanceBindingRules(manifest, expected),
  ]
    .filter(([satisfied]) => !satisfied)
    .map(([, reason]) => reason);
}

/** The provenance half of the binding rules — split out to keep each rule set readable. */
function provenanceBindingRules(manifest, expected) {
  return [
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
    [
      /^[1-9]\d*$/u.test(manifest.provenance?.workflowRunAttempt ?? ""),
      "provenance.workflowRunAttempt must be a positive attempt number.",
    ],
  ];
}

/**
 * The immutable identities of the run artifacts that carried the published bytes. Names alone
 * cannot survive a rerun — GitHub reuses the run id and `gh run download` selects by name — so
 * the verifier re-resolves these exact ids before it trusts any downloaded byte (Codex finding
 * on #3054).
 */
function provenanceArtifactFailures(manifest) {
  const artifacts = manifest.provenance?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return ["provenance.artifacts must list the run artifacts that carried the published bytes."];
  }
  const names = artifacts.filter(isRecord).map((artifact) => artifact.name);
  const failures = artifacts.flatMap((artifact) =>
    isRecord(artifact) && nonEmptyString(artifact.name) && positiveInteger(artifact.id)
      ? []
      : ["every provenance artifact must carry a name and a positive numeric id."],
  );
  if (new Set(names.filter(nonEmptyString)).size !== artifacts.length) {
    failures.push("provenance.artifacts must name each artifact exactly once.");
  }
  return failures;
}

export function portableEvaluationManifestFailures(manifest, expected) {
  if (!isRecord(manifest)) return ["portable evaluation manifest must be a JSON object."];
  return [
    ...bindingFailures(manifest, expected),
    ...provenanceArtifactFailures(manifest),
    ...assetFailures(manifest, expected.assetNames),
  ];
}
