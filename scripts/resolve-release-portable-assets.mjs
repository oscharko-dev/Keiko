import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const bundleRootName = ".portable-release-assets";

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
    runId: stringEnv(env, "PORTABLE_ASSETS_RUN_ID"),
    tag: stringEnv(env, "NPM_DIST_TAG"),
  };
}

function hasBundleInput(config) {
  return config.runId !== "" || config.artifactName !== "";
}

function validateBundleInputCompleteness(config) {
  if ((config.runId === "") !== (config.artifactName === "")) {
    fail("portable_assets_run_id and portable_assets_artifact_name must be provided together.");
  }
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
    writeGithubOutput(resolvePortableAssetsManifest());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
