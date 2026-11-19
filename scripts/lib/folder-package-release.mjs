/**
 * The folder packages a stable release carries beside its portable archives (ADR-0121 D9).
 *
 * The stable-tag build turns the archive it has just assembled for each desktop target into that
 * target's standalone folder package. The publisher uploads, verifies and publishes it with the
 * same draft as the archives. A folder package is a download for people, never an update
 * candidate: it carries no release-trust signature of its own, and its build provenance is
 * attested with the archives.
 *
 * The names keep a dot before the form (`keiko-<target>.standalone.zip`). Every shipped updater
 * requires the `keiko-*.zip` names that match FIRST_CLASS_ARCHIVE_NAME to be exactly the portable
 * archives, so an asset named `keiko-<target>-standalone.zip` would stop every installed Keiko
 * from updating to the release that carries it.
 */

import { Buffer } from "node:buffer";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

import { sha256, sha256FileChunked } from "./digest.mjs";

/** The release asset names that shipped updaters read as portable archives. */
export const FIRST_CLASS_ARCHIVE_NAME = /^keiko-[a-z0-9-]+\.zip$/u;

/** The desktop targets that get a folder package; Linux is a community tier (ADR-0183). */
export const FOLDER_RELEASE_TARGETS = Object.freeze(["macos-arm64", "macos-x64", "windows-x64"]);
const FOLDER_RELEASE_TARGET_SET = new Set(FOLDER_RELEASE_TARGETS);

/** Where the stable-tag build puts the folder packages inside the portable asset bundle. */
export const FOLDER_PACKAGES_DIRECTORY = "folder-packages";
export const FOLDER_PACKAGES_MANIFEST = "folder-packages.json";

const FORMS = new Set(["standalone", "npm"]);
/** The manifest names three packages; anything near this size is not one the build wrote. */
export const FOLDER_PACKAGES_MANIFEST_MAX_BYTES = 64 * 1024;
/**
 * GitHub accepts release assets under 2 GiB. A package declared at or above that size is refused
 * before any of it is read, whatever its manifest says.
 */
export const FOLDER_PACKAGE_MAX_BYTES = 2 * 1024 ** 3 - 1;
/** How the check reads files; tests replace it to prove what is never read. */
const FILE_READS = Object.freeze({
  digest: (path, maxBytes) => sha256FileChunked(path, maxBytes),
  text: (path) => readFileSync(path, "utf8"),
});
const SHA256_HEX = /^[a-f0-9]{64}$/u;

/** The file name of a folder package: `keiko-<target>.<form>.zip`, `-team` when it holds access. */
export function folderPackageArchiveName(target, form, provisioned = false) {
  if (!FORMS.has(form)) throw new TypeError(`unknown folder package form ${String(form)}`);
  return `keiko-${target}.${form}${provisioned ? "-team" : ""}.zip`;
}

/** The text of the `.sha256` file beside a package, in the format `shasum -a 256 -c` reads. */
export function folderChecksumText(sha256Hex, assetName) {
  return `${sha256Hex}  ${assetName}\n`;
}

/** The manifest the stable-tag build writes beside the packages it built. */
export function folderPackagesManifest(version, packages) {
  return { schemaVersion: 1, kind: "keiko-folder-packages", version, packages };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readManifest(path, failures, reads) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      failures.push(`${FOLDER_PACKAGES_MANIFEST} must be a regular file.`);
      return undefined;
    }
    // Checked before reading, so an oversized file is never loaded.
    if (stat.size > FOLDER_PACKAGES_MANIFEST_MAX_BYTES) {
      failures.push(
        `${FOLDER_PACKAGES_MANIFEST} is larger than ${String(FOLDER_PACKAGES_MANIFEST_MAX_BYTES)} bytes.`,
      );
      return undefined;
    }
    return JSON.parse(reads.text(path));
  } catch {
    failures.push(`the portable asset bundle carries no readable ${FOLDER_PACKAGES_MANIFEST}.`);
    return undefined;
  }
}

function manifestHeaderFailures(manifest, version) {
  if (!isRecord(manifest)) return [`${FOLDER_PACKAGES_MANIFEST} must be an object.`];
  const failures = [];
  if (manifest.schemaVersion !== 1) failures.push("folder package schemaVersion must be 1.");
  if (manifest.kind !== "keiko-folder-packages") failures.push("folder package kind is wrong.");
  if (manifest.version !== version) failures.push(`folder packages must be of Keiko ${version}.`);
  if (!Array.isArray(manifest.packages)) failures.push("folder packages must be an array.");
  return failures;
}

function contained(root, path) {
  return path.startsWith(`${root}${sep}`);
}

