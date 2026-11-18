#!/usr/bin/env node

/**
 * Builds the folder packages a stable release carries beside its portable archives (ADR-0121 D9).
 *
 * The stable-tag workflow runs this right after it assembled the portable asset bundle. For every
 * desktop target it builds the standalone folder package from that bundle's archive, checked
 * against the archive's own checksum evidence and its manifest, and writes the package, its
 * `.sha256` file and folder-packages.json into `<bundle-root>/folder-packages`. The publisher
 * uploads exactly what that manifest names (scripts/lib/folder-package-release.mjs).
 *
 * The packages are generic: they carry no `keiko.config.json` and no access of any kind.
 */

import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

import {
  StandaloneBuildError,
  buildStandalonePackage,
  expectedArchiveSha256,
} from "./build-standalone-package.mjs";
import {
  FOLDER_PACKAGES_DIRECTORY,
  FOLDER_PACKAGES_MANIFEST,
  FOLDER_RELEASE_TARGETS,
  folderPackagesManifest,
} from "./lib/folder-package-release.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { readJsonFile } from "./lib/json.mjs";

const USAGE = `Usage:
  node scripts/build-folder-release-assets.mjs --bundle-root DIR --version VERSION

Builds the standalone folder package of macos-arm64, macos-x64 and windows-x64 from the portable
asset bundle in DIR and writes them to DIR/${FOLDER_PACKAGES_DIRECTORY}.`;

export class FolderReleaseBuildError extends Error {}

function refuse(message) {
  throw new FolderReleaseBuildError(message);
}

/** Parses `--bundle-root DIR --version VERSION`; anything else is refused. */
export function parseFolderReleaseArgs(argv) {
  const flags = { "--bundle-root": "bundleRoot", "--version": "version" };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = flags[argv[index]];
    const value = argv[index + 1];
    if (name === undefined) refuse(`unknown argument ${String(argv[index])}`);
    if (value === undefined || value.startsWith("--")) refuse(`${argv[index]} needs a value`);
    options[name] = value;
  }
  if (options.bundleRoot === undefined) refuse("--bundle-root is required");
  if (options.version === undefined) refuse("--version is required");
  return options;
}

// A file the bundle names: inside it and a regular file, never a link, like the publisher reads
// the packages.
function containedPath(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) refuse(`${label} is missing`);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`)) refuse(`${label} must stay inside the bundle`);
  if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
    refuse(`${label} must name a regular file in the bundle`);
  }
  return path;
}

/** The archive of one target and the digest its bundle evidence binds it to. */
function bundleArchive(bundleRoot, bundle, target) {
  const entry = bundle.artifacts.find((artifact) => artifact?.platformTarget === target);
  if (entry === undefined) refuse(`the portable asset bundle carries no archive of ${target}`);
  const archive = containedPath(bundleRoot, entry.archivePath, `${target} archivePath`);
  const manifestPath = containedPath(bundleRoot, entry.manifestPath, `${target} manifestPath`);
  const manifest = readJsonFile(manifestPath);
  const targetRoot = dirname(dirname(manifestPath));
  const sha256sums = containedPath(
    targetRoot,
    manifest.evidence?.checksumsPath,
    `${target} checksumsPath`,
  );
  const sha256 = expectedArchiveSha256({ sha256sums }, archive);
  if (sha256 !== manifest.artifact?.sha256) {
    refuse(`the checksum evidence of ${target} does not match its manifest`);
  }
  return { archive, sha256 };
}

function buildTarget(bundleRoot, bundle, target, options) {
  const { archive, sha256 } = bundleArchive(bundleRoot, bundle, target);
  const result = buildStandalonePackage({ target, archive, sha256, outDir: options.outDir });
  if (result.packageVersion !== options.version) {
    refuse(`the ${target} archive holds Keiko ${result.packageVersion}, not ${options.version}`);
  }
  return {
    platformTarget: target,
    form: "standalone",
    assetName: basename(result.outputPath),
    sha256: result.outputSha256,
    sizeBytes: statSync(result.outputPath).size,
    sourceArchive: { assetName: basename(archive), sha256 },
  };
}

/** Builds every folder package of the bundle and returns the manifest it wrote. */
export function buildFolderReleaseAssets(options) {
  const bundleRoot = resolve(options.bundleRoot);
  const outDir = resolve(bundleRoot, FOLDER_PACKAGES_DIRECTORY);
  if (existsSync(outDir)) refuse(`${outDir} already exists; folder packages are built once`);
  const bundle = readJsonFile(resolve(bundleRoot, "portable-assets.json"));
  if (!Array.isArray(bundle?.artifacts)) refuse("portable-assets.json names no artifacts");
  mkdirSync(outDir);
  const packages = FOLDER_RELEASE_TARGETS.map((target) =>
    buildTarget(bundleRoot, bundle, target, { outDir, version: options.version }),
  );
  const manifest = folderPackagesManifest(options.version, packages);
  writeFileSync(
    resolve(outDir, FOLDER_PACKAGES_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const manifest = buildFolderReleaseAssets(parseFolderReleaseArgs(argv));
    for (const entry of manifest.packages) {
      console.log(`PASS folder package ${entry.assetName} sha256 ${entry.sha256}`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof FolderReleaseBuildError || error instanceof StandaloneBuildError)) {
      throw error;
    }
    console.error(`FAIL build-folder-release-assets: ${error.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
