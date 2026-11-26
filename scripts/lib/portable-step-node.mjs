// The patched step Node.js a Windows Coding step runs inside the AppContainer (#4492, ADR-0043 D21),
// as the Standalone/portable Windows payload carries it. The npm runtime package already ships
// `runtime/step-node/node.exe`; the portable payload takes the same bytes from the immutable,
// digest-pinned transport prerelease of that package and refuses anything the server's own pin
// (`WINDOWS_PORTABLE_RUNTIME_APPROVAL.stepNode`) does not name. The server uses the file only when
// it is present, so a missing or altered file here would silently run steps on an unpatched node.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { compareStableVersions, parseStableVersion } from "./stable-version.mjs";
import { reviewedRelease } from "./coding-runtime-releases.mjs";
import { sha256File, sha256FileChunked } from "./digest.mjs";
import { resolveHostExecutable } from "./host-executable.mjs";
import {
  boundedCurlCommand,
  portableDownloadCurlArgs,
  portableDownloadFailure,
  portableDownloadMaxTimeSeconds,
  portableDownloadTimeoutMs,
} from "./portable-download-bounds.mjs";

export { CODING_RUNTIME_RELEASES_FILE } from "./coding-runtime-releases.mjs";

/** The one portable target that carries a step Node.js; every other target is unchanged. */
const STEP_NODE_PLATFORM_TARGET = "windows-x64";
export const STEP_NODE_TOOL_NAME = "step-node";
export const STEP_NODE_PORTABLE_EXECUTABLE_PATH = "runtime/step-node/node.exe";
export const STEP_NODE_PORTABLE_LICENSE_PATH = "runtime/licenses/node-step/LICENSE";
/** Official Node.js 26.13.1 plus libuv#5181 (libuv 1.52.1-keiko.5181). */
export const STEP_NODE_VERSION = "26.13.1-keiko.5181";
export const STEP_NODE_LICENSE_EXPRESSION = "MIT";
export const STEP_NODE_SOURCE_URL = "https://nodejs.org/dist/v26.13.1/node-v26.13.1.tar.gz";
/** The one entry of a Windows runtime package this stage reads. */
export const STEP_NODE_PACKAGE_ENTRY = "package/runtime/step-node/node.exe";
const STEP_NODE_PACKAGE_FOLDER = "package/runtime/step-node/";
const PACKAGE_ROOT = "package/";
const RELEASE_BASE_URL = "https://github.com/oscharko-dev/Keiko/releases/download";
/** The Node.js 26.13.1 LICENSE of the official source tarball, kept in the repository. */
export const STEP_NODE_LICENSE_SOURCE_PATH = "scripts/licenses/node-26.13.1-LICENSE";
export const STEP_NODE_LICENSE_SHA256 =
  "8e603aa87c70d36e497004f0dec63111511cb61b7d65ace12e10ea791599286c";
const STEP_NODE_LICENSE_MAX_BYTES = 256 * 1024;
const TAR_TIMEOUT_MS = 300_000;
const TAR_LIST_MAX_BYTES = 64 * 1024 * 1024;
const repoRoot = resolve(import.meta.dirname, "..", "..");

/** Whether a portable target ships a step Node.js. */
export function stepNodeAppliesTo(target) {
  return target?.platformTarget === STEP_NODE_PLATFORM_TARGET;
}

/** The CycloneDX reference of the shipped step Node.js. One definition for producer and validator. */
export function stepNodeSbomBomRef(platformTarget) {
  return `pkg:generic/nodejs@${STEP_NODE_VERSION}?platform=${platformTarget ?? ""}`;
}

/**
 * The step Node.js is pinned by its exact bytes in the server, and an Authenticode signature would
 * change them, so no signing lane signs it: its state is the same in every lane. Its integrity is
 * the pin, which the server verifies at every launch.
 */
export function stepNodeSigning(target) {
  return {
    signatureKind: target.signatureKind,
    verificationStatus: "unsigned-non-production",
    signatureVerified: false,
    notarizationRequired: false,
    notarizationVerified: false,
  };
}

// Where the step Node.js sits in the three roots a signing inventory is read from: the resource
// root itself, the stage root, and a Windows generation folder. Nothing else may share the name.
const STEP_NODE_INVENTORY_PATH =
  /^(?:payload\/Keiko\/|\.portable\/generations\/[a-f0-9]{64}\/)?runtime\/step-node\/node\.exe$/iu;

/** The payload paths no signing inventory may list: signing would break the server's byte pin. */
export function isStepNodeExecutablePath(relativePath) {
  return STEP_NODE_INVENTORY_PATH.test(relativePath);
}

