/**
 * Decides whether a GitHub Release that this publish run did NOT upload may authorize the npm
 * `latest` dist-tag.
 *
 * All I/O is injected. The publisher owns the process boundary — `gh`, `curl`, temp files — and
 * this module owns every judgement, so the judgements can be exercised directly instead of only
 * through a spawned script, where in-process coverage cannot see them.
 *
 * It answers with failures plus the download expectations the caller must still verify byte for
 * byte; it never decides that bytes are acceptable, because it never sees them.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

import {
  PORTABLE_EVALUATION_MANIFEST_ASSET_NAME,
  portableEvaluationManifestFailures,
} from "./portable-evaluation-manifest.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A public download URL: HTTPS, and no credentials embedded in it. Module scope — the only caller
 * is the download below, and a second caller would mean a second place deciding what a customer
 * may be pointed at.
 */
function publicDownloadUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * Fetches a JSON release asset over the same unauthenticated URL a customer would use. The fetch
 * itself is injected; everything around it — URL policy, temp handling, parse-or-refuse — is
 * decided here so it is covered by tests rather than only by a spawned release.
 */
export function downloadJsonAsset(runFetch, url) {
  if (!publicDownloadUrl(url)) return undefined;
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-evidence-"));
  const destination = join(root, "asset.json");
  try {
    const result = runFetch(url, destination);
    if (!isRecord(result) || result.error !== undefined || result.status !== 0) return undefined;
    return JSON.parse(readFileSync(destination, "utf8"));
  } catch {
    return undefined;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

/**
 * A command result becomes evidence only when it both succeeded and parsed. Anything else is
 * `undefined` — the callers below treat an unreadable answer as a refusal, never as an absent
 * objection.
 */
export function jsonFromCommand(result) {
  if (!isRecord(result) || result.status !== 0) return undefined;
  try {
    return JSON.parse(String(result.stdout ?? ""));
  } catch {
    return undefined;
  }
}

/**
 * The three reads this verification needs, expressed once against injected primitives so the URL
 * and API shapes are covered by tests rather than only by a spawned release. `gh` runs a GitHub
 * CLI invocation and returns its result; `downloadJson` fetches a public asset URL.
 */
export function releaseReaders({ gh, downloadJson }) {
  return {
    readRelease: (repository, tag) =>
      jsonFromCommand(gh(["api", `repos/${repository}/releases/tags/${tag}`])),
    readRun: (repository, runId) => {
      const view = jsonFromCommand(gh(["api", `repos/${repository}/actions/runs/${runId}`]));
      return isRecord(view) ? view : undefined;
    },
    readManifest: (url) => downloadJson(url),
  };
}

/** Downloads GitHub reports as present and non-empty. A zero-byte asset is not a download. */
function publishedAssetNames(remoteAssets) {
  return new Set(
    remoteAssets
      .filter((asset) => isRecord(asset) && Number(asset.size) > 0)
      .map((asset) => asset.name),
  );
}

export function missingPortableDownloads(remoteAssets, expectedNames) {
  const present = publishedAssetNames(remoteAssets);
  return expectedNames.filter((name) => !present.has(name));
}

function evidenceAsset(remoteAssets) {
  return remoteAssets.find(
    (asset) => isRecord(asset) && asset.name === PORTABLE_EVALUATION_MANIFEST_ASSET_NAME,
  );
}

/**
 * Provenance is only provenance when it resolves. The named run must be a successful run of the
 * canonical portable-assets workflow at the exact commit the evidence declares — otherwise the
 * evidence names something that never built these bytes.
 */
function runFailures(manifest, readRun, workflowPath) {
  const runId = manifest.provenance.workflowRunId;
  const run = readRun(manifest.provenance.repository, runId);
  if (run === undefined) {
    return [`evidence names workflow run ${runId}, which could not be read.`];
  }
  return [
    [run.path === workflowPath, "must be a run of the portable assets workflow"],
    [run.head_sha === manifest.release.sourceCommitSha, "must be the declared source commit"],
    [run.conclusion === "success", "must have concluded successfully"],
  ]
    .filter(([satisfied]) => !satisfied)
    .map(([, reason]) => `evidence names workflow run ${runId}, which ${reason}.`);
}

/**
 * GitHub's own size for each download must equal what the evidence declares. This is cheap and
 * catches a replaced asset before anything is downloaded; the digest check that follows is what
 * actually binds the bytes.
 */
function declaredDownloads(manifest, remoteAssets, expectedNames) {
  const declared = new Map(manifest.assets.map((asset) => [asset.assetName, asset]));
  const remote = new Map(remoteAssets.filter(isRecord).map((asset) => [asset.name, asset]));
  const failures = [];
  const expectedDownloads = [];
  for (const assetName of expectedNames) {
    const entry = declared.get(assetName);
    if (entry === undefined) continue;
    if (remote.get(assetName)?.size !== entry.sizeBytes) {
      failures.push(`${assetName} does not have the size its evidence declares.`);
      continue;
    }
    expectedDownloads.push({
      assetName,
      expectedSize: entry.sizeBytes,
      expectedSha256: entry.sha256,
    });
  }
  return { failures, expectedDownloads };
}

/** A run that actually publishes, as opposed to previewing what a publish would do. */
export function livePublish(options) {
  return options.planOnly !== true && options.dryRun !== true;
}

/** The exact download set a stable `latest` release must carry. */
export function portableDownloadAssetNames(targets, setupAssetName) {
  return Object.freeze([...targets.map((target) => target.assetName), setupAssetName]);
}

/**
 * The upload half's only question: after this run uploaded and verified them, is the set complete?
 * Returns the operator message, or undefined when nothing is missing.
 */
export function uploadedDownloadSetFailure(tag, remoteAssets, expectedNames) {
  const missing = missingPortableDownloads(remoteAssets, expectedNames);
  if (missing.length === 0) return undefined;
  return (
    `GitHub release ${tag} is missing portable downloads: ${missing.join(", ")}. ` +
    "A stable latest release must carry every portable download before npm publishes it."
  );
}

/**
 * The two refusals a publish can make from its own arguments, before any gate runs — both about
 * announcing downloads that will not exist. Returns the operator message, or undefined.
 */
export function portableAssetInputFailure({ suppliesManifest, skipGithubRelease, stableLatest }) {
  if (suppliesManifest && skipGithubRelease) {
    return "a publish that supplies portable assets must attach them to the GitHub Release.";
  }
  if (stableLatest && skipGithubRelease) {
    return "a stable latest publish must publish its GitHub Release; --skip-github-release is not accepted.";
  }
  return undefined;
}

/**
 * @param input.release       the GitHub release payload, or undefined when it does not exist
 * @param input.readManifest  (url) => parsed JSON, or undefined when it cannot be read
 * @param input.readRun       (repository, runId) => run view, or undefined when it cannot be read
 * @returns {{failures: string[], expectedDownloads: object[]}}
 */
export function prepublishedReleaseFailures(input) {
  const { tag, repository, workflowPath, expectedNames, release, readManifest, readRun } = input;
  if (!isRecord(release) || !Array.isArray(release.assets)) {
    return {
      failures: [
        `GitHub release ${tag} does not exist or reported no assets. A stable latest publish needs it to already carry its portable downloads — publish it first with \`node scripts/release-portable-prerelease.mjs --public-release\`.`,
      ],
      expectedDownloads: [],
    };
  }
  // Only a published stable release may authorize `latest`. A draft or prerelease-flagged payload
  // still resolves from the release-by-tag endpoint with every asset in place, so without this
  // check a manually assembled prerelease could promote npm `latest` while GitHub's own surface
  // never presents it as the stable Latest release (Codex finding on #3054).
  if (release.draft !== false || release.prerelease !== false) {
    return {
      failures: [
        `GitHub release ${tag} is a draft or marked as a prerelease; only the published stable release may authorize the latest dist-tag.`,
      ],
      expectedDownloads: [],
    };
  }
  const missing = missingPortableDownloads(release.assets, expectedNames);
  if (missing.length > 0) {
    return {
      failures: [`GitHub release ${tag} is missing portable downloads: ${missing.join(", ")}.`],
      expectedDownloads: [],
    };
  }
  const asset = evidenceAsset(release.assets);
  if (asset === undefined) {
    return {
      failures: [
        `GitHub release ${tag} carries portable downloads this run did not upload but no ${PORTABLE_EVALUATION_MANIFEST_ASSET_NAME}; downloads without reviewed evidence must never authorize the latest dist-tag.`,
      ],
      expectedDownloads: [],
    };
  }
  const manifest = readManifest(asset.browser_download_url);
  const manifestFailures = portableEvaluationManifestFailures(manifest, {
    releaseTag: tag,
    repository,
    workflowPath,
    assetNames: expectedNames,
    sourceCommitSha: input.sourceCommitSha,
  });
  if (manifestFailures.length > 0) return { failures: manifestFailures, expectedDownloads: [] };
  const provenanceFailures = runFailures(manifest, readRun, workflowPath);
  if (provenanceFailures.length > 0) return { failures: provenanceFailures, expectedDownloads: [] };
  return {
    ...declaredDownloads(manifest, release.assets, expectedNames),
    workflowRunId: manifest.provenance.workflowRunId,
  };
}

/**
 * Reports failures and stops. `ports.fail` throws in production; a port that merely records must
 * not let the caller carry on with values the failures just invalidated, so this throws too.
 */
function refuse(ports, summary, failures) {
  if (failures.length === 0) return;
  ports.fail(`${summary}:\n  - ${failures.join("\n  - ")}`);
  throw new Error(`${summary}: ${failures.join("; ")}`);
}

/**
 * The publisher's whole portable-download gate, bound once to its process ports.
 *
 * `scripts/release-publish.mjs` runs only as a spawned CLI, so nothing defined inside it can be
 * exercised in-process — every line added there is untested by construction. Keeping the gate here
 * and handing the script one facade is what makes these decisions testable at all; the script is
 * left with wiring.
 */
export function portableReleaseGate(ports) {
  const expectedNames = portableDownloadAssetNames(ports.targets, ports.setupAssetName);
  const readers = releaseReaders({
    gh: ports.gh,
    downloadJson: (url) => downloadJsonAsset(ports.fetchAssetToFile, url),
  });
  return {
    expectedNames,

    /** After this run uploaded and verified them, the set must be complete. */
    assertUploadedSetComplete(releaseInfo) {
      const message = uploadedDownloadSetFailure(
        releaseInfo.tag,
        ports.snapshot(releaseInfo).assets,
        expectedNames,
      );
      if (message !== undefined) ports.fail(message);
      ports.log(`release-publish: ${releaseInfo.tag} carries every portable download.`);
    },

    inputFailure: portableAssetInputFailure,

    /**
     * The governed evaluation lane already published these downloads. Read-only until it has
     * proven them, so a run that cannot leaves the repository exactly as it found it.
     */
    verifyPrepublished(tag, repository, workflowPath, sourceCommitSha) {
      const release = readers.readRelease(repository, tag);
      const { failures, expectedDownloads, workflowRunId } = prepublishedReleaseFailures({
        tag,
        repository,
        workflowPath,
        expectedNames,
        sourceCommitSha,
        release,
        readManifest: readers.readManifest,
        readRun: readers.readRun,
      });
      refuse(ports, "prepublished portable downloads are not usable", failures);
      // The evidence declares digests; the RUN proves them. Checked before the bytes are fetched,
      // so a forged manifest cannot even direct the download.
      refuse(
        ports,
        "prepublished portable downloads are not the bytes their workflow run produced",
        runArtifactDigestFailures(
          expectedDownloads,
          (names) => ports.collectRunArtifactDigests(workflowRunId, names),
          evaluationArtifactNames(ports.targets),
        ),
      );
      ports.verifyBytes(release.assets, expectedDownloads);
      ports.log(`release-publish: prepublished downloads on ${tag} match their evidence.`);
      return true;
    },
  };
}

/**
 * The evaluation staging artifacts of a portable-assets run, by target. Their names are the
 * contract between the producing workflow and both publishers.
 */
function evaluationArtifactNames(targets) {
  return targets.map((target) => `portable-stage-${target.platformTarget}-evaluation-unsigned`);
}

/**
 * Binds the published downloads to the bytes the referenced workflow run actually produced.
 *
 * Without this the release-hosted evidence is its own provenance: anyone able to replace release
 * assets could upload arbitrary downloads plus a self-authored manifest naming any successful run
 * for that commit, and a later publish would promote those bytes to npm `latest` (Codex finding on
 * #3054). Workflow-run artifacts are not writable after the run, so hashing them is a source the
 * release surface cannot forge.
 *
 * @param collect (artifactNames) => Map<assetName, sha256> read from the run's artifacts
 */
function runArtifactDigestFailures(expectedDownloads, collect, artifactNames) {
  const digests = collect(artifactNames);
  if (!(digests instanceof Map) || digests.size === 0) {
    return ["the referenced workflow run's evaluation artifacts could not be read."];
  }
  return expectedDownloads.flatMap((expected) => {
    const produced = digests.get(expected.assetName);
    if (produced === undefined) {
      return [`${expected.assetName} is not among the artifacts the referenced run produced.`];
    }
    return produced === expected.expectedSha256
      ? []
      : [`${expected.assetName} does not match the bytes the referenced run produced.`];
  });
}

/**
 * Every file in a downloaded artifact, whether gh placed it at the root or one level deeper.
 * Nested files keep their directory in the key: two artifacts can legitimately contain a file of
 * the same name, and a name-only key would let the later one silently overwrite the earlier one's
 * digest, so the map could answer with the wrong artifact's bytes (KfQ finding on #3054).
 */
function artifactFiles(root, prefix = "", depth = 1) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile()) found.push([`${prefix}${entry.name}`, path]);
    else if (entry.isDirectory() && depth > 0) {
      found.push(...artifactFiles(path, `${prefix}${entry.name}/`, depth - 1));
    }
  }
  return found;
}

