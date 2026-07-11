import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const bundleRootName = ".portable-release-assets";
export const PORTABLE_ASSETS_ARTIFACT_NAME = "portable-release-assets";
const PORTABLE_ASSETS_WORKFLOW_PATH = ".github/workflows/portable-assets.yml";

function fail(message) {
  throw new Error(`release-portable-assets: ${message}`);
}

function containedPath(root, path) {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(normalizedRoot);
}

function requiredBundleRoot(cwd) {
  const root = resolve(cwd, bundleRootName);
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) fail("portable asset bundle root must not be a symbolic link.");
  if (!stat.isDirectory()) fail("portable asset bundle root must be a directory.");
  return realpathSync(root);
}

function relativeManifestPath(value) {
  const candidate = value === "" ? "portable-assets.json" : value;
  const segments = candidate.split(/[\\/]+/u);
  if (isAbsolute(candidate)) {
    fail("portable_assets_manifest must be relative to the downloaded artifact.");
  }
  if (segments.includes("..")) {
    fail("portable_assets_manifest must not escape the downloaded artifact.");
  }
  return candidate;
}

function validateBundleManifestPath(manifestInput, cwd) {
  const root = requiredBundleRoot(cwd);
  const candidate = resolve(root, relativeManifestPath(manifestInput));
  if (!containedPath(root, candidate)) {
    fail("portable_assets_manifest must not escape the downloaded artifact.");
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) fail("portable_assets_manifest must not be a symbolic link.");
  if (!stat.isFile()) fail("portable_assets_manifest must point to a regular file.");
  const realCandidate = realpathSync(candidate);
  if (!containedPath(root, realCandidate)) {
    fail("portable_assets_manifest must not escape the downloaded artifact.");
  }
  return realCandidate;
}

function stringEnv(env, key) {
  const value = env[key];
  return typeof value === "string" ? value : "";
}

function portableAssetsConfig(env) {
  return {
    artifactName: stringEnv(env, "PORTABLE_ASSETS_ARTIFACT_NAME"),
    manifest: stringEnv(env, "PORTABLE_ASSETS_MANIFEST"),
    repository: stringEnv(env, "GITHUB_REPOSITORY"),
    runAttempt: stringEnv(env, "PORTABLE_ASSETS_RUN_ATTEMPT"),
    runId: stringEnv(env, "PORTABLE_ASSETS_RUN_ID"),
    sha: stringEnv(env, "GITHUB_SHA"),
    tag: stringEnv(env, "NPM_DIST_TAG"),
    releaseTag: stringEnv(env, "RELEASE_TAG"),
  };
}

function hasBundleInput(config) {
  return config.runId !== "" || config.artifactName !== "";
}

function validateBundleInputCompleteness(config) {
  if ((config.runId === "") !== (config.artifactName === "")) {
    fail("portable_assets_run_id and portable_assets_artifact_name must be provided together.");
  }
  if (hasBundleInput(config) && config.runAttempt === "") {
    fail("portable_assets_run_attempt is required with the reviewed portable asset bundle.");
  }
  if (hasBundleInput(config) && config.artifactName !== PORTABLE_ASSETS_ARTIFACT_NAME) {
    fail(`portable_assets_artifact_name must be ${PORTABLE_ASSETS_ARTIFACT_NAME}.`);
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer.`);
  return parsed;
}

function field(value, ...keys) {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function runSnapshotFailures(config, run, runId, runAttempt) {
  const rawPath = field(run, "path");
  const path = typeof rawPath === "string" ? rawPath.split("@")[0] : "";
  const checks = [
    [field(run, "id"), runId, "run id"],
    [field(run, "run_attempt"), runAttempt, "run attempt"],
    [field(run, "repository", "full_name"), config.repository, "repository"],
    [field(run, "head_sha"), config.sha, "head SHA"],
    [field(run, "head_branch"), config.releaseTag, "stable tag"],
    [field(run, "event"), "push", "event"],
    [field(run, "conclusion"), "success", "conclusion"],
    [field(run, "status"), "completed", "status"],
    [path, PORTABLE_ASSETS_WORKFLOW_PATH, "workflow path"],
  ];
  return checks.flatMap(([actual, expected, label]) =>
    actual === expected ? [] : [`${label} does not match`],
  );
}

function canonicalArtifact(artifacts, runId, failures) {
  const entries = field(artifacts, "artifacts");
  const matches = Array.isArray(entries)
    ? entries.filter((artifact) => field(artifact, "name") === PORTABLE_ASSETS_ARTIFACT_NAME)
    : [];
  if (matches.length !== 1)
    failures.push("exactly one canonical portable asset artifact is required");
  const artifact = matches[0];
  if (field(artifact, "expired") !== false)
    failures.push("canonical portable asset artifact is expired");
  const artifactId = field(artifact, "id");
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0)
    failures.push("canonical portable asset id is invalid");
  const artifactRunId = field(artifact, "workflow_run", "id");
  if (artifactRunId !== undefined && artifactRunId !== runId)
    failures.push("artifact run binding does not match");
  return artifact;
}

export function validatePortableAssetsRunSnapshot(config, run, artifacts) {
  const runId = positiveInteger(config.runId, "portable_assets_run_id");
  const runAttempt = positiveInteger(config.runAttempt, "portable_assets_run_attempt");
  const failures = runSnapshotFailures(config, run, runId, runAttempt);
  const artifact = canonicalArtifact(artifacts, runId, failures);
  if (failures.length > 0)
    fail(`reviewed portable asset run is invalid:\n  - ${failures.join("\n  - ")}`);
  return { artifactId: field(artifact, "id"), runAttempt };
}

function ghJson(path) {
  const result = spawnSync("gh", ["api", path], { encoding: "utf8" });
  if (result.status !== 0) fail("GitHub run metadata could not be resolved.");
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("GitHub run metadata was invalid.");
  }
}

export function validatePortableAssetsRun(env = process.env) {
  const config = portableAssetsConfig(env);
  validateBundleInputCompleteness(config);
  const runId = positiveInteger(config.runId, "portable_assets_run_id");
  if (config.repository === "" || config.sha === "" || config.releaseTag === "") {
    fail("repository, release tag, and head SHA are required for run resolution.");
  }
  return validatePortableAssetsRunSnapshot(
    config,
    ghJson(`repos/${config.repository}/actions/runs/${String(runId)}`),
    ghJson(
      `repos/${config.repository}/actions/runs/${String(runId)}/artifacts?name=${PORTABLE_ASSETS_ARTIFACT_NAME}&per_page=2`,
    ),
  );
}

function validateStableLatestBundleRequirement(config) {
  if (config.tag === "latest" && !hasBundleInput(config)) {
    fail("stable latest publishes require a reviewed portable asset bundle.");
  }
}

export function resolvePortableAssetsManifest(env = process.env, cwd = process.cwd()) {
  const config = portableAssetsConfig(env);
  validateBundleInputCompleteness(config);
  validateStableLatestBundleRequirement(config);
  if (!hasBundleInput(config)) return config.manifest;

  return validateBundleManifestPath(config.manifest, cwd);
}

export function writeGithubOutput(manifest, env = process.env) {
  if (env.GITHUB_OUTPUT === undefined || env.GITHUB_OUTPUT === "") {
    console.log(`manifest=${manifest}`);
    return;
  }
  appendFileSync(env.GITHUB_OUTPUT, `manifest=${manifest}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--validate-run")) {
      const result = validatePortableAssetsRun();
      writeGithubOutput(String(result.artifactId));
    } else {
      writeGithubOutput(resolvePortableAssetsManifest());
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
