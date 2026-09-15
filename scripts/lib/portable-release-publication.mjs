// The repository has GitHub immutable releases enabled: once a release is published, no asset can be
// added, replaced or deleted, and a deleted immutable release burns its tag name for good. v1.0.0
// was lost that way on 2026-09-14, when the publisher created the release as published and only then
// uploaded its downloads ("HTTP 422: Cannot upload assets to an immutable release"). A portable
// release is therefore assembled as a draft and published only after every download and its signed
// evidence verify on GitHub. These decisions live here, not in the spawned publisher, so in-process
// tests can prove every branch.

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * The id of the draft this run created, read from GitHub's answer to the create call itself. A lookup
 * in the release listing right after the create missed the new draft on 2026-09-14 (v1.0.1: "found
 * 0"), because the listing lags behind the write.
 *
 * @param release  the REST create-release response
 * @returns {{ id?: number, failure?: string }}
 */
export function createdDraftId(release, tag) {
  if (release?.tag_name !== tag || release?.draft !== true) {
    return {
      failure: `GitHub did not answer the draft release create for ${tag} with that draft.`,
    };
  }
  return Number.isSafeInteger(release.id) && release.id > 0
    ? { id: release.id }
    : { failure: `the draft GitHub release for ${tag} has no valid id.` };
}

/**
 * Why an existing draft of the tag cannot be completed by this run, or undefined when it can. An
 * interrupted publish leaves its draft behind; a draft carrying the evaluation lane's manifest is
 * not this lane's to complete.
 */
export function resumableDraftFailure(view, tag, evaluationManifestAssetName) {
  // Only a readable asset list can prove the evaluation manifest is absent.
  const assets = view?.assets;
  if (!Array.isArray(assets) || assets.some((asset) => typeof asset?.name !== "string")) {
    return `the draft GitHub release ${tag} has an invalid asset listing.`;
  }
  if (assets.some((asset) => asset.name === evaluationManifestAssetName)) {
    return `the draft GitHub release ${tag} carries the evaluation lane's manifest; a qualified production publish needs its own version and tag.`;
  }
  return Number.isSafeInteger(view?.databaseId) && view.databaseId > 0
    ? undefined
    : `the draft GitHub release ${tag} has no valid id.`;
}

/**
 * GitHub records a SHA-256 digest for every uploaded asset. Checking it against the bytes this run
 * verified proves the upload before the release becomes immutable, instead of only afterwards.
 *
 * @param expectedAssets  [{ assetName, expectedSha256 }]
 * @returns one failure per missing or mismatching digest
 */
export function remoteDigestFailures(remoteAssets, expectedAssets) {
  const byName = new Map(
    (Array.isArray(remoteAssets) ? remoteAssets : []).map((asset) => [asset?.name, asset]),
  );
  return expectedAssets.flatMap(({ assetName, expectedSha256 }) => {
    const digest = byName.get(assetName)?.digest;
    if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) {
      return [`${assetName} has no SHA-256 digest on GitHub.`];
    }
    return digest === `sha256:${expectedSha256}`
      ? []
      : [`${assetName} on GitHub does not carry the bytes this run verified.`];
  });
}

/** The message for a published release that cannot take the downloads it lacks. */
export function immutableReleaseRepairFailure(tag, detail) {
  return `GitHub release ${tag} is already published and ${detail}; an immutable release cannot be repaired, so publish the next patch version instead.`;
}

function readGithubJson(runGh, path) {
  const result = runGh(["api", path]);
  if (result?.error !== undefined || result?.status !== 0) {
    return /\bHTTP 404\b/u.test(String(result?.stderr ?? ""))
      ? { kind: "missing" }
      : { kind: "error" };
  }
  try {
    return { kind: "found", value: JSON.parse(String(result.stdout)) };
  } catch {
    return { kind: "error" };
  }
}

function peelToCommit(runGh, repository, target) {
  if (target?.type === "commit") return target.sha;
  if (target?.type !== "tag") return undefined;
  const annotated = readGithubJson(runGh, `repos/${repository}/git/tags/${String(target.sha)}`);
  const object = annotated.kind === "found" ? annotated.value?.object : undefined;
  return object?.type === "commit" ? object.sha : undefined;
}

/**
 * Publishing a draft binds it to wherever its tag points at that moment, so the tag is re-read at
 * the publication boundary and must still name the commit this run checked out.
 *
 * @param runGh  (args) => {status, stdout, stderr, error}
 * @returns a failure message, or undefined when the tag points at `head`
 */
