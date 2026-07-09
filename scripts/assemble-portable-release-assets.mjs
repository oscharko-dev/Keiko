import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PORTABLE_TARGETS, sha256File, validatePortableManifest } from "./portable-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_MANIFEST_NAME = "portable-assets.json";

function fail(message) {
  throw new Error(`assemble-portable-release-assets: ${message}`);
}

function parseArgs(argv) {
  const options = {
    bundleRoot: join(repoRoot, ".portable-release-assets"),
    stagePrefix: "portable-stage-",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
    if (arg === "--bundle-root") options.bundleRoot = resolve(value);
    else if (arg === "--stage-prefix") options.stagePrefix = value;
    else fail(`unsupported argument ${arg}`);
    index += 1;
  }
  return options;
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`missing ${label}`);
  return path;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`missing ${label}`);
  return path;
}

async function assembleTarget(options, target) {
  const downloaded = requireDirectory(
    join(options.bundleRoot, "artifacts", `${options.stagePrefix}${target.platformTarget}`),
    `${target.platformTarget} downloaded stage artifact`,
  );
  const archivePath = requireFile(
    join(downloaded, target.assetName),
    `${target.platformTarget} archive`,
  );
  const manifestPath = requireFile(
    join(downloaded, "manifest", "portable-manifest.json"),
    `${target.platformTarget} portable manifest`,
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestFailures = validatePortableManifest(manifest, { allowUnverified: true });
  if (manifestFailures.length > 0) {
    fail(`${target.platformTarget} manifest invalid:\n  - ${manifestFailures.join("\n  - ")}`);
  }
  const archiveSha256 = await sha256File(archivePath);
  if (manifest.artifact?.sha256 !== archiveSha256) {
    fail(`${target.platformTarget} archive digest does not match its portable manifest`);
  }
  const finalRoot = join(options.bundleRoot, "artifacts", target.platformTarget);
  cpSync(downloaded, finalRoot, { recursive: true });
  return {
    platformTarget: target.platformTarget,
    archivePath: `artifacts/${target.platformTarget}/${target.assetName}`,
    manifestPath: `artifacts/${target.platformTarget}/manifest/portable-manifest.json`,
  };
}

export async function assemblePortableReleaseAssets(argv) {
  const options = parseArgs(argv);
  requireDirectory(options.bundleRoot, "bundle root");
  requireDirectory(join(options.bundleRoot, "artifacts"), "artifacts root");
  const artifacts = [];
  for (const target of PORTABLE_TARGETS) {
    artifacts.push(await assembleTarget(options, target));
  }
  const manifest = { schemaVersion: 1, artifacts };
  writeFileSync(
    join(options.bundleRoot, BUNDLE_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assemblePortableReleaseAssets(process.argv.slice(2)).then(
    (manifest) => {
      console.log(
        `portable release asset bundle assembled: ${manifest.artifacts
          .map((artifact) => artifact.platformTarget)
          .join(", ")} (${BUNDLE_MANIFEST_NAME})`,
      );
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
