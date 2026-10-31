#!/usr/bin/env node
// Builds the npm runtime package that lets an npm-installed Keiko run the Coding Workbench (#3577).
// The main package ships no coding engine: until now only the desktop packages carried OpenCode and
// the native secure-read helper, so an npm installation listed its coding models and could never
// start a run. A customer who cannot install a desktop package (no admin rights, no infrastructure
// approval) gets the engine through npm instead: these packages are optionalDependencies of the main
// package with os/cpu fields, so `npm install -g @oscharko-dev/keiko` installs the one for the host.
//
// Nothing here is a new trust decision. The OpenCode executable is the review-approved archive from
// portable-runtime-approvals.json, staged and digest-verified by the same function the dev lane and
// the desktop packages use, and the helper is compiled by the same build script. The server
// re-verifies both against digests pinned in its own source at every start (npm lane,
// devLanePortableCodingRuntime.ts), so this package never vouches for itself.
//
// OpenCode's glob and grep tools run ripgrep and would otherwise download it on first use, which a
// firewalled customer cannot do (#3897, #4064). The package therefore also carries the pinned,
// digest-verified upstream `rg` and its MIT text at the portable payload's own paths, staged by the
// same function the desktop packages use. The server verifies `runtime/native/rg` against the
// digest pinned in ripgrepRuntime.ts at every run launch, so this package vouches for nothing there
// either; a package that lacks it only degrades search.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { runSecureWorkspaceReadBuild } from "./build-secure-workspace-read.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { hostNpmInvocation, resolveHostExecutable } from "./lib/host-executable.mjs";
import { prepareApprovedSidecarPayloads } from "./prepare-approved-sidecar-payloads.mjs";
import { hashHelperSourceTree } from "./stage-dev-coding-runtime.mjs";
import {
  extractPackedRuntimePackage,
  ripgrepToolManifestEntry,
  sbomForManifest,
  stageRipgrepTool,
} from "./stage-portable-runtime.mjs";
import { provisionRipgrep } from "./provision-ripgrep.mjs";
import { portableTargetByName } from "./portable-runtime.mjs";
import {
  RIPGREP_PORTABLE_LICENSE_PATH,
  ripgrepPortableExecutablePath,
  ripgrepRuntimeApproval,
  ripgrepRuntimeTargetKey,
} from "../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts";
import { NPM_PACK_STDIO_MAX_BUFFER } from "./package-surface-pack.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import {
  platformRuntimePackageName,
  platformRuntimePackages,
} from "./release-workspace-policy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "opencode-compatible";
const HELPER_RELATIVE_PATH = "native/keiko-secure-workspace-read";
const EXECUTABLE_PATH = "runtime/opencode-compatible/payload/bin/opencode";
const LICENSE_PATH = "runtime/opencode-compatible/payload/evidence/LICENSE";
const SBOM_PATH = "runtime/opencode-compatible/payload/evidence/sbom.cdx.json";
const RIPGREP_SBOM_PATH = "runtime/licenses/ripgrep/sbom.cdx.json";

/** Every file a candidate carries; the ripgrep executable name is the target release's own. */
function candidateFiles(ripgrep) {
  return [
    "LICENSE.md",
    "package.json",
    `runtime/${HELPER_RELATIVE_PATH}`,
    EXECUTABLE_PATH,
    LICENSE_PATH,
    SBOM_PATH,
    ripgrepPortableExecutablePath(ripgrep.targetKey),
    RIPGREP_PORTABLE_LICENSE_PATH,
    RIPGREP_SBOM_PATH,
  ].sort(compareStrings);
}

/** The platform list and its naming are owned by the release workspace policy. */
export const NPM_RUNTIME_PACKAGE_TARGETS = platformRuntimePackages;
export const codingRuntimePackageName = platformRuntimePackageName;