export function releaseTagAtHeadFailure({ head, repository, runGh, tag }) {
  const ref = readGithubJson(runGh, `repos/${repository}/git/ref/tags/${tag}`);
  if (ref.kind === "missing")
    return `tag ${tag} does not exist on GitHub, so the draft cannot be published.`;
  if (ref.kind === "error") return `tag ${tag} could not be read on GitHub.`;
  const commit = peelToCommit(runGh, repository, ref.value?.object);
  if (typeof commit !== "string" || !COMMIT_SHA.test(commit)) {
    return `tag ${tag} does not resolve to a commit on GitHub.`;
  }
  return commit === head
    ? undefined
    : `tag ${tag} points at ${commit} on GitHub, not at the checked-out ${head}; a release created or published now would bind to another commit.`;
}

/**
 * The GitHub steps of a portable publication. The spawned publisher hands in its own seams, so every
 * branch here is proven in-process:
 *   gh(args) → result of any exit, runGh(args) → result that already failed the run on a non-zero
 *   exit, fail(message) → never, log(message), assertTagAtHead(tag),
 *   refuseEvaluationOwnedRelease(viewResult, tag), snapshot(releaseInfo) → { assets, createdAt, id },
 *   verifyAssets(remoteAssets, expected, releaseInfo).
 */
export function openPortableRelease(
  publisher,
  { head, latest, notes, prerelease, repo, tag, title },
) {
  publisher.assertTagAtHead(tag);
  const latestArgs = latest && !prerelease ? ["--latest"] : ["--latest=false"];
  const existing = publisher.gh([
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "isDraft,assets,databaseId,name",
  ]);
  if (existing?.status === 0) {
    const view = parsedStdout(existing);
    // Only a draft under this publisher's own title is resumed; the evaluation lane names its draft
    // "Keiko <version> (<tag>)" and owns resuming or deleting it (#3054).
    if (view?.isDraft === true && view.name === title) {
      return resumeDraft(publisher, view, { latestArgs, repo, tag });
    }
    publisher.refuseEvaluationOwnedRelease(existing, tag);
    publisher.log(`GitHub release ${tag} is already published; verifying it.`);
    return { published: true, repo, tag };
  }
  publisher.log(`creating draft GitHub release ${tag}.`);
  // The tag was just proven to point at head; target_commitish names the same commit, so even a tag
  // deleted in between could only be recreated where this build came from.
  const created = publisher.runGh([
    "api",
    "--method",
    "POST",
    `repos/${repo}/releases`,
    "-f",
    `tag_name=${tag}`,
    "-f",
    `target_commitish=${head}`,
    "-f",
    `name=${title}`,
    "-f",
    `body=${notes}`,
    "-F",
    "draft=true",
    "-F",
    `prerelease=${String(prerelease)}`,
  ]);
  const draft = createdDraftId(parsedStdout(created), tag);
  if (draft.failure !== undefined) publisher.fail(draft.failure);
  return { draft: true, id: draft.id, latestArgs, repo, tag };
}

function resumeDraft(publisher, view, { latestArgs, repo, tag }) {
  const failure = resumableDraftFailure(view, tag, publisher.evaluationManifestAssetName);
  if (failure !== undefined) publisher.fail(failure);
  publisher.log(
    `resuming draft GitHub release ${tag} (id ${String(view.databaseId)}) left by an interrupted publish.`,
  );
  return { draft: true, id: view.databaseId, latestArgs, repo, tag };
}

function parsedStdout(result) {
  if (result?.status !== 0) return undefined;
  try {
    return JSON.parse(String(result.stdout ?? ""));
  } catch {
    return undefined;
  }
}

/** Uploads into this run's draft; an already published release never receives an upload. */
export function uploadIntoDraft(publisher, releaseInfo, paths) {
  if (releaseInfo.published === true) return;
  publisher.runGh([
    "release",
    "upload",
    releaseInfo.tag,
    "--repo",
    releaseInfo.repo,
    "--clobber",
    ...paths,
  ]);
}

/** A published release is immutable: it can be verified, never completed. */
export function refuseIncompletePublishedRelease(publisher, releaseInfo, remoteAssets, expected) {
  if (releaseInfo.published !== true) return;
  const names = new Set(
    (Array.isArray(remoteAssets) ? remoteAssets : []).map((asset) => asset?.name),
  );
  const missing = expected.filter((entry) => !names.has(entry.assetName));
  if (missing.length > 0) {
    publisher.fail(
      immutableReleaseRepairFailure(
        releaseInfo.tag,
        `lacks ${missing.map((entry) => entry.assetName).join(", ")}`,
      ),
    );
    return;
  }
  const digestFailures = remoteDigestFailures(remoteAssets, expected);
  if (digestFailures.length > 0) {
    publisher.fail(
      immutableReleaseRepairFailure(releaseInfo.tag, `differs: ${digestFailures.join(" ")}`),
    );
  }
}

