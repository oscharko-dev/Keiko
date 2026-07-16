import { readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";

import { PORTABLE_TARGET_NAMES } from "./portable-runtime.mjs";

export const PORTABLE_RUNTIME_APPROVALS_FILE = "portable-runtime-approvals.json";
export const APPROVED_NODE_ARCHIVE_HOSTS = Object.freeze(["nodejs.org", "dist.nodejs.org"]);
export const APPROVED_SIDECAR_ARCHIVE_HOSTS = Object.freeze([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
]);
export const EXECUTABLE_TREE_ALGORITHM = "keiko-directory-tree-sha256-v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SIDECAR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVIEW_REFERENCE_PATTERN =
  /^https:\/\/github\.com\/oscharko-dev\/Keiko\/(?:issues|pull)\/\d+$/u;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const OPENCODE_PIN = Object.freeze({
  owner: "anomalyco",
  repository: "opencode",
  name: "opencode",
  version: "1.17.17",
  tag: "v1.17.17",
  commit: "474abdd7ee60f4b67476cfcef7e5311beff4a824",
  schemaPath: "packages/sdk/openapi.json",
  schemaSha256: "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de",
});

class ApprovalsError extends Error {}

function fail(message) {
  throw new ApprovalsError(`portable-runtime-approvals: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record, expected, context) {
  if (!isRecord(record)) fail(`${context} must be an object`);
  const allowed = new Set(expected);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${context} has unknown key ${key}`);
  }
  for (const key of expected) {
    if (!(key in record)) fail(`${context} is missing key ${key}`);
  }
}

function requiredString(record, key, context) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context}.${key} must be a non-empty string`);
  }
  return value;
}

function validateLiteral(value, expected, context) {
  if (value !== expected) fail(`${context} must be ${expected}`);
  return value;
}

function validateSha256(value, context) {
  if (!SHA256_PATTERN.test(value)) fail(`${context} must be a lowercase 64-hex sha256 digest`);
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
  if (!allowedHosts.includes(url.hostname)) fail(`${context} host is not approved`);
  if (url.username !== "" || url.password !== "") fail(`${context} must not embed credentials`);
  if (url.search !== "" || url.hash !== "") fail(`${context} must not contain query or fragment`);
  return url.toString();
}

function validateArchiveEntry(entry, allowedHosts, context, sidecar) {
  const keys = sidecar
    ? ["url", "sha256", "sizeBytes", "executableName", "executableTreeSha256"]
    : ["url", "sha256"];
  exactKeys(entry, keys, context);
  const result = {
    url: validateApprovedUrl(requiredString(entry, "url", context), allowedHosts, `${context}.url`),
    sha256: validateSha256(requiredString(entry, "sha256", context), `${context}.sha256`),
  };
  if (!sidecar) return result;
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
  return {
    ...result,
    sizeBytes,
    executableName,
    executableTreeSha256: validateSha256(
      requiredString(entry, "executableTreeSha256", context),
      `${context}.executableTreeSha256`,
    ),
  };
}

function validateArchives(record, allowedHosts, context, sidecar = false) {
  exactKeys(record, PORTABLE_TARGET_NAMES, context);
  const result = {};
  for (const target of PORTABLE_TARGET_NAMES) {
    result[target] = validateArchiveEntry(
      record[target],
      allowedHosts,
      `${context}.${target}`,
      sidecar,
    );
  }
  return result;
}

function validateNodeSection(node) {
  const context = "approvals.node";
  exactKeys(node, ["version", "archives"], context);
  const version = requiredString(node, "version", context);
  if (!VERSION_PATTERN.test(version)) fail(`${context}.version must be a semantic version`);
  const archives = validateArchives(
    node.archives,
    APPROVED_NODE_ARCHIVE_HOSTS,
    `${context}.archives`,
  );
  for (const target of PORTABLE_TARGET_NAMES) {
    const expectedName =
      target === "windows-x64"
        ? "win-x64.zip"
        : `${target === "macos-arm64" ? "darwin-arm64" : "darwin-x64"}.tar.gz`;
    const expectedUrl = `https://nodejs.org/dist/v${version}/node-v${version}-${expectedName}`;
    validateLiteral(archives[target].url, expectedUrl, `${context}.archives.${target}.url`);
  }
  return { version, archives };
}