export function codingRuntimePackageManifest(target, version) {
  const entry = NPM_RUNTIME_PACKAGE_TARGETS[target];
  return {
    name: codingRuntimePackageName(target),
    version,
    description:
      "Keiko Coding Workbench runtime for npm installations: the review-approved OpenCode " +
      "executable, Keiko's native secure workspace read helper and the pinned ripgrep search " +
      "executable. Verified by Keiko at every start.",
    // A valid SPDX expression, never "SEE LICENSE IN …": the supply-chain gates evaluate the
    // license of everything the main package can install and refuse what they cannot parse.
    // OpenCode is MIT, the helper is Keiko's own Apache-2.0 code.
    license: "Apache-2.0 AND MIT",
    repository: { type: "git", url: "git+https://github.com/oscharko-dev/Keiko.git" },
    os: [entry.os],
    cpu: [entry.cpu],
    files: ["runtime", "LICENSE.md"],
    publishConfig: { access: "public" },
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function licenseNotice(target, ripgrep) {
  return [
    `# ${codingRuntimePackageName(target)}`,
    "",
    "This package redistributes three components:",
    "",
    "- `runtime/opencode-compatible/payload/bin/opencode`: OpenCode, MIT License. The upstream",
    "  license text is `runtime/opencode-compatible/payload/evidence/LICENSE`, and its software",
    "  bill of materials is `runtime/opencode-compatible/payload/evidence/sbom.cdx.json`.",
    "- `runtime/native/keiko-secure-workspace-read`: part of Keiko, under Keiko's license",
    "  (https://github.com/oscharko-dev/Keiko/blob/dev/LICENSE).",
    `- \`${ripgrepPortableExecutablePath(ripgrep.targetKey)}\`: ripgrep ${ripgrep.version}, the unmodified upstream`,
    `  release executable, licensed under ${ripgrep.licenseExpression}, at the recipient's option.`,
    `  Keiko ships the MIT text at \`${RIPGREP_PORTABLE_LICENSE_PATH}\` and`,
    `  records the component in \`${RIPGREP_SBOM_PATH}\`.`,
    `  Source: ${ripgrep.archiveUrl}`,
    "",
  ].join("\n");
}

/**
 * The CycloneDX record of the ripgrep component, derived from the pinned approval and the bytes
 * actually staged in `packageDir`, so the build and the candidate inspection cannot disagree.
 */
function ripgrepSbomText(target, ripgrep, packageDir) {
  const executablePath = ripgrepPortableExecutablePath(ripgrep.targetKey);
  const entry = ripgrepToolManifestEntry(
    portableTargetByName(target),
    ripgrep,
    {
      destination: join(packageDir, ...executablePath.split("/")),
      executablePath,
      licensePath: RIPGREP_PORTABLE_LICENSE_PATH,
    },
    false,
  );
  const sbom = sbomForManifest({ nativeHelpers: [], nativeAddons: [], nativeTools: [entry] });
  return `${JSON.stringify(sbom, null, 2)}\n`;
}

/**
 * Provisions (once, verified) and stages the pinned ripgrep of the TARGET release at the portable
 * payload's own paths, and returns its approval. Reuses `provision-ripgrep` and the portable
 * `stageRipgrepTool` rather than a second fetch or verify path; one Mac builds both architectures,
 * so the target's release is provisioned, never the build host's. Both stages throw instead of
 * exiting the process.
 */
export function stagePinnedNpmRipgrep(
  target,
  packageRoot,
  { provision = provisionRipgrep, stage = stageRipgrepTool } = {},
) {
  const portableTarget = portableTargetByName(target);
  if (portableTarget === undefined || NPM_RUNTIME_PACKAGE_TARGETS[target] === undefined) {
    throw new TypeError(`unsupported npm runtime package target: ${target}`);
  }
  const approval = ripgrepRuntimeApproval(
    ripgrepRuntimeTargetKey(portableTarget.nodePlatform, portableTarget.nodeArchitecture),
  );
  if (approval === undefined) throw new Error(`no pinned ripgrep for ${target}`);
  const refuse = (message) => {
    throw new Error(`ripgrep staging refused: ${message}`);
  };
  provision({
    hostPlatform: portableTarget.nodePlatform,
    hostArchitecture: portableTarget.nodeArchitecture,
    failWith: refuse,
    log: (message) => console.error(message),
  });
  stage(portableTarget, packageRoot, { onFailure: refuse });
  return approval;
}

/**
 * Stages one target into `outDir` and returns the digests the server pins. `outDir` must not exist
 * or must be empty: a runtime directory is an execution boundary, never merged into.
 */
export async function buildCodingRuntimeNpmPackage({ target, version, outDir, deps = {} }) {
  if (!isAbsolute(outDir)) throw new TypeError("outDir must be an absolute path");
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`outDir must not exist or must be empty: ${outDir}`);
  }
  const prepare = deps.prepareSidecars ?? prepareApprovedSidecarPayloads;
  const runBuild = deps.runBuild ?? runSecureWorkspaceReadBuild;
  const stageRipgrep = deps.stageRipgrep ?? stagePinnedNpmRipgrep;
  const manifest = codingRuntimePackageManifest(target, version);
  const staging = mkdtempSync(join(tmpdir(), "keiko-coding-runtime-npm-"));
  try {
    await prepare(["--target", target, "--output-root", staging], undefined, repoRoot);
    const runtimeRoot = join(outDir, "runtime");
    mkdirSync(join(runtimeRoot, "native"), { recursive: true });
    cpSync(
      join(staging, target, SIDECAR_NAME, "payload"),
      join(runtimeRoot, SIDECAR_NAME, "payload"),
      {
        recursive: true,
      },
    );
    const helperPath = join(runtimeRoot, HELPER_RELATIVE_PATH);
    const buildScript = join(repoRoot, "scripts", "build-secure-workspace-read.mjs");
    const status = await runBuild({ argv: [process.execPath, buildScript, target, helperPath] });
    if (status !== 0) throw new Error(`secure-workspace-read build failed with status ${status}`);
    const ripgrep = await stageRipgrep(target, outDir);
    mkdirSync(dirname(join(outDir, RIPGREP_SBOM_PATH)), { recursive: true });
    writeFileSync(join(outDir, RIPGREP_SBOM_PATH), ripgrepSbomText(target, ripgrep, outDir));
    writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(outDir, "LICENSE.md"), licenseNotice(target, ripgrep));
    return {
      helperSha256: sha256File(helperPath),
      helperSizeBytes: statSync(helperPath).size,
      name: manifest.name,
      outDir,
      target,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The approval compiled into this checkout for one target, with its pinned ripgrep. */
export async function loadRuntimeApproval(target) {
  const { NPM_LANE_RUNTIME_APPROVALS } =
    await import("../packages/keiko-server/dist/coding-runtime/npmLaneRuntimeApprovals.js");
  const approval = NPM_LANE_RUNTIME_APPROVALS[target];
  const portableTarget = portableTargetByName(target);
  if (approval === undefined || portableTarget === undefined) {
    throw new TypeError("unsupported npm runtime package target");
  }
  const ripgrep = ripgrepRuntimeApproval(
    ripgrepRuntimeTargetKey(portableTarget.nodePlatform, portableTarget.nodeArchitecture),
  );
  if (ripgrep === undefined) throw new TypeError("unsupported npm runtime package target");
  return { ...approval, ripgrep };
}

function verifyHelperSourceCommit(commit) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new TypeError("invalid helper source commit");
  execFileSync(
    resolveHostExecutable("git"),
    ["diff", "--quiet", "--no-ext-diff", commit, "--", "native/secure-workspace-read"],
    { cwd: repoRoot, stdio: "ignore" },
  );
}

function candidateFilePaths(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return candidateFilePaths(join(root, entry.name), path);
    const status = lstatSync(join(root, entry.name));
    if (!status.isFile() || status.nlink !== 1) {
      throw new Error("runtime candidate must contain only ordinary single-link files");
    }
    return [path];
  });
}

