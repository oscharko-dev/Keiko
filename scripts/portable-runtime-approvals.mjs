import { readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";

import { PORTABLE_TARGET_NAMES } from "./portable-runtime.mjs";

export const PORTABLE_RUNTIME_APPROVALS_FILE = "portable-runtime-approvals.json";
export const APPROVED_NODE_ARCHIVE_HOSTS = Object.freeze(["nodejs.org", "dist.nodejs.org"]);
export const APPROVED_SIDECAR_ARCHIVE_HOSTS = Object.freeze([
  "github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const SIDECAR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

class ApprovalsError extends Error {}

function fail(message) {
  throw new ApprovalsError(`portable-runtime-approvals: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record, key, context) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredRecord(record, key, context) {
  const value = record[key];
  if (!isRecord(value)) fail(`${context}.${key} must be an object`);
  return value;
}

function validateSha256(value, context) {
  if (!SHA256_PATTERN.test(value)) fail(`${context} must be a 64-hex sha256 digest`);
  return value;
}

function validateVersion(value, context) {
  if (!VERSION_PATTERN.test(value)) fail(`${context} must be a semantic version`);
  return value;
}

function validateApprovedUrl(rawUrl, allowedHosts, context) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(`${context} must be a valid URL`);
  }
  if (url.protocol !== "https:") fail(`${context} must use https`);
  if (!allowedHosts.includes(url.hostname)) {
    fail(`${context} host ${url.hostname} is not an approved host`);
  }
  if (url.username !== "" || url.password !== "") fail(`${context} must not embed credentials`);
  return url.toString();
}

function validateArchiveEntry(entry, allowedHosts, context) {
  if (!isRecord(entry)) fail(`${context} must be an object`);
  return {
    url: validateApprovedUrl(requiredString(entry, "url", context), allowedHosts, `${context}.url`),
    sha256: validateSha256(requiredString(entry, "sha256", context), `${context}.sha256`),
  };
}

function validateArchivesByTarget(record, key, allowedHosts, context, extra) {
  const archives = requiredRecord(record, key, context);
  const known = new Set(PORTABLE_TARGET_NAMES);
  for (const target of Object.keys(archives)) {
    if (!known.has(target)) fail(`${context}.${key} has unknown target ${target}`);
  }
  const result = {};
  for (const target of PORTABLE_TARGET_NAMES) {
    const entry = archives[target];
    if (entry === undefined) fail(`${context}.${key} is missing target ${target}`);
    result[target] = {
      ...validateArchiveEntry(entry, allowedHosts, `${context}.${key}.${target}`),
      ...(extra === undefined ? {} : extra(entry, `${context}.${key}.${target}`)),
    };
  }
  return result;
}

function validateSidecarArchiveExtras(entry, context) {
  const sizeBytes = entry.sizeBytes;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_ARCHIVE_BYTES
  ) {
    fail(`${context}.sizeBytes must be a positive safe integer within limits`);
  }
  const executableName = requiredString(entry, "executableName", context);
  if (!EXECUTABLE_NAME_PATTERN.test(executableName) || executableName.includes("..")) {
    fail(`${context}.executableName must be a plain file name`);
  }
  return { sizeBytes, executableName };
}

function validateNodeSection(approvals) {
  const node = requiredRecord(approvals, "node", "approvals");
  const version = validateVersion(
    requiredString(node, "version", "approvals.node"),
    "approvals.node.version",
  );
  const archives = validateArchivesByTarget(
    node,
    "archives",
    APPROVED_NODE_ARCHIVE_HOSTS,
    "approvals.node",
  );
  for (const target of PORTABLE_TARGET_NAMES) {
    const url = archives[target].url;
    if (!url.includes(`v${version}`)) {
      fail(`approvals.node.archives.${target}.url must reference version v${version}`);
    }
  }
  return { version, archives };
}

function validateSidecarLicense(runtime, context) {
  const license = requiredRecord(runtime, "license", context);
  return {
    spdxId: requiredString(license, "spdxId", `${context}.license`),
    url: validateApprovedUrl(
      requiredString(license, "url", `${context}.license`),
      APPROVED_SIDECAR_ARCHIVE_HOSTS,
      `${context}.license.url`,
    ),
    sha256: validateSha256(
      requiredString(license, "sha256", `${context}.license`),
      `${context}.license.sha256`,
    ),
  };
}

function validateSidecarRuntime(runtime, index, names) {
  const context = `approvals.sidecarRuntimes[${String(index)}]`;
  if (!isRecord(runtime)) fail(`${context} must be an object`);
  const name = requiredString(runtime, "name", context);
  if (!SIDECAR_NAME_PATTERN.test(name)) fail(`${context}.name must be kebab-case`);
  if (names.has(name)) fail(`${context}.name must be unique`);
  names.add(name);
  const upstream = requiredRecord(runtime, "upstream", context);
  const adapter = requiredRecord(runtime, "adapterCompatibility", context);
  return {
    name,
    kind: requiredString(runtime, "kind", context),
    upstream: {
      name: requiredString(upstream, "name", `${context}.upstream`),
      version: validateVersion(
        requiredString(upstream, "version", `${context}.upstream`),
        `${context}.upstream.version`,
      ),
    },
    adapterCompatibility: {
      adapterName: requiredString(adapter, "adapterName", `${context}.adapterCompatibility`),
      adapterVersion: requiredString(adapter, "adapterVersion", `${context}.adapterCompatibility`),
      protocolVersion: requiredString(
        adapter,
        "protocolVersion",
        `${context}.adapterCompatibility`,
      ),
    },
    license: validateSidecarLicense(runtime, context),
    archives: validateArchivesByTarget(
      runtime,
      "archives",
      APPROVED_SIDECAR_ARCHIVE_HOSTS,
      context,
      validateSidecarArchiveExtras,
    ),
  };
}

export function validatePortableRuntimeApprovals(approvals) {
  if (!isRecord(approvals)) fail("approvals document must be an object");
  if (approvals.schemaVersion !== 1) fail("approvals.schemaVersion must be 1");
  const rawSidecars = approvals.sidecarRuntimes;
  if (!Array.isArray(rawSidecars)) fail("approvals.sidecarRuntimes must be an array");
  const names = new Set();
  return {
    schemaVersion: 1,
    node: validateNodeSection(approvals),
    sidecarRuntimes: rawSidecars.map((runtime, index) =>
      validateSidecarRuntime(runtime, index, names),
    ),
  };
}

export function loadPortableRuntimeApprovals(repoRoot) {
  const path = join(repoRoot, PORTABLE_RUNTIME_APPROVALS_FILE);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`approvals file is missing at ${PORTABLE_RUNTIME_APPROVALS_FILE}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("approvals file is not valid JSON");
  }
  return validatePortableRuntimeApprovals(parsed);
}

export function approvedNodeStageArguments(approvals, target) {
  const archive = approvals.node.archives[target];
  if (archive === undefined) fail(`no approved node archive for target ${target}`);
  return {
    nodeVersion: approvals.node.version,
    nodeArchiveUrl: archive.url,
    nodeArchiveSha256: archive.sha256,
  };
}
