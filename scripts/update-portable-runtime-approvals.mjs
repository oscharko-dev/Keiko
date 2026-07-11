import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  PORTABLE_RUNTIME_APPROVALS_FILE,
  validatePortableRuntimeApprovals,
} from "./portable-runtime-approvals.mjs";
import { PORTABLE_TARGET_NAMES, portableTargetByName } from "./portable-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOWNLOAD_TIMEOUT_MS = 300_000;
const APPROVED_OPENCODE_VERSION = "1.17.17";
const APPROVED_OPENCODE_COMMIT = "474abdd7ee60f4b67476cfcef7e5311beff4a824";
const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
const TEXT_MAX_BYTES = 16 * 1024 * 1024;
const NODE_HOSTS = Object.freeze(["nodejs.org", "dist.nodejs.org"]);
const RELEASE_HOSTS = Object.freeze([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const RAW_HOSTS = Object.freeze(["raw.githubusercontent.com"]);
const OPENCODE_RELEASE_BASE = "https://github.com/anomalyco/opencode/releases/download";
const OPENCODE_LICENSE_BASE = "https://raw.githubusercontent.com/anomalyco/opencode";
const OPENCODE_ARCHIVE_BY_TARGET = Object.freeze({
  "macos-arm64": "opencode-darwin-arm64.zip",
  "macos-x64": "opencode-darwin-x64.zip",
  "windows-x64": "opencode-windows-x64.zip",
});

function fail(message) {
  throw new Error(`update-portable-approvals: ${message}`);
}

function validateFinalUrl(rawUrl, allowedFinalHosts) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("download final URL is invalid");
  }
  if (url.protocol !== "https:" || !allowedFinalHosts.includes(url.hostname)) {
    fail("download final host is not approved");
  }
}

async function readBoundedBody(body, maxBytes) {
  const chunks = [];
  let sizeBytes = 0;
  for await (const rawChunk of body) {
    const chunk = Buffer.from(rawChunk);
    sizeBytes += chunk.byteLength;
    if (sizeBytes > maxBytes) fail("download exceeds the hard size limit");
    chunks.push(chunk);
  }
  if (sizeBytes === 0) fail("download is empty");
  return Buffer.concat(chunks, sizeBytes);
}

function parseArgs(argv) {
  const options = { nodeVersion: undefined, opencodeVersion: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
    if (arg === "--node-version") options.nodeVersion = value.replace(/^v/u, "");
    else if (arg === "--opencode-version") options.opencodeVersion = value.replace(/^v/u, "");
    else fail(`unsupported argument ${arg}`);
    index += 1;
  }
  if (options.nodeVersion === undefined && options.opencodeVersion === undefined) {
    fail("pass --node-version and/or --opencode-version");
  }
  return options;
}

async function fetchBuffer(url, maxBytes, allowedFinalHosts, deps) {
  const response = await deps.fetchFn(url, {
    redirect: "follow",
    signal: globalThis.AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) fail(`download failed: HTTP ${String(response.status)} for approved source`);
  validateFinalUrl(response.url === "" ? url : response.url, allowedFinalHosts);
  if (response.body === null || response.body === undefined) fail("download has no response body");
  return readBoundedBody(response.body, maxBytes);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function nodeArchiveName(target, version) {
  const portable = portableTargetByName(target);
  const base = `node-v${version}-${portable.nodeArchiveTarget}`;
  return `${base}.${portable.nodeArchiveExtension}`;
}

async function approvedNodeSection(version, deps) {
  const shasums = await fetchBuffer(
    `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    TEXT_MAX_BYTES,
    NODE_HOSTS,
    deps,
  );
  const lines = shasums.toString("utf8").split(/\r?\n/u);
  const archives = {};
  for (const target of PORTABLE_TARGET_NAMES) {
    const name = nodeArchiveName(target, version);
    const line = lines.find((candidate) => candidate.endsWith(`  ${name}`));
    if (line === undefined) fail(`SHASUMS256.txt has no entry for ${name}`);
    archives[target] = {
      url: `https://nodejs.org/dist/v${version}/${name}`,
      sha256: line.slice(0, 64),
    };
  }
  return { version, archives };
}

async function approvedOpencodeArchives(version, existingArchives, deps) {
  const archives = {};
  for (const target of PORTABLE_TARGET_NAMES) {
    const name = OPENCODE_ARCHIVE_BY_TARGET[target];
    const url = `${OPENCODE_RELEASE_BASE}/v${version}/${name}`;
    const payload = await fetchBuffer(url, ARCHIVE_MAX_BYTES, RELEASE_HOSTS, deps);
    archives[target] = {
      url,
      sha256: sha256Hex(payload),
      sizeBytes: payload.byteLength,
      executableName: target === "windows-x64" ? "opencode.exe" : "opencode",
      executableTreeSha256: existingArchives[target].executableTreeSha256,
    };
  }
  return archives;
}

async function approvedOpencodeLicense(deps) {
  const url = `${OPENCODE_LICENSE_BASE}/${APPROVED_OPENCODE_COMMIT}/LICENSE`;
  const payload = await fetchBuffer(url, TEXT_MAX_BYTES, RAW_HOSTS, deps);
  return { spdxId: "MIT", url, sha256: sha256Hex(payload) };
}

function updatedOpencodeRuntime(existing, version, archives, license) {
  return {
    ...existing,
    upstream: { ...existing.upstream, version },
    license,
    archives,
  };
}

export async function updatePortableRuntimeApprovals(
  argv,
  deps = { fetchFn: globalThis.fetch },
  root = repoRoot,
) {
  const options = parseArgs(argv);
  const path = join(root, PORTABLE_RUNTIME_APPROVALS_FILE);
  const approvals = JSON.parse(readFileSync(path, "utf8"));
  if (
    options.opencodeVersion !== undefined &&
    options.opencodeVersion !== APPROVED_OPENCODE_VERSION
  ) {
    fail(
      `only the independently approved OpenCode version ${APPROVED_OPENCODE_VERSION} may be refreshed`,
    );
  }
  if (options.nodeVersion !== undefined) {
    approvals.node = await approvedNodeSection(options.nodeVersion, deps);
  }
  if (options.opencodeVersion !== undefined) {
    const index = approvals.sidecarRuntimes.findIndex(
      (runtime) => runtime.name === "opencode-compatible",
    );
    if (index < 0) fail("approvals file has no opencode-compatible sidecar runtime entry");
    approvals.sidecarRuntimes[index] = updatedOpencodeRuntime(
      approvals.sidecarRuntimes[index],
      options.opencodeVersion,
      await approvedOpencodeArchives(
        options.opencodeVersion,
        approvals.sidecarRuntimes[index].archives,
        deps,
      ),
      await approvedOpencodeLicense(deps),
    );
  }
  const validated = validatePortableRuntimeApprovals(approvals);
  writeFileSync(path, `${JSON.stringify(approvals, null, 2)}\n`);
  return {
    nodeVersion: validated.node.version,
    opencodeVersion:
      validated.sidecarRuntimes.find((runtime) => runtime.name === "opencode-compatible")?.upstream
        .version ?? "none",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updatePortableRuntimeApprovals(process.argv.slice(2)).then(
    (summary) => {
      console.log(
        `portable-approvals updated: node ${summary.nodeVersion}, opencode ${summary.opencodeVersion}. Review and commit ${PORTABLE_RUNTIME_APPROVALS_FILE}.`,
      );
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