/**
 * Proves the complete download set on GitHub, then publishes this run's draft as the last GitHub
 * step. Returns the assets as the public release lists them.
 */
export function publishVerifiedPortableRelease(publisher, releaseInfo, remoteAssets, expected) {
  refuseIncompletePublishedRelease(publisher, releaseInfo, remoteAssets, expected);
  publisher.verifyAssets(remoteAssets, expected, releaseInfo);
  const digestFailures = remoteDigestFailures(remoteAssets, expected);
  if (digestFailures.length > 0) {
    publisher.fail(
      `GitHub Release portable asset digests failed:\n  - ${digestFailures.join("\n  - ")}`,
    );
  }
  if (releaseInfo.draft !== true) return remoteAssets;
  publisher.assertTagAtHead(releaseInfo.tag);
  publisher.runGh([
    "release",
    "edit",
    releaseInfo.tag,
    "--repo",
    releaseInfo.repo,
    "--verify-tag",
    "--draft=false",
    ...releaseInfo.latestArgs,
  ]);
  publisher.log(`published GitHub release ${releaseInfo.tag}.`);
  const publicSnapshot = publisher.snapshot({ repo: releaseInfo.repo, tag: releaseInfo.tag });
  publisher.verifyAssets(publicSnapshot.assets, expected, releaseInfo);
  return publicSnapshot.assets;
}

/** A draft is invisible to the by-tag endpoint, so a release this run created is read by its id. */
export function releaseSnapshotPath(releaseInfo) {
  return releaseInfo.id === undefined
    ? `repos/${releaseInfo.repo}/releases/tags/${releaseInfo.tag}`
    : `repos/${releaseInfo.repo}/releases/${String(releaseInfo.id)}`;
}

/**
 * Verifies the portable-manifest.json evidence assets of an already published release by their
 * trusted Ed25519 signature and their commit/tag binding, not by a byte match against a locally
 * rebuilt manifest. A rerun cannot reproduce the released evidence bytes when the publish signed
 * the manifest at the release's earlier draft `created_at` (v1.0.1's draft was signed
 * 2026-09-14T20:38:54Z while the published release now carries `created_at` 2026-09-14T23:19:18Z);
 * an Ed25519 signature over the same manifest content at a different `signedAt` produces different
 * bytes even for a deterministic signature scheme. A cryptographic signature check on the released
 * bytes is at least as strong as demanding a byte match against a rebuild.
 *
 * The publisher's seams here are `downloadReleaseAsset(releaseInfo, assetName) → { text, sha256 }`
 * and `verifyPublishedManifestBinding(manifest, expected) → failure | undefined`.
 *
 * @param manifestBindings  [{ assetName, commitSha, releaseTag }] — one per portable-manifest asset
 */
export function verifyPublishedPortableEvidence(
  publisher,
  releaseInfo,
  remoteAssets,
  manifestBindings,
) {
  const remoteByName = new Map(
    (Array.isArray(remoteAssets) ? remoteAssets : []).map((asset) => [asset?.name, asset]),
  );
  const failures = manifestBindings.flatMap((binding) =>
    publishedEvidenceFailuresForBinding(publisher, releaseInfo, remoteByName, binding),
  );
  if (failures.length > 0) {
    publisher.fail(
      `GitHub Release portable evidence verification failed:\n  - ${failures.join("\n  - ")}`,
    );
  }
}

function publishedEvidenceFailuresForBinding(publisher, releaseInfo, remoteByName, binding) {
  const remote = remoteByName.get(binding.assetName);
  if (!validRemoteDigest(remote)) {
    return [`${binding.assetName} has no SHA-256 digest on GitHub.`];
  }
  const download = publisher.downloadReleaseAsset(releaseInfo, binding.assetName);
  if (!validDownloadResult(download)) {
    return [`${binding.assetName} could not be downloaded from GitHub.`];
  }
  if (`sha256:${download.sha256}` !== remote.digest) {
    return [`${binding.assetName} bytes do not match the digest GitHub reports.`];
  }
  const manifest = parseJsonOrUndefined(download.text);
  if (manifest === undefined) {
    return [`${binding.assetName} is not valid JSON.`];
  }
  const bindingFailure = publisher.verifyPublishedManifestBinding(manifest, binding);
  return bindingFailure === undefined ? [] : [`${binding.assetName}: ${bindingFailure}`];
}