/**
 * The shape of a manifest's tool set: ripgrep alone, or ripgrep followed by the step Node.js. Every
 * consumer that used to demand exactly one tool asks this instead, so a stray entry stays refused.
 */
export function nativeToolSetIsValid(tools) {
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > 2) return false;
  if (tools[0]?.name === STEP_NODE_TOOL_NAME) return false;
  return tools.length === 1 || tools[1]?.name === STEP_NODE_TOOL_NAME;
}

/** The ripgrep entry of a valid tool set, which is always the first. */
export function ripgrepToolOf(tools) {
  return nativeToolSetIsValid(tools) ? tools[0] : undefined;
}

/** The provenance projection of a step Node.js manifest entry. */
export function stepNodeToolProvenance(tool) {
  return {
    architecture: tool.architecture,
    executablePath: tool.executablePath,
    name: tool.name,
    shippedSha256: tool.shippedSha256,
    signatureKind: tool.signing.signatureKind,
    signatureVerified: tool.signing.signatureVerified,
    notarizationVerified: tool.signing.notarizationVerified,
    sourceSha256: tool.source.sourceSha256,
    patchSha256s: [...tool.source.patchSha256s],
    unsignedSha256: tool.unsignedSha256,
    version: tool.version,
  };
}

/** The reviewed Windows runtime package that carries the approved OpenCode, newest first. */
export function selectStepNodePackage(document, openCodeVersion) {
  const versions = Object.keys(document?.releases ?? {})
    .map((version) => ({ version, parsed: parseStableVersion(version) }))
    .filter((candidate) => candidate.parsed !== undefined)
    .sort((left, right) => compareStableVersions(right.parsed, left.parsed));
  for (const { version } of versions) {
    const entry = reviewedRelease(document, version).find(
      (candidate) =>
        candidate.target === STEP_NODE_PLATFORM_TARGET &&
        candidate.opencodeVersion === openCodeVersion,
    );
    if (entry === undefined) continue;
    // The name becomes a cache path and a release asset name: one plain file name only.
    if (typeof entry.tarball !== "string" || basename(entry.tarball) !== entry.tarball) {
      throw new Error(
        `reviewed ${STEP_NODE_PLATFORM_TARGET} package ${version} names no plain file`,
      );
    }
    return { ...entry, version };
  }
  throw new Error(
    `no reviewed ${STEP_NODE_PLATFORM_TARGET} runtime package carries OpenCode ${openCodeVersion}`,
  );
}

/** The transport location of a reviewed package; the digest, not the host, is what is trusted. */
export function stepNodePackageUrl(selected) {
  return `${RELEASE_BASE_URL}/coding-runtime-${selected.version}/${selected.tarball}`;
}

function verifiedRegularFile(path, label) {
  const entry = existsSync(path) ? lstatSync(path) : undefined;
  if (entry === undefined || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error(`${label} is not a regular single-link file`);
  }
  return entry;
}

/** Size and SHA-256 of the whole tarball against its catalog pin; any difference is refused. */
function verifyPackageTarball(path, selected) {
  const entry = verifiedRegularFile(path, "runtime package tarball");
  if (entry.size !== selected.sizeBytes) {
    throw new Error("runtime package tarball size differs from its catalog pin");
  }
  if (sha256FileChunked(path, selected.sizeBytes) !== selected.sha256) {
    throw new Error("runtime package tarball digest differs from its catalog pin");
  }
}

function downloadPackageTarball(selected, destination, run) {
  const bounds = { expectedSize: selected.sizeBytes, assetName: selected.tarball };
  const maxTimeSeconds = portableDownloadMaxTimeSeconds();
  const command = boundedCurlCommand(
    portableDownloadCurlArgs({
      expectedSize: selected.sizeBytes,
      destination,
      url: stepNodePackageUrl(selected),
      maxTimeSeconds,
    }),
    selected.sizeBytes,
  );
  const result = run(command.cmd, command.args, {
    encoding: "utf8",
    timeout: portableDownloadTimeoutMs(maxTimeSeconds),
  });
  if (result.error !== undefined || result.status !== 0) {
    rmSync(destination, { force: true });
    throw new Error(portableDownloadFailure(result, bounds, destination));
  }
}

/**
 * The verified tarball: the local one when given (an offline or local build), otherwise the cached
 * or freshly downloaded one. A cached file is verified again before it is used.
 */
