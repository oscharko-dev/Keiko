import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { URL } from "node:url";

import { extractApprovedExecutable } from "./prepare-approved-sidecar-payloads.mjs";
import { APPROVED_SIDECAR_ARCHIVE_HOSTS } from "./portable-runtime-approvals.mjs";

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_LICENSE_BYTES = 1024 * 1024;
const EXPECTED_OPENCODE_VERSION = "1.17.17";
const ARCHIVE_FINAL_HOSTS = new Set(
  APPROVED_SIDECAR_ARCHIVE_HOSTS.filter((host) => host !== "raw.githubusercontent.com"),
);
const LICENSE_FINAL_HOSTS = new Set(["raw.githubusercontent.com"]);

export function functionalOpenCodePlatformTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  return "unsupported";
}

export async function stageFunctionalOpenCode({
  repoRoot = resolve(import.meta.dirname, ".."),
} = {}) {
  const { archive, runtime, target } = approvedRuntime(repoRoot);
  const stageRoot = mkdtempSync(join(tmpdir(), "keiko-opencode-2258-stage-"));
  try {
    const executable = await stagePayload(stageRoot, target, runtime, archive);
    return {
      executable,
      stageRoot,
      target,
      cleanup: () => rmSync(stageRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function approvedRuntime(repoRoot) {
  const approvals = JSON.parse(
    readFileSync(join(repoRoot, "portable-runtime-approvals.json"), "utf8"),
  );
  const runtime = approvals.sidecarRuntimes?.find((entry) => entry.name === "opencode-compatible");
  const target = functionalOpenCodePlatformTarget();
  const archive = runtime?.archives?.[target];
  if (runtime === undefined || archive === undefined || runtime.license === undefined)
    fail("target-unapproved");
  if (runtime.upstream.version !== EXPECTED_OPENCODE_VERSION) fail("runtime-version-unapproved");
  return { archive, runtime, target };
}

async function stagePayload(stageRoot, target, runtime, archive) {
  const cacheRoot = resolve(
    process.env.KEIKO_OPENCODE_CACHE_DIR ?? join(homedir(), ".cache", "keiko", "opencode"),
  );
  const archiveFile = await cachedInput(
    cacheRoot,
    `opencode-${target}-${runtime.upstream.version}.zip`,
    archive.url,
    archive.sha256,
    archive.sizeBytes,
    ARCHIVE_FINAL_HOSTS,
  );
  const licenseFile = await cachedInput(
    cacheRoot,
    `LICENSE-${runtime.upstream.commit}`,
    runtime.license.url,
    runtime.license.sha256,
    MAX_LICENSE_BYTES,
    LICENSE_FINAL_HOSTS,
  );
  const executable = join(stageRoot, "payload", "bin", "opencode");
  extractApprovedExecutable(archiveFile, archive.executableName, executable);
  if (statSync(executable).size === 0 || statSync(executable).size > MAX_EXECUTABLE_BYTES)
    fail("executable-size-invalid");
  stageLicense(stageRoot, licenseFile, runtime.license.sha256);
  writeSbom(stageRoot, runtime, executable);
  return executable;
}

function stageLicense(stageRoot, licenseFile, expected) {
  const license = join(stageRoot, "payload", "evidence", "LICENSE");
  mkdirSync(dirname(license), { recursive: true, mode: 0o700 });
  copyFileSync(licenseFile, license);
  if (sha256(license) !== expected) fail("license-stage-invalid");
}

async function cachedInput(cacheRoot, name, url, expected, maxBytes, allowedHosts) {
  const destination = join(cacheRoot, name);
  if (existsSync(destination) && sha256(destination) === expected) return destination;
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const response = await globalThis.fetch(url, { redirect: "follow" });
  if (!response.ok) fail(`download-failed:${response.status}`);
  approvedFinalUrl(response.url === "" ? url : response.url, allowedHosts);
  declaredLength(response, maxBytes);
  const temporary = `${destination}.${process.pid}.${Date.now()}.part`;
  const digest = await streamDownload(response, temporary, maxBytes);
  if (digest !== expected) {
    rmSync(temporary, { force: true });
    fail("download-digest-mismatch");
  }
  renameSync(temporary, destination);
  return destination;
}

function approvedFinalUrl(rawUrl, allowedHosts) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("download-final-url-invalid");
  }
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password)
    fail("download-final-url-unapproved");
}

function declaredLength(response, maxBytes) {
  const header = response.headers.get("content-length");
  if (header === null) return;
  const length = Number(header);
  if (
    !/^[0-9]+$/u.test(header) ||
    !Number.isSafeInteger(length) ||
    length === 0 ||
    length > maxBytes
  )
    fail("download-content-length-invalid");
}

async function streamDownload(response, destination, maxBytes) {
  if (response.body === null) fail("download-body-missing");
  const output = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxBytes) fail("download-size-limit-exceeded");
      hash.update(chunk);
      await output.write(chunk);
    }
    if (sizeBytes === 0) fail("download-empty");
    return hash.digest("hex");
  } finally {
    await output.close();
  }
}

function writeSbom(stageRoot, runtime, executable) {
  const evidence = join(stageRoot, "payload", "evidence", "sbom.cdx.json");
  mkdirSync(dirname(evidence), { recursive: true, mode: 0o700 });
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [
      {
        type: "application",
        name: runtime.name,
        version: runtime.upstream.version,
        hashes: [{ alg: "SHA-256", content: sha256(executable) }],
      },
    ],
  };
  writeFileSync(evidence, `${JSON.stringify(sbom)}\n`, { mode: 0o600 });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fail(message) {
  throw new Error(`functional-opencode-2258: ${message}`);
}