/** The real folder package directory of a bundle, or undefined when it is absent or a link. */
function packageDirectory(bundleRoot) {
  const path = join(bundleRoot, FOLDER_PACKAGES_DIRECTORY);
  try {
    return lstatSync(path).isDirectory() ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/** A regular file directly in the folder package directory, or undefined with a failure. */
function packageFile(directory, name, failures) {
  const path = join(directory, name);
  try {
    if (lstatSync(path).isFile() && contained(directory, realpathSync(path))) return path;
  } catch {
    // Reported below: a missing file and a link are refused alike.
  }
  failures.push(`${name} must be a regular file in ${FOLDER_PACKAGES_DIRECTORY}.`);
  return undefined;
}

function entryFailures(entry, archive) {
  const target = entry.platformTarget;
  const name = folderPackageArchiveName(target, "standalone");
  const checks = [
    [entry.form === "standalone", "must be a standalone folder package"],
    [entry.assetName === name, `must be named ${name}`],
    [!FIRST_CLASS_ARCHIVE_NAME.test(String(entry.assetName)), "must not look like an archive"],
    [SHA256_HEX.test(String(entry.sha256)), "must name its sha256"],
    [Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes > 0, "must name its size"],
    [
      // A size that is no number fails the check above; only a number larger than the limit here.
      typeof entry.sizeBytes !== "number" || entry.sizeBytes <= FOLDER_PACKAGE_MAX_BYTES,
      `must be smaller than the ${String(FOLDER_PACKAGE_MAX_BYTES + 1)} bytes GitHub accepts`,
    ],
    [entry.sourceArchive?.assetName === archive.assetName, "must name its source archive"],
    [entry.sourceArchive?.sha256 === archive.sha256, "must be built from this release's archive"],
  ];
  return checks.flatMap(([valid, message]) =>
    valid ? [] : [`${target} folder package ${message}.`],
  );
}

function fileFailures(entry, zipPath, reads) {
  // The size is compared first, so a package of another size, or of a size GitHub refuses, is never
  // read. A package of the declared size is hashed in chunks, and never beyond that size: one that
  // grew after the comparison fails the digest without being read to its end.
  const size = lstatSync(zipPath).size;
  if (
    size === entry.sizeBytes &&
    size <= FOLDER_PACKAGE_MAX_BYTES &&
    reads.digest(zipPath, entry.sizeBytes) === entry.sha256
  ) {
    return [];
  }
  return [`${entry.assetName} does not have the digest and size its manifest declares.`];
}

/** The checksum file holds exactly `text`; one of another size is refused without reading it. */
function checksumMatches(checksumPath, text, reads) {
  return (
    lstatSync(checksumPath).size === Buffer.byteLength(text) && reads.text(checksumPath) === text
  );
}

function packageUpload(directory, entry, failures, reads) {
  const zipPath = packageFile(directory, entry.assetName, failures);
  const checksumName = `${entry.assetName}.sha256`;
  const checksumPath = packageFile(directory, checksumName, failures);
  if (zipPath === undefined || checksumPath === undefined) return [];
  failures.push(...fileFailures(entry, zipPath, reads));
  const checksumText = folderChecksumText(entry.sha256, entry.assetName);
  if (!checksumMatches(checksumPath, checksumText, reads)) {
    failures.push(`${checksumName} must bind ${entry.assetName}.`);
  }
  // The stable-tag workflow attests each package's build provenance; its `.sha256` file is text
  // derived from the attested digest and checked above.
  return [
    {
      path: zipPath,
      assetName: entry.assetName,
      sha256: entry.sha256,
      size: entry.sizeBytes,
      attested: true,
    },
    {
      path: checksumPath,
      assetName: checksumName,
      sha256: sha256(checksumText),
      size: Buffer.byteLength(checksumText),
      attested: false,
    },
  ];
}

function targetEntries(packages, failures) {
  const byTarget = new Map();
  for (const entry of packages) {
    const target = isRecord(entry) ? entry.platformTarget : undefined;
    if (!FOLDER_RELEASE_TARGET_SET.has(target) || byTarget.has(target)) {
      failures.push(`folder package target ${String(target)} is unknown or repeated.`);
      continue;
    }
    byTarget.set(target, entry);
  }
  for (const target of FOLDER_RELEASE_TARGETS) {
    if (!byTarget.has(target)) failures.push(`the folder package of ${target} is missing.`);
  }
  return byTarget;
}

/**
 * The folder packages of a portable asset bundle, checked for upload.
 *
 * `archives` maps each target to the release archive (`{ assetName, sha256 }`) its package must
 * have been built from. Returns `{ failures, uploads }`; an upload names its local path, its
 * asset name and the digest and size GitHub must report for it.
 */
export function folderPackageUploads({ bundleRoot, version, archives, reads = FILE_READS }) {
  const failures = [];
  const directory = packageDirectory(bundleRoot);
  if (directory === undefined) {
    return { failures: ["the portable asset bundle carries no folder packages."], uploads: [] };
  }
  const manifest = readManifest(join(directory, FOLDER_PACKAGES_MANIFEST), failures, reads);
  if (manifest === undefined) return { failures, uploads: [] };
  failures.push(...manifestHeaderFailures(manifest, version));
  if (failures.length > 0) return { failures, uploads: [] };
  const uploads = [];
  for (const [target, entry] of targetEntries(manifest.packages, failures)) {
    const archive = archives.get(target);
    if (archive === undefined) {
      failures.push(`the portable asset bundle carries no archive of ${target}.`);
      continue;
    }
    const before = failures.length;
    failures.push(...entryFailures(entry, archive));
    if (failures.length === before) {
      uploads.push(...packageUpload(directory, entry, failures, reads));
    }
  }
  return { failures, uploads };
}
