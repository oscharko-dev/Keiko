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
 * @param releases  the REST release listing, which includes drafts for a token with contents access
 * @returns {{ id?: number, failure?: string }}
 */
export function draftReleaseId(releases, tag) {
  if (!Array.isArray(releases)) return { failure: "the GitHub release listing is malformed." };
  const drafts = releases.filter((release) => release?.tag_name === tag && release?.draft === true);
  if (drafts.length !== 1) {
    return {
      failure: `expected exactly one draft GitHub release for ${tag}, found ${String(drafts.length)}.`,
    };
  }
  const { id } = drafts[0];
  return Number.isSafeInteger(id) && id > 0
    ? { id }
    : { failure: `the draft GitHub release for ${tag} has no valid id.` };
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
export function openPortableRelease(publisher, { latest, notes, prerelease, repo, tag, title }) {
  publisher.assertTagAtHead(tag);
  const existing = publisher.gh([
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "isDraft,assets",
  ]);
  if (existing?.status === 0) {
    publisher.refuseEvaluationOwnedRelease(existing, tag);
    publisher.log(`GitHub release ${tag} is already published; verifying it.`);
    return { published: true, repo, tag };
  }
  publisher.log(`creating draft GitHub release ${tag}.`);
  publisher.runGh([
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--title",
    title,
    "--notes",
    notes,
    "--verify-tag",
    "--draft",
    ...(prerelease ? ["--prerelease"] : []),
  ]);
  const listing = publisher.runGh(["api", `repos/${repo}/releases?per_page=100`]);
  const draft = draftReleaseId(parsedStdout(listing), tag);
  if (draft.failure !== undefined) publisher.fail(draft.failure);
  const latestArgs = latest && !prerelease ? ["--latest"] : ["--latest=false"];
  return { draft: true, id: draft.id, latestArgs, repo, tag };
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