function candidateFileFacts(packageDir, ripgrep) {
  const paths = candidateFilePaths(packageDir).sort();
  if (!isDeepStrictEqual(paths, candidateFiles(ripgrep))) {
    throw new Error("runtime candidate must contain exactly the nine approved package files");
  }
  return fileFactsForPaths(packageDir, paths);
}

function fileFactsForPaths(packageDir, paths) {
  return paths.map((path) => {
    const full = join(packageDir, path);
    const status = statSync(full);
    return { path, sha256: sha256File(full), sizeBytes: status.size, mode: status.mode & 0o777 };
  });
}

function assertCandidatePins(files, approval, packageDir, target) {
  const ripgrep = approval.ripgrep;
  const ripgrepPath = ripgrepPortableExecutablePath(ripgrep.targetKey);
  const expected = new Map([
    [`runtime/${HELPER_RELATIVE_PATH}`, approval.helperSha256],
    [LICENSE_PATH, approval.licenseSha256],
    [SBOM_PATH, approval.sbomSha256],
    [ripgrepPath, ripgrep.binarySha256],
    [RIPGREP_PORTABLE_LICENSE_PATH, ripgrep.licenseSha256],
    [
      RIPGREP_SBOM_PATH,
      createHash("sha256")
        .update(ripgrepSbomText(target, ripgrep, packageDir))
        .digest("hex"),
    ],
  ]);
  for (const file of files) {
    const pin = expected.get(file.path);
    if (pin !== undefined && file.sha256 !== pin)
      throw new Error("runtime candidate digest mismatch");
  }
  for (const path of [EXECUTABLE_PATH, `runtime/${HELPER_RELATIVE_PATH}`, ripgrepPath]) {
    if (
      process.platform !== "win32" &&
      ((files.find((file) => file.path === path)?.mode ?? 0) & 0o111) === 0
    ) {
      throw new Error("runtime candidate binary must retain executable permissions");
    }
  }
}

