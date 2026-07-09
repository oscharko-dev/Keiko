import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  APPROVED_SIDECAR_ARCHIVE_HOSTS,
  loadPortableRuntimeApprovals,
} from "./portable-runtime-approvals.mjs";
import { hashDirectoryTree, PORTABLE_TARGET_NAMES, sha256File } from "./portable-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOWNLOAD_TIMEOUT_MS = 300_000;
const LICENSE_MAX_BYTES = 1024 * 1024;
const SPEC_EXECUTABLE_DIR = "bin";
const SPEC_EVIDENCE_DIR = "evidence";

function fail(message) {
  throw new Error(`prepare-sidecar-payloads: ${message}`);
}

export function parsePrepareArgs(argv) {
  const options = { archives: new Map(), license: undefined, outputRoot: undefined, target: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
    if (arg === "--target") options.target = value;
    else if (arg === "--output-root") options.outputRoot = resolve(value);
    else if (arg === "--archive") addLocalArchive(options.archives, value);
    else if (arg === "--license") options.license = resolve(value);
    else fail(`unsupported argument ${arg}`);
    index += 1;
  }
  if (!PORTABLE_TARGET_NAMES.includes(options.target)) {
    fail(`--target must be one of ${PORTABLE_TARGET_NAMES.join(", ")}`);
  }
  options.outputRoot ??= resolve(repoRoot, ".portable-sidecar-payloads");
  return options;
}

function addLocalArchive(archives, value) {
  const separator = value.indexOf("=");
  if (separator <= 0) fail("--archive must use <runtime-name>=<path>");
  archives.set(value.slice(0, separator), resolve(value.slice(separator + 1)));
}

function assertApprovedResponseUrl(responseUrl, context) {
  let url;
  try {
    url = new URL(responseUrl);
  } catch {
    fail(`${context} redirect target is not a valid URL`);
  }
  if (url.protocol !== "https:" || !APPROVED_SIDECAR_ARCHIVE_HOSTS.includes(url.hostname)) {
    fail(`${context} redirect target host is not approved`);
  }
}

async function downloadVerified(url, expected, destination, deps) {
  const { maxBytes, sha256 } = expected;
  const response = await deps.fetchFn(url, {
    redirect: "follow",
    signal: globalThis.AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) fail(`download failed for approved input: HTTP ${String(response.status)}`);
  assertApprovedResponseUrl(response.url === "" ? url : response.url, "approved input");
  const payload = Buffer.from(await response.arrayBuffer());
  if (payload.byteLength === 0 || payload.byteLength > maxBytes) {
    fail("approved input size is outside limits");
  }
  const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== sha256) fail("approved input digest mismatch");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, payload);
}

async function materializeInput(url, expected, destination, localPath, deps) {
  if (localPath !== undefined) {
    if (!existsSync(localPath) || !statSync(localPath).isFile()) {
      fail("local input path must be an existing file");
    }
    if ((await sha256File(localPath)) !== expected.sha256) fail("local input digest mismatch");
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(localPath, destination);
    return;
  }
  await downloadVerified(url, expected, destination, deps);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.error !== undefined || result.status !== 0) {
    fail(`${cmd} failed while extracting approved archive`);
  }
  return result;
}