function validateUpstream(upstream, context) {
  exactKeys(upstream, ["owner", "repository", "name", "version", "tag", "commit"], context);
  const result = {};
  for (const key of ["owner", "repository", "name", "version", "tag", "commit"]) {
    result[key] = validateLiteral(
      requiredString(upstream, key, context),
      OPENCODE_PIN[key],
      `${context}.${key}`,
    );
  }
  if (!COMMIT_PATTERN.test(result.commit)) fail(`${context}.commit must be a full commit sha`);
  return result;
}

function validateProtocolSchema(schema, context) {
  const keys = [
    "path",
    "url",
    "sha256",
    "hashAlgorithm",
    "hashEncoding",
    "digestInput",
    "transport",
  ];
  exactKeys(schema, keys, context);
  const expectedUrl = `https://raw.githubusercontent.com/${OPENCODE_PIN.owner}/${OPENCODE_PIN.repository}/${OPENCODE_PIN.commit}/${OPENCODE_PIN.schemaPath}`;
  return {
    path: validateLiteral(
      requiredString(schema, "path", context),
      OPENCODE_PIN.schemaPath,
      `${context}.path`,
    ),
    url: validateLiteral(
      validateApprovedUrl(
        requiredString(schema, "url", context),
        APPROVED_SIDECAR_ARCHIVE_HOSTS,
        `${context}.url`,
      ),
      expectedUrl,
      `${context}.url`,
    ),
    sha256: validateLiteral(
      validateSha256(requiredString(schema, "sha256", context), `${context}.sha256`),
      OPENCODE_PIN.schemaSha256,
      `${context}.sha256`,
    ),
    hashAlgorithm: validateLiteral(schema.hashAlgorithm, "sha256", `${context}.hashAlgorithm`),
    hashEncoding: validateLiteral(schema.hashEncoding, "lowercase-hex", `${context}.hashEncoding`),
    digestInput: validateLiteral(
      schema.digestInput,
      "upstream-raw-bytes",
      `${context}.digestInput`,
    ),
    transport: validateLiteral(schema.transport, "http-sse", `${context}.transport`),
  };
}

function validateReleaseApproval(approval, context, expectedStatus) {
  exactKeys(approval, ["status", "reviewReference"], context);
  const status = validateLiteral(approval.status, expectedStatus, `${context}.status`);
  const reviewReference = requiredString(approval, "reviewReference", context);
  if (!REVIEW_REFERENCE_PATTERN.test(reviewReference)) {
    fail(`${context}.reviewReference must reference an oscharko-dev/Keiko issue or pull request`);
  }
  return { status, reviewReference };
}

function validateAdapter(adapter, context) {
  exactKeys(adapter, ["adapterName", "adapterVersion", "transport"], context);
  return {
    adapterName: validateLiteral(
      adapter.adapterName,
      "keiko-coding-sidecar",
      `${context}.adapterName`,
    ),
    adapterVersion: validateLiteral(adapter.adapterVersion, "1", `${context}.adapterVersion`),
    transport: validateLiteral(adapter.transport, "http-sse", `${context}.transport`),
  };
}

function validateReleaseApprovals(approval, context) {
  exactKeys(approval, ["redistribution", "subscriptionAuth"], context);
  return {
    redistribution: validateReleaseApproval(
      approval.redistribution,
      `${context}.redistribution`,
      "approved",
    ),
    subscriptionAuth: validateReleaseApproval(
      approval.subscriptionAuth,
      `${context}.subscriptionAuth`,
      "not-applicable",
    ),
  };
}