async function inspectRuntimeCandidate({ target, version, packageDir }, deps) {
  if (!isAbsolute(packageDir)) throw new TypeError("packageDir must be an absolute path");
  const approval = await (deps.loadApproval ?? loadRuntimeApproval)(target);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (
    manifest.name !== approval.packageName ||
    !isDeepStrictEqual(manifest, codingRuntimePackageManifest(target, version))
  ) {
    throw new Error("runtime candidate manifest, version or architecture mismatch");
  }
  const files = candidateFileFacts(packageDir, approval.ripgrep);
  assertCandidatePins(files, approval, packageDir, target);
  const helper = files.find((file) => file.path === `runtime/${HELPER_RELATIVE_PATH}`);
  if (helper.sizeBytes !== approval.helperSizeBytes)
    throw new Error("runtime helper size mismatch");
  const sourceTreeSha256 = hashHelperSourceTree(join(repoRoot, "native/secure-workspace-read"));
  if (sourceTreeSha256 !== approval.helperSourceTreeSha256) {
    throw new Error("runtime candidate helper source is stale");
  }
  (deps.verifySourceCommit ?? verifyHelperSourceCommit)(approval.helperSourceCommit);
  const { computePortableSidecarPayloadTreeDigest } =
    await import("../packages/keiko-server/dist/coding-runtime/devLanePortableCodingRuntime.js");
  const executable = files.find((file) => file.path === EXECUTABLE_PATH);
  const executableTreeSha256 = computePortableSidecarPayloadTreeDigest([
    { relativePath: "bin/opencode", sha256: executable.sha256 },
  ]);
  if (executableTreeSha256 !== approval.executableTreeSha256) {
    throw new Error("runtime candidate OpenCode digest mismatch");
  }
  return runtimeCandidateReceipt({
    target,
    version,
    files,
    approval,
    helper,
    executableTreeSha256,
  });
}

function runtimeCandidateReceipt({
  target,
  version,
  files,
  approval,
  helper,
  executableTreeSha256,
}) {
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, "portable-runtime-approvals.json"), "utf8"),
  );
  const upstream = catalog.sidecarRuntimes.find(
    (runtime) => runtime.name === SIDECAR_NAME,
  )?.upstream;
  if (upstream?.version !== approval.upstreamVersion) throw new Error("OpenCode approval is stale");
  return {
    schemaVersion: 1,
    name: approval.packageName,
    version,
    target,
    helper: {
      sha256: helper.sha256,
      sizeBytes: helper.sizeBytes,
      sourceCommit: approval.helperSourceCommit,
      sourceTreeSha256: approval.helperSourceTreeSha256,
      maxBytes: approval.helperMaxBytes,
    },
    opencode: {
      version: upstream.version,
      sourceCommit: upstream.commit,
      executableTreeSha256,
      licenseSha256: approval.licenseSha256,
      sbomSha256: approval.sbomSha256,
    },
    // The release the server verifies `runtime/native/rg` against at every run launch.
    ripgrep: {
      version: approval.ripgrep.version,
      sourceCommit: approval.ripgrep.sourceCommit,
      archiveSha256: approval.ripgrep.archiveSha256,
      binarySha256: approval.ripgrep.binarySha256,
      licenseSha256: approval.ripgrep.licenseSha256,
    },
    files,
  };
}

export function packRuntimeCandidate(packageDir, artifactDir) {
  const npm = hostNpmInvocation(resolveHostExecutable("npm"));
  const result = execFileSync(
    npm.command,
    [
      ...npm.args,
      "pack",
      packageDir,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      artifactDir,
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: 120_000, maxBuffer: NPM_PACK_STDIO_MAX_BUFFER },
  );
  return JSON.parse(result).at(0);
}

