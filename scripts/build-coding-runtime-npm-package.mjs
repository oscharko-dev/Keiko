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
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { prepareApprovedSidecarPayloads } from "./prepare-approved-sidecar-payloads.mjs";
import { hashHelperSourceTree } from "./stage-dev-coding-runtime.mjs";
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
const CANDIDATE_FILES = [
  "LICENSE.md",
  "package.json",
  `runtime/${HELPER_RELATIVE_PATH}`,
  EXECUTABLE_PATH,
  LICENSE_PATH,
  SBOM_PATH,
].sort();

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
      "executable and Keiko's native secure workspace read helper. Verified by Keiko at every start.",
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

function licenseNotice(target) {
  return [
    `# ${codingRuntimePackageName(target)}`,
    "",
    "This package redistributes two components:",
    "",
    "- `runtime/opencode-compatible/payload/bin/opencode`: OpenCode, MIT License. The upstream",
    "  license text is `runtime/opencode-compatible/payload/evidence/LICENSE`, and its software",
    "  bill of materials is `runtime/opencode-compatible/payload/evidence/sbom.cdx.json`.",
    "- `runtime/native/keiko-secure-workspace-read`: part of Keiko, under Keiko's license",
    "  (https://github.com/oscharko-dev/Keiko/blob/dev/LICENSE).",
    "",
  ].join("\n");
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
    writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(outDir, "LICENSE.md"), licenseNotice(target));
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

async function loadRuntimeApproval(target) {
  const { NPM_LANE_RUNTIME_APPROVALS } =
    await import("../packages/keiko-server/dist/coding-runtime/npmLaneRuntimeApprovals.js");
  const approval = NPM_LANE_RUNTIME_APPROVALS[target];
  if (approval === undefined) throw new TypeError("unsupported npm runtime package target");
  return approval;
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

function candidateFileFacts(packageDir) {
  const paths = candidateFilePaths(packageDir).sort();
  if (!isDeepStrictEqual(paths, CANDIDATE_FILES)) {
    throw new Error("runtime candidate must contain exactly the six approved package files");
  }
  return paths.map((path) => {
    const full = join(packageDir, path);
    const status = statSync(full);
    return { path, sha256: sha256File(full), sizeBytes: status.size, mode: status.mode & 0o777 };
  });
}

function assertCandidatePins(files, approval) {
  const expected = new Map([
    [`runtime/${HELPER_RELATIVE_PATH}`, approval.helperSha256],
    [LICENSE_PATH, approval.licenseSha256],
    [SBOM_PATH, approval.sbomSha256],
  ]);
  for (const file of files) {
    const pin = expected.get(file.path);
    if (pin !== undefined && file.sha256 !== pin)
      throw new Error("runtime candidate digest mismatch");
  }
  for (const path of [EXECUTABLE_PATH, `runtime/${HELPER_RELATIVE_PATH}`]) {
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
  const files = candidateFileFacts(packageDir);
  assertCandidatePins(files, approval);
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
    files,
  };
}

function packRuntimeCandidate(packageDir, artifactDir) {
  const result = execFileSync(
    resolveHostExecutable("npm"),
    ["pack", packageDir, "--ignore-scripts", "--json", "--pack-destination", artifactDir],
    { cwd: repoRoot, encoding: "utf8", timeout: 120_000, maxBuffer: 1_048_576 },
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
  const files = packed.files?.map(({ path, size, mode }) => ({ path, size, mode }));
  if (!isDeepStrictEqual(files, expected)) {
    throw new Error("npm pack did not retain the approved file inventory and permissions");
  }
}

function runCandidateTar(args, options = {}) {
  try {
    return execFileSync(resolveHostExecutable("tar"), args, {
      timeout: 120_000,
      maxBuffer: 1_048_576,
      ...options,
    });
  } catch {
    throw new Error("candidate tarball inspection failed");
  }
}

function tarPermissionPrefix(mode) {
  const bits = "rwxrwxrwx";
  return `-${[...bits].map((bit, index) => ((mode & (1 << (8 - index))) === 0 ? "-" : bit)).join("")}`;
}

function verifyPackedContents(tarballPath, candidate) {
  const members = candidate.files.map((file) => `package/${file.path}`);
  const actual = runCandidateTar(["-tzf", tarballPath], { encoding: "utf8" }).trimEnd().split("\n");
  const details = runCandidateTar(["-tvzf", tarballPath], { encoding: "utf8" })
    .trimEnd()
    .split("\n");
  if (!isDeepStrictEqual([...actual].sort(), members) || details.length !== members.length) {
    throw new Error("packed contents do not match the approved file inventory");
  }
  const orderedFiles = actual.map((member) =>
    candidate.files.find((file) => `package/${file.path}` === member),
  );
  for (const [index, file] of orderedFiles.entries()) {
    if (!details[index].startsWith(tarPermissionPrefix(file.mode))) {
      throw new Error("packed contents do not retain approved ordinary-file permissions");
    }
  }
  const expectedSize = candidate.files.reduce((size, file) => size + file.sizeBytes, 0);
  const body = runCandidateTar(["-xzOf", tarballPath, ...actual], { maxBuffer: expectedSize + 1 });
  if (body.length !== expectedSize) throw new Error("packed contents size mismatch");
  let offset = 0;
  for (const file of orderedFiles) {
    const bytes = body.subarray(offset, offset + file.sizeBytes);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error("packed contents digest mismatch");
    }
    offset += file.sizeBytes;
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
  (deps.verifyPackedContents ?? verifyPackedContents)(tarballPath, candidate);
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
  (deps.verifyPackedContents ?? verifyPackedContents)(tarballPath, expected);
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