function listZipEntries(archivePath) {
  const probe = spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
  const output =
    probe.error === undefined && probe.status === 0 ? probe : run("tar", ["-tf", archivePath], {});
  return output.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractZip(archivePath, extractRoot) {
  const probe = spawnSync("unzip", ["-q", archivePath, "-d", extractRoot], { encoding: "utf8" });
  if (probe.error === undefined && probe.status === 0) return;
  run("tar", ["-xf", archivePath, "-C", extractRoot], {});
}

function assertSafeSingleExecutableEntry(entries, executableName) {
  if (entries.length !== 1 || entries[0] !== executableName) {
    fail(`approved archive must contain exactly one entry named ${executableName}`);
  }
}

export function extractApprovedExecutable(archivePath, executableName, destination) {
  assertSafeSingleExecutableEntry(listZipEntries(archivePath), executableName);
  const extractRoot = mkdtempSync(join(tmpdir(), "keiko-sidecar-extract-"));
  try {
    extractZip(archivePath, extractRoot);
    const extracted = join(extractRoot, executableName);
    if (!existsSync(extracted) || !statSync(extracted).isFile()) {
      fail("approved archive did not produce the expected executable");
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(extracted, destination);
    chmodExecutable(destination);
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

function chmodExecutable(path) {
  try {
    chmodSync(path, 0o755);
  } catch {
    // Best-effort on Windows.
  }
}

export function sidecarSbomDocument(runtime, target, executableSha256) {
  const version = runtime.upstream.version;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: runtime.name,
        version,
      },
    },
    components: [
      {
        type: "application",
        name: runtime.upstream.name,
        version,
        purl: `pkg:github/anomalyco/opencode@v${version}`,
        licenses: [{ license: { id: runtime.license.spdxId } }],
        hashes: [{ alg: "SHA-256", content: executableSha256 }],
        externalReferences: [
          {
            type: "distribution",
            url: runtime.archives[target].url,
            hashes: [{ alg: "SHA-256", content: runtime.archives[target].sha256 }],
          },
        ],
      },
    ],
  };
}

async function stageRuntimePayload(runtime, target, sourceRoot, archivePath) {
  const archive = runtime.archives[target];
  const executableRelative = `${SPEC_EXECUTABLE_DIR}/${archive.executableName}`;
  extractApprovedExecutable(
    archivePath,
    archive.executableName,
    join(sourceRoot, SPEC_EXECUTABLE_DIR, archive.executableName),
  );
  const executableSha256 = await sha256File(join(sourceRoot, executableRelative));
  writeFileSync(
    join(sourceRoot, SPEC_EVIDENCE_DIR, "sbom.cdx.json"),
    `${JSON.stringify(sidecarSbomDocument(runtime, target, executableSha256), null, 2)}\n`,
  );
  return executableRelative;
}

export function sidecarSpecDocument(runtime, target, sourceRoot, executableRelative) {
  return {
    name: runtime.name,
    kind: runtime.kind,
    sourceRoot,
    executablePath: executableRelative,
    licenseEvidencePath: `${SPEC_EVIDENCE_DIR}/LICENSE`,
    sbomEvidencePath: `${SPEC_EVIDENCE_DIR}/sbom.cdx.json`,
    upstream: runtime.upstream,
    adapterCompatibility: runtime.adapterCompatibility,
    platformTarget: target,
    expectedPayloadSha256: hashDirectoryTree(sourceRoot),
  };
}

async function prepareRuntime(runtime, target, options, deps) {
  const archive = runtime.archives[target];
  const runtimeRoot = join(options.outputRoot, target, runtime.name);
  const sourceRoot = join(runtimeRoot, "payload");
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(join(sourceRoot, SPEC_EVIDENCE_DIR), { recursive: true });
  const archivePath = join(runtimeRoot, basename(new URL(archive.url).pathname));
  await materializeInput(
    archive.url,
    { maxBytes: archive.sizeBytes, sha256: archive.sha256 },
    archivePath,
    options.archives.get(runtime.name),
    deps,
  );
  if (statSync(archivePath).size !== archive.sizeBytes) fail("approved archive size mismatch");
  await materializeInput(
    runtime.license.url,
    { maxBytes: LICENSE_MAX_BYTES, sha256: runtime.license.sha256 },
    join(sourceRoot, SPEC_EVIDENCE_DIR, "LICENSE"),
    options.license,
    deps,
  );
  const executableRelative = await stageRuntimePayload(runtime, target, sourceRoot, archivePath);
  const spec = sidecarSpecDocument(runtime, target, sourceRoot, executableRelative);
  const specPath = join(runtimeRoot, `${runtime.name}.spec.json`);
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  return { name: runtime.name, payloadSha256: spec.expectedPayloadSha256, specPath };
}

export async function prepareApprovedSidecarPayloads(
  argv,
  deps = { fetchFn: globalThis.fetch },
  root = repoRoot,
) {
  const options = parsePrepareArgs(argv);
  const approvals = loadPortableRuntimeApprovals(root);
  const results = [];
  for (const runtime of approvals.sidecarRuntimes) {
    results.push(await prepareRuntime(runtime, options.target, options, deps));
  }
  return { results, target: options.target };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareApprovedSidecarPayloads(process.argv.slice(2)).then(
    (summary) => {
      for (const entry of summary.results) {
        console.log(
          `prepared ${entry.name} for ${summary.target}: payload ${entry.payloadSha256.slice(0, 12)} spec ${entry.specPath}`,
        );
      }
      if (summary.results.length === 0) {
        console.log(`no approved sidecar runtimes configured for ${summary.target}`);
      }
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