/**
 * SHA-256 of every file inside the referenced run's evaluation staging artifacts. Workflow-run
 * artifacts cannot be rewritten after the run, which is exactly why the digests are taken from
 * there rather than from a manifest sitting next to the assets being verified.
 *
 * An empty map means "unreadable", and the caller treats that as a refusal — never as an absent
 * objection.
 */
export function collectEvaluationArtifactDigests({ gh, hashFile }, runId, artifactNames) {
  const root = mkdtempSync(join(tmpdir(), "keiko-run-artifacts-"));
  const digests = new Map();
  try {
    for (const artifactName of artifactNames) {
      const target = join(root, artifactName);
      mkdirSync(target, { recursive: true });
      const args = ["run", "download", String(runId), "--name", artifactName, "--dir", target];
      if (gh(args)?.status !== 0) return new Map();
      for (const [key, path] of artifactFiles(target)) {
        // The published downloads are matched by bare file name, so that is the key. A repeated
        // name inside one run is ambiguous evidence, not something to resolve by last-write-wins.
        const name = key.slice(key.lastIndexOf("/") + 1);
        const digest = hashFile(path);
        const previous = digests.get(name);
        if (previous !== undefined && previous !== digest) return new Map();
        digests.set(name, digest);
      }
    }
    return digests;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