function validRemoteDigest(remote) {
  return (
    remote !== undefined && typeof remote.digest === "string" && SHA256_DIGEST.test(remote.digest)
  );
}

function validDownloadResult(download) {
  return (
    download !== undefined &&
    typeof download.text === "string" &&
    typeof download.sha256 === "string"
  );
}

function parseJsonOrUndefined(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Downloads a single asset from a GitHub release into a fresh temporary directory and returns its
 * UTF-8 text plus SHA-256 digest. Returns undefined when the download failed or the asset did not
 * land where `gh release download` was expected to write it, so the caller can turn that into a
 * verification failure by name.
 *
 * Seams (all required): `mkdtemp(prefix) → dir`, `runGh(args) → { status, error?, ... }`,
 * `pathJoin(...parts)`, `exists(path)`, `readFile(path) → Buffer`, `sha256(Buffer) → hex`,
 * `toUtf8(Buffer) → string`, `rm(dir, options)`.
 */
export function downloadPortableReleaseAsset(seams, releaseInfo, assetName) {
  const root = seams.mkdtemp("keiko-portable-verify-");
  try {
    const result = seams.runGh([
      "release",
      "download",
      releaseInfo.tag,
      "--repo",
      releaseInfo.repo,
      "--pattern",
      assetName,
      "--dir",
      root,
      "--clobber",
    ]);
    if (result?.error !== undefined || result?.status !== 0) return undefined;
    const filePath = seams.pathJoin(root, assetName);
    if (!seams.exists(filePath)) return undefined;
    const bytes = seams.readFile(filePath);
    return { sha256: seams.sha256(bytes), text: seams.toUtf8(bytes) };
  } finally {
    seams.rm(root, { force: true, recursive: true });
  }
}

/**
 * Verifies a released portable manifest's trusted Ed25519 signature and its commit/tag binding. A
 * rerun of the publish job cannot reproduce the released manifest bytes when the draft was signed
 * at an earlier `created_at` than the release now reports (v1.0.1: draft signed
 * 2026-09-14T20:38:54Z, release created_at 2026-09-14T23:19:18Z). This check is at least as strong
 * as demanding those exact bytes back.
 *
 * Seams: `verifyReleaseTrust(manifest, { now, trustedKeys }) → { ok, reason? }`, and `now: Date`
 * plus `trustedKeys: readonly key[]` for that call.
 * Expected: `{ commitSha, releaseTag }` — the checked-out HEAD and this run's tag.
 */
export function checkPublishedManifestBinding(manifest, expected, seams) {
  const verification = seams.verifyReleaseTrust(manifest, {
    now: seams.now,
    trustedKeys: seams.trustedKeys,
  });
  if (!verification.ok) return `release-trust signature invalid (${verification.reason})`;
  if (manifest.release?.commitSha !== expected.commitSha) {
    return "release.commitSha does not match the checked-out HEAD";
  }
  if (manifest.release?.releaseTag !== expected.releaseTag) {
    return `release.releaseTag does not match ${expected.releaseTag}`;
  }
  if (manifest.provenance?.sourceCommitSha !== expected.commitSha) {
    return "provenance.sourceCommitSha does not match the checked-out HEAD";
  }
  return undefined;
}

/**
 * The `expected` records for the non-manifest evidence assets (SHA256SUMS, SBOM, license notice,
 * signing summary, provenance statement, sidecar SBOM/license). These files are copied verbatim
 * from the assemble stage and are byte-reproducible, so the run's own bytes are what a released
 * digest must match. The manifest evidence (`*-portable-manifest.json`) is deliberately excluded —
 * it is verified by signature instead.
 *
 * Seams: `sha256File(path) → hex`, `statFile(path) → { size }`.
 */
export function nonManifestEvidenceExpected(assets, seams) {
  return assets.flatMap((asset) =>
    asset.evidenceFiles
      .filter((evidence) => evidence.relativePath !== "manifest/portable-manifest.json")
      .map((evidence) => ({
        assetName: evidence.assetName,
        expectedSha256: seams.sha256File(evidence.sourcePath),
        expectedSize: seams.statFile(evidence.sourcePath).size,
        firstClassArchive: false,
      })),
  );
}

/**
 * One binding record per portable target: which manifest asset must be verified, which commit its
 * `release.commitSha` and `provenance.sourceCommitSha` must equal, and which tag its
 * `release.releaseTag` must equal.
 */
export function manifestBindingsFromAssets(assets, head, releaseTag) {
  return assets.map((asset) => ({
    assetName: `${asset.platformTarget}-portable-manifest.json`,
    commitSha: head,
    releaseTag,
  }));
}