export function obtainPackageTarball(selected, { localTarball, cacheDir, run = spawnSync }) {
  if (localTarball !== undefined) {
    verifyPackageTarball(localTarball, selected);
    return resolve(localTarball);
  }
  const cached = join(resolve(cacheDir), selected.sha256, selected.tarball);
  if (existsSync(cached)) {
    verifyPackageTarball(cached, selected);
    return cached;
  }
  mkdirSync(dirname(cached), { recursive: true });
  const partial = `${cached}.${String(process.pid)}.tmp`;
  try {
    downloadPackageTarball(selected, partial, run);
    verifyPackageTarball(partial, selected);
    renameSync(partial, cached);
  } finally {
    rmSync(partial, { force: true });
  }
  return cached;
}

// GNU tar reads `C:\...\package.tgz` as the remote host `C`; naming the archive relative to its own
// directory is read as a local file by GNU tar and bsdtar alike (#4068).
function runTar(tarball, mode, rest, run, options = {}) {
  const result = run(resolveHostExecutable("tar"), [mode, `./${basename(tarball)}`, ...rest], {
    cwd: dirname(tarball),
    encoding: "utf8",
    timeout: TAR_TIMEOUT_MS,
    ...options,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("runtime package tarball could not be read by tar");
  }
  return result;
}

function normalizedEntryName(name) {
  return name.endsWith("/") ? name.slice(0, -1) : name;
}

/**
 * Lists the tarball and requires the step Node.js entry exactly once, as a regular file, with no
 * other entry in its folder and none outside the fixed package root.
 */
function assertStepNodeEntry(tarball, run = spawnSync) {
  const names = runTar(tarball, "-tzf", [], run, { maxBuffer: TAR_LIST_MAX_BYTES })
    .stdout.split(/\r?\n/u)
    .filter(Boolean)
    .map(normalizedEntryName);
  const types = runTar(tarball, "-tvzf", [], run, { maxBuffer: TAR_LIST_MAX_BYTES })
    .stdout.split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line[0]);
  if (names.length !== types.length) throw new Error("tar listing of the package is inconsistent");
  const insideRoot = (name) => name === PACKAGE_ROOT.slice(0, -1) || name.startsWith(PACKAGE_ROOT);
  if (names.some((name) => !insideRoot(name) || name.split("/").includes(".."))) {
    throw new Error("runtime package holds an entry outside its package root");
  }
  const matches = names.flatMap((name, index) => (name === STEP_NODE_PACKAGE_ENTRY ? [index] : []));
  if (matches.length !== 1) {
    throw new Error("runtime package must hold the step Node.js exactly once");
  }
  if (types[matches[0]] !== "-") throw new Error("the step Node.js entry is not a regular file");
  const siblings = names.filter(
    (name) => name.startsWith(STEP_NODE_PACKAGE_FOLDER) && name !== STEP_NODE_PACKAGE_ENTRY,
  );
  if (siblings.length > 0) throw new Error("the step Node.js folder holds more than one entry");
}

/**
 * Extracts only the step Node.js entry into `destinationDir` and verifies its bytes against the
 * server's pin. Returns the extracted file.
 */
function extractStepNode(tarball, pin, destinationDir, run = spawnSync) {
  assertStepNodeEntry(tarball, run);
  mkdirSync(destinationDir, { recursive: true });
  runTar(tarball, "-xzf", ["-C", destinationDir, STEP_NODE_PACKAGE_ENTRY], run);
  const extracted = join(destinationDir, ...STEP_NODE_PACKAGE_ENTRY.split("/"));
  const entry = verifiedRegularFile(extracted, "extracted step Node.js");
  if (entry.size !== pin.sizeBytes || sha256File(extracted) !== pin.sha256) {
    throw new Error("the step Node.js in the runtime package differs from the server's pin");
  }
  return extracted;
}

function verifiedLicenseSource(path) {
  const entry = verifiedRegularFile(path, "Node.js license text");
  if (entry.size > STEP_NODE_LICENSE_MAX_BYTES || sha256File(path) !== STEP_NODE_LICENSE_SHA256) {
    throw new Error("the Node.js license text differs from its pinned digest");
  }
  return path;
}

/**
 * Resolves the verified bytes to stage: the catalog's newest reviewed Windows package for the
 * approved OpenCode, its tarball verified against the catalog, the one entry extracted and verified
 * against the server's pin. `dispose` removes the extraction.
 */