function validateLicense(license, context) {
  exactKeys(license, ["spdxId", "url", "sha256"], context);
  const expectedUrl = `https://raw.githubusercontent.com/anomalyco/opencode/${OPENCODE_PIN.commit}/LICENSE`;
  return {
    spdxId: validateLiteral(license.spdxId, "MIT", `${context}.spdxId`),
    url: validateLiteral(
      validateApprovedUrl(
        requiredString(license, "url", context),
        APPROVED_SIDECAR_ARCHIVE_HOSTS,
        `${context}.url`,
      ),
      expectedUrl,
      `${context}.url`,
    ),
    sha256: validateSha256(requiredString(license, "sha256", context), `${context}.sha256`),
  };
}

function validateSidecarArchives(rawArchives, context) {
  const archives = validateArchives(rawArchives, APPROVED_SIDECAR_ARCHIVE_HOSTS, context, true);
  for (const target of PORTABLE_TARGET_NAMES) {
    const asset =
      target === "windows-x64"
        ? "opencode-windows-x64.zip"
        : `opencode-${target === "macos-arm64" ? "darwin-arm64" : "darwin-x64"}.zip`;
    validateLiteral(
      archives[target].url,
      `https://github.com/anomalyco/opencode/releases/download/${OPENCODE_PIN.tag}/${asset}`,
      `${context}.${target}.url`,
    );
  }
  return archives;
}

function validateSidecarRuntime(runtime, index) {
  const context = `approvals.sidecarRuntimes[${String(index)}]`;
  exactKeys(
    runtime,
    [
      "name",
      "kind",
      "upstream",
      "adapterCompatibility",
      "protocolSchema",
      "releaseApproval",
      "license",
      "executableTreeAlgorithm",
      "archives",
    ],
    context,
  );
  const name = validateLiteral(
    requiredString(runtime, "name", context),
    "opencode-compatible",
    `${context}.name`,
  );
  if (!SIDECAR_NAME_PATTERN.test(name)) fail(`${context}.name must be kebab-case`);
  return {
    name,
    kind: validateLiteral(runtime.kind, "coding-runtime", `${context}.kind`),
    upstream: validateUpstream(runtime.upstream, `${context}.upstream`),
    adapterCompatibility: validateAdapter(
      runtime.adapterCompatibility,
      `${context}.adapterCompatibility`,
    ),
    protocolSchema: validateProtocolSchema(runtime.protocolSchema, `${context}.protocolSchema`),
    releaseApproval: validateReleaseApprovals(
      runtime.releaseApproval,
      `${context}.releaseApproval`,
    ),
    license: validateLicense(runtime.license, `${context}.license`),
    executableTreeAlgorithm: validateLiteral(
      runtime.executableTreeAlgorithm,
      EXECUTABLE_TREE_ALGORITHM,
      `${context}.executableTreeAlgorithm`,
    ),
    archives: validateSidecarArchives(runtime.archives, `${context}.archives`),
  };
}

export function validatePortableRuntimeApprovals(approvals) {
  exactKeys(approvals, ["schemaVersion", "description", "node", "sidecarRuntimes"], "approvals");
  validateLiteral(approvals.schemaVersion, 2, "approvals.schemaVersion");
  if (typeof approvals.description !== "string" || approvals.description.length === 0) {
    fail("approvals.description must be a non-empty string");
  }
  if (!Array.isArray(approvals.sidecarRuntimes)) fail("approvals.sidecarRuntimes must be an array");
  if (approvals.sidecarRuntimes.length !== 1) {
    fail(
      "approvals.sidecarRuntimes must contain exactly the approved OpenCode runtime; Codex is absent pending approval",
    );
  }
  return {
    schemaVersion: 2,
    description: approvals.description,
    node: validateNodeSection(approvals.node),
    sidecarRuntimes: approvals.sidecarRuntimes.map(validateSidecarRuntime),
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