function tarballFacts(artifactDir, filename) {
  if (typeof filename !== "string" || !/^[a-z0-9][a-z0-9._-]*\.tgz$/u.test(filename)) {
    throw new TypeError("npm pack returned an invalid tarball filename");
  }
  const path = join(artifactDir, filename);
  const status = lstatSync(path);
  if (!status.isFile() || status.nlink !== 1)
    throw new Error("candidate tarball must be an ordinary file");
  const bytes = readFileSync(path);
  return {
    filename,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function prepareArtifactDirectory(path) {
  if (!isAbsolute(path)) throw new TypeError("artifactDir must be an absolute path");
  if (existsSync(path) && (!lstatSync(path).isDirectory() || readdirSync(path).length > 0)) {
    throw new Error("artifactDir must not exist or must be an empty ordinary directory");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function assertPackedCandidate(packed, candidate) {
  if (packed?.name !== candidate.name || packed.version !== candidate.version) {
    throw new Error("npm pack returned a different package identity");
  }
  const expected = candidate.files.map((file) => ({
    path: file.path,
    size: file.sizeBytes,
    mode: file.mode,
  }));
  const files = packed.files
    ?.map(({ path, size, mode }) => ({ path, size, mode }))
    .sort((left, right) => compareStrings(left.path, right.path));
  if (!isDeepStrictEqual(files, expected)) {
    throw new Error("npm pack did not retain the approved file inventory and permissions");
  }
}

function verifyPackedContents(tarballPath, candidate) {
  const extracted = mkdtempSync(join(tmpdir(), "keiko-runtime-packed-inspection-"));
  try {
    extractPackedRuntimePackage(tarballPath, extracted);
    const actual = fileFactsForPaths(extracted, candidateFilePaths(extracted).sort(compareStrings));
    if (!isDeepStrictEqual(actual, candidate.files)) {
      throw new Error("packed contents digest, inventory or permissions mismatch");
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

/** Packs approved bytes without rebuilding them; the receipt binds their approved source commit. */
export async function packCodingRuntimeNpmCandidate(input, deps = {}) {
  const candidate = await inspectRuntimeCandidate(input, deps);
  prepareArtifactDirectory(input.artifactDir);
  const packed = (deps.pack ?? packRuntimeCandidate)(input.packageDir, input.artifactDir);
  assertPackedCandidate(packed, candidate);
  const receipt = { ...candidate, tarball: tarballFacts(input.artifactDir, packed.filename) };
  if (packed.integrity !== undefined && packed.integrity !== receipt.tarball.integrity) {
    throw new Error("npm pack tarball integrity mismatch");
  }
  const tarballPath = join(input.artifactDir, receipt.tarball.filename);
  await (deps.verifyPackedContents ?? verifyPackedContents)(tarballPath, candidate);
  if (!isDeepStrictEqual(candidate, await inspectRuntimeCandidate(input, deps))) {
    throw new Error("runtime candidate changed during packing");
  }
  const receiptPath = join(input.artifactDir, "receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  chmodSync(tarballPath, 0o444);
  return { receipt, receiptPath, tarballPath };
}

/** Rechecks a prepared candidate against current compiled pins and the actual packed tarball. */
export async function verifyCodingRuntimeNpmCandidate(input, deps = {}) {
  const receiptPath = join(input.artifactDir, "receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const expected = {
    ...(await inspectRuntimeCandidate(input, deps)),
    tarball: tarballFacts(input.artifactDir, receipt.tarball?.filename),
  };
  if (!isDeepStrictEqual(receipt, expected)) throw new Error("runtime candidate receipt mismatch");
  const tarballPath = join(input.artifactDir, receipt.tarball.filename);
  await (deps.verifyPackedContents ?? verifyPackedContents)(tarballPath, expected);
  return { receipt, receiptPath, tarballPath };
}

/** The CLI stages a package or seals an existing package as a private, unpublished candidate. */
export async function main(
  argv,
  { build = buildCodingRuntimeNpmPackage, releaseDeps = {}, write = console } = {},
) {
  if ((argv[0] === "--pack" || argv[0] === "--verify") && argv.length === 5) {
    const [, target, version, packageDir, artifactDir] = argv;
    const run =
      argv[0] === "--pack" ? packCodingRuntimeNpmCandidate : verifyCodingRuntimeNpmCandidate;
    const result = await run({ target, version, packageDir, artifactDir }, releaseDeps);
    write.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const [target, version, outDir] = argv;
  if (argv.length !== 3) {
    write.error(
      "usage: build-coding-runtime-npm-package.mjs <target> <version> <absolute-out-dir>\n" +
        "       build-coding-runtime-npm-package.mjs --pack|--verify <target> <version> <absolute-package-dir> <absolute-artifact-dir>",
    );
    return 2;
  }
  const result = await build({ target, version, outDir: resolve(outDir) });
  write.log(JSON.stringify(result, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
