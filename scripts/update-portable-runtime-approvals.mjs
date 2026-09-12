import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  PORTABLE_RUNTIME_APPROVALS_FILE,
  validatePortableRuntimeApprovals,
} from "./portable-runtime-approvals.mjs";
import {
  hashDirectoryTree,
  PORTABLE_TARGET_NAMES,
  portableTargetByName,
} from "./portable-runtime.mjs";
import {
  extractApprovedExecutable,
  sidecarSbomDocument,
  SPEC_EXECUTABLE_DIR,
} from "./prepare-approved-sidecar-payloads.mjs";
import { sha256 } from "./lib/digest.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOWNLOAD_TIMEOUT_MS = 300_000;
const APPROVED_OPENCODE_VERSION = "1.18.30";
const APPROVED_OPENCODE_COMMIT = "3104c1428ec91f809e5ab86631300de41eb6952e";
const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
const TEXT_MAX_BYTES = 16 * 1024 * 1024;
const NODE_HOSTS = Object.freeze(["nodejs.org", "dist.nodejs.org"]);
const RELEASE_HOSTS = Object.freeze([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const RAW_HOSTS = Object.freeze(["raw.githubusercontent.com"]);
const DEFAULT_UPDATE_DEPS = Object.freeze({ fetchFn: globalThis.fetch });
const OPENCODE_RELEASE_BASE = "https://github.com/anomalyco/opencode/releases/download";
const OPENCODE_LICENSE_BASE = "https://raw.githubusercontent.com/anomalyco/opencode";
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

function downloadedArchiveEntry(target, url, payload) {
  return {
    url,
    sha256: sha256(payload),
    sizeBytes: payload.byteLength,
    executableName: target === "windows-x64" ? "opencode.exe" : "opencode",
  };
}

async function downloadOpencodeArchives(version, deps) {
  const downloads = {};
  for (const target of PORTABLE_TARGET_NAMES) {
    const name = portableTargetByName(target).sidecarArchiveName;
    const url = `${OPENCODE_RELEASE_BASE}/v${version}/${name}`;
    const payload = await fetchBuffer(url, ARCHIVE_MAX_BYTES, RELEASE_HOSTS, deps);
    downloads[target] = { name, payload, entry: downloadedArchiveEntry(target, url, payload) };
  }
  return downloads;
}

// A refresh of the SAME approved version must find the SAME bytes. Changed bytes under an unchanged
// tag mean the upstream release moved under us, which is a supply-chain event and not something an
// updater may absorb -- so this path still carries the reviewed tree digest forward and fails closed
// on drift. The version lift below is a different question and takes the regenerating path instead.
function carriedForwardArchives(downloads, existingArchives) {
  const archives = {};
  for (const target of PORTABLE_TARGET_NAMES) {
    const { entry } = downloads[target];
    const digest = entry.sha256;
    const previous = existingArchives[target];
    // KEIKO-0157: executableTreeSha256 is a digest of the EXTRACTED executable tree, and this
    // script has no extractor — it can only carry the previous value forward. That is correct
    // when the archive bytes are unchanged and a lie when they are not: the refreshed entry would
    // pair a new sha256 with a tree digest describing the old contents, and both this script and
    // check:portable-approvals (JSON-shape only, no network) would report success. The drift then
    // surfaced at tag time, when portable-assets.yml fails closed on "approved executable tree
    // digest mismatch" — during a release cut rather than at PR review. Fail here instead.
    if (digest !== previous.sha256) {
      fail(
        `OpenCode archive for ${target} changed (sha256 ${digest} != approved ${previous.sha256}), ` +
          "so its executableTreeSha256 can no longer be carried forward. Regenerate the executable " +
          "tree digest independently (extract the archive and hash it with hashDirectoryTree, the " +
          "way prepare-approved-sidecar-payloads.mjs verifies it) and update the approvals entry " +
          "with both values together.",
      );
    }
    archives[target] = {
      ...entry,
      executableTreeSha256: previous.executableTreeSha256,
      sbomSha256: previous.sbomSha256,
    };
  }
  return archives;
}

/**
 * A version lift changes the archive bytes by definition, so neither the executable-tree digest nor
 * the SBOM digest of the previous release describes it. Derive both from the downloaded bytes with
 * the SAME functions `prepare-approved-sidecar-payloads.mjs` verifies them with, against a runtime
 * that ALREADY carries the new upstream and archive facts -- an SBOM built from the outgoing runtime
 * would name the old tag and the old archive digest while claiming to describe the new executable.
 */
function regeneratedArchiveEvidence(runtime, target, archiveName, payload) {
  const workRoot = mkdtempSync(join(tmpdir(), "keiko-approvals-extract-"));
  try {
    const archivePath = join(workRoot, archiveName);
    writeFileSync(archivePath, payload);
    const sourceRoot = join(workRoot, "payload");
    const { executableName } = runtime.archives[target];
    const executablePath = join(sourceRoot, SPEC_EXECUTABLE_DIR, executableName);
    extractApprovedExecutable(archivePath, executableName, executablePath);
    const executableSha256 = sha256(readFileSync(executablePath));
    const sbom = `${JSON.stringify(sidecarSbomDocument(runtime, target, executableSha256), null, 2)}\n`;
    return {
      executableTreeSha256: hashDirectoryTree(sourceRoot),
      sbomSha256: sha256(Buffer.from(sbom, "utf8")),
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function regeneratedArchives(downloads, liftedRuntime) {
  const archives = {};
  for (const target of PORTABLE_TARGET_NAMES) {
    const { name, payload } = downloads[target];
    archives[target] = {
      ...liftedRuntime.archives[target],
      ...regeneratedArchiveEvidence(liftedRuntime, target, name, payload),
    };
  }
  return archives;
}

// The protocol schema is pinned by commit, so a lift must re-read it at the new commit. Its path
// comes from the entry being replaced rather than a second literal, so the two cannot diverge.
async function approvedOpencodeProtocolSchema(existing, deps) {
  const url = `${OPENCODE_LICENSE_BASE}/${APPROVED_OPENCODE_COMMIT}/${existing.path}`;
  const payload = await fetchBuffer(url, TEXT_MAX_BYTES, RAW_HOSTS, deps);
  return { ...existing, url, sha256: sha256(payload) };
}

async function approvedOpencodeLicense(deps) {
  const url = `${OPENCODE_LICENSE_BASE}/${APPROVED_OPENCODE_COMMIT}/LICENSE`;
  const payload = await fetchBuffer(url, TEXT_MAX_BYTES, RAW_HOSTS, deps);
  return { spdxId: "MIT", url, sha256: sha256(payload) };
}

function liftedOpencodeRuntime(existing, version, entries, license, protocolSchema) {
  return {
    ...existing,
    upstream: {
      ...existing.upstream,
      version,
      tag: `v${version}`,
      commit: APPROVED_OPENCODE_COMMIT,
    },
    protocolSchema,
    license,
    archives: entries,
  };
}

export async function updatedOpencodeRuntime(existing, version, deps) {
  const downloads = await downloadOpencodeArchives(version, deps);
  const license = await approvedOpencodeLicense(deps);
  if (version === existing.upstream.version) {
    return { ...existing, license, archives: carriedForwardArchives(downloads, existing.archives) };
  }
  const entries = Object.fromEntries(
    PORTABLE_TARGET_NAMES.map((target) => [target, downloads[target].entry]),
  );
  const protocolSchema = await approvedOpencodeProtocolSchema(existing.protocolSchema, deps);
  const lifted = liftedOpencodeRuntime(existing, version, entries, license, protocolSchema);
  return { ...lifted, archives: regeneratedArchives(downloads, lifted) };
}

export async function updatePortableRuntimeApprovals(
  argv,
  deps = DEFAULT_UPDATE_DEPS,
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
    approvals.sidecarRuntimes[index] = await updatedOpencodeRuntime(
      approvals.sidecarRuntimes[index],
      options.opencodeVersion,
      deps,
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
  try {
    const summary = await updatePortableRuntimeApprovals(process.argv.slice(2));
    console.log(
      `portable-approvals updated: node ${summary.nodeVersion}, opencode ${summary.opencodeVersion}. Review and commit ${PORTABLE_RUNTIME_APPROVALS_FILE}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