export function resolveStepNodeRuntime({
  approval,
  catalog,
  localTarball,
  cacheDir,
  licenseSource = join(repoRoot, ...STEP_NODE_LICENSE_SOURCE_PATH.split("/")),
  run = spawnSync,
}) {
  const pin = approval?.stepNode;
  if (pin === undefined) throw new Error("the server approves no step Node.js for this target");
  const selected = selectStepNodePackage(catalog, approval.upstreamVersion);
  const tarball = obtainPackageTarball(selected, { localTarball, cacheDir, run });
  const scratch = mkdtempSync(join(tmpdir(), "keiko-step-node-"));
  try {
    const sourceBinary = extractStepNode(tarball, pin, scratch, run);
    return {
      approved: pin,
      package: { version: selected.version, tarball: selected.tarball, sha256: selected.sha256 },
      sourceBinary,
      sourceLicense: verifiedLicenseSource(licenseSource),
      dispose: () => rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

function throwFailure(message) {
  throw new Error(message);
}

function failStepNodeStaging(onFailure, message) {
  onFailure(message);
  throw new Error("portable step Node.js staging aborted");
}

// Re-verifies the bytes that landed in the payload, not the source they were copied from, and that
// the folder holds exactly that one file (the server refuses a folder with anything else).
function verifyStagedStepNode(resourceRoot, staged, approved, onFailure) {
  const entry = lstatSync(staged.destination);
  if (!entry.isFile() || entry.nlink !== 1 || entry.size !== approved.sizeBytes) {
    return failStepNodeStaging(onFailure, "step Node.js staged file is not the pinned size");
  }
  if (sha256File(staged.destination) !== approved.sha256) {
    return failStepNodeStaging(onFailure, "step Node.js staged runtime failed its pinned digest");
  }
  if (readdirSync(dirname(staged.destination)).join("|") !== basename(staged.destination)) {
    return failStepNodeStaging(onFailure, "step Node.js folder must hold only node.exe");
  }
  const license = join(resourceRoot, ...staged.licensePath.split("/"));
  if (sha256File(license) !== STEP_NODE_LICENSE_SHA256) {
    return failStepNodeStaging(onFailure, "step Node.js staged license failed its pinned digest");
  }
  return undefined;
}

/**
 * The manifest `nativeTools` entry for a staged step Node.js. `shippedSha256` and `sizeBytes`
 * describe the bytes on disk; `unsignedSha256` is the approved build's identity, and no lane signs
 * the file, so the two are always equal.
 */
function stepNodeToolManifestEntry(target, approved, staged) {
  return {
    name: STEP_NODE_TOOL_NAME,
    kind: "native-tool",
    version: STEP_NODE_VERSION,
    platformTarget: target.platformTarget,
    architecture: target.nodeArchitecture,
    executablePath: STEP_NODE_PORTABLE_EXECUTABLE_PATH,
    licensePath: STEP_NODE_PORTABLE_LICENSE_PATH,
    source: {
      sourceUrl: STEP_NODE_SOURCE_URL,
      sourceSha256: approved.sourceSha256,
      patchSha256s: [...approved.patchSha256s],
      binarySha256: approved.sha256,
      licenseSha256: STEP_NODE_LICENSE_SHA256,
    },
    unsignedSha256: approved.sha256,
    shippedSha256: sha256File(staged.destination),
    sizeBytes: lstatSync(staged.destination).size,
    sbomBomRef: stepNodeSbomBomRef(target.platformTarget),
    signing: stepNodeSigning(target),
  };
}

/**
 * Stages the pinned step Node.js and its MIT license for `windows-x64` and returns the manifest
 * tool entry; every other target stages nothing. The staged bytes are verified against the pin
 * again after the copy, and any mismatch aborts staging.
 */
export function stageStepNodeTool(
  target,
  resourceRoot,
  { copyFile = copyFileSync, onFailure = throwFailure, resolveRuntime },
) {
  if (!stepNodeAppliesTo(target)) return [];
  const runtime = resolveRuntime(target);
  try {
    const destination = join(resourceRoot, ...STEP_NODE_PORTABLE_EXECUTABLE_PATH.split("/"));
    const license = join(resourceRoot, ...STEP_NODE_PORTABLE_LICENSE_PATH.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    mkdirSync(dirname(license), { recursive: true });
    copyFile(runtime.sourceBinary, destination);
    copyFile(runtime.sourceLicense, license);
    const staged = { destination, licensePath: STEP_NODE_PORTABLE_LICENSE_PATH };
    verifyStagedStepNode(resourceRoot, staged, runtime.approved, onFailure);
    return [stepNodeToolManifestEntry(target, runtime.approved, staged)];
  } finally {
    runtime.dispose?.();
  }
}
