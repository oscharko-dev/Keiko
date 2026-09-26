import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { isPortableExecutableFile } from "./portable-executable.mjs";
import { WINDOWS_PORTABLE_SETUP_ASSET_NAME } from "../portable-runtime.mjs";

const MAX_SETUP_BYTES = 2 * 1024 * 1024 * 1024;
const WINDOWS_PORTABLE_TARGET = "windows-x64";

export function normalizePortableSetupCompanion({ baseDir, entry, platformTarget, stageRoot }) {
  const failures = [];
  const value = entry.setupPath;
  if (platformTarget !== WINDOWS_PORTABLE_TARGET) {
    if (value !== undefined)
      failures.push(`${platformTarget}.setupPath is only supported for windows-x64.`);
    return { failures, setupPath: undefined };
  }
  if (typeof value !== "string" || value.length === 0) {
    return {
      failures: [`${platformTarget}.setupPath must be a non-empty string.`],
      setupPath: undefined,
    };
  }
  const setupPath = resolve(baseDir, value);
  validateSetupPath(setupPath, stageRoot, platformTarget, failures);
  if (failures.length === 0) validateSetupBinding(entry, setupPath, platformTarget, failures);
  return { failures, setupPath: failures.length === 0 ? setupPath : undefined };
}

function validateSetupBinding(entry, setupPath, platformTarget, failures) {
  const upload = portableSetupCompanionUpload(setupPath);
  if (entry.setupSha256 !== upload.expectedSha256) {
    failures.push(`${platformTarget}.setupSha256 must match the setup companion bytes.`);
  }
  if (entry.setupSizeBytes !== upload.expectedSize) {
    failures.push(`${platformTarget}.setupSizeBytes must match the setup companion size.`);
  }
}

function validateSetupPath(path, stageRoot, platformTarget, failures) {
  const label = `${platformTarget}.setupPath`;
  if (!isRegularContainedFile(path, stageRoot, label, failures)) return;
  if (basename(path) !== WINDOWS_PORTABLE_SETUP_ASSET_NAME) {
    failures.push(`${label} must be named ${WINDOWS_PORTABLE_SETUP_ASSET_NAME}.`);
  }
  if (!isPortableExecutableFile(path)) failures.push(`${label} must point to a PE file.`);
}

function isRegularContainedFile(path, stageRoot, label, failures) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) failures.push(`${label} must not be a symbolic link.`);
    else if (!stat.isFile()) failures.push(`${label} must point to a regular file.`);
    else if (stat.nlink !== 1) failures.push(`${label} must not be hard linked.`);
    else if (stat.size <= 0) failures.push(`${label} must not be empty.`);
    else if (stat.size > MAX_SETUP_BYTES) failures.push(`${label} exceeds its bounded size.`);
    else if (!isContained(stageRoot, path))
      failures.push(`${label} must stay within the portable stage root.`);
    else return true;
  } catch {
    failures.push(`${label} does not exist.`);
  }
  return false;
}

function isContained(root, path) {
  const rootRealPath = realpathSync(root);
  const pathRealPath = realpathSync(path);
  const relativePath = relative(rootRealPath, pathRealPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function portableSetupCompanionRecord(record, setupPath) {
  if (setupPath === undefined) return record;
  return { ...record, setupAssetName: WINDOWS_PORTABLE_SETUP_ASSET_NAME, setupPath };
}

export function portableSetupCompanionUpload(setupPath) {
  return {
    assetName: WINDOWS_PORTABLE_SETUP_ASSET_NAME,
    expectedSha256: sha256FileSync(setupPath),
    expectedSize: statSync(setupPath).size,
  };
}

// Release upload planning is synchronous, so it cannot reuse portable-runtime's async digest.
function sha256FileSync(path) {
  const descriptor = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
}
