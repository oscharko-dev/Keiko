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
  copyFileSync,
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
import { extractPackedRuntimePackage, stageNodeRuntime } from "./stage-portable-runtime.mjs";
import { portableTargetByName } from "./portable-runtime.mjs";
import {
  NPM_PACK_STDIO_MAX_BUFFER,
  packFiles,
  npmCommand,
  shouldShellNpmCommand,
} from "./package-surface-pack.mjs";
import { offendersForComponent } from "./check-workspace-supply-chain.mjs";
import { withCyclonedxSerialNumber } from "./lib/cyclonedx-serial-number.mjs";
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

const SERVICE_HOST_PATH = "runtime/opencode-compatible/service-host/payload";
const HOST_SOURCE_MEMBERS = [
  "host.mjs",
  "entry.mjs",
  "guard-seams.mjs",
  "package.json",
  "package-lock.json",
];

async function serviceHostOwners() {
  const [adapter, artifact, security, handoff, contract] = await Promise.all([
    import("../packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js"),
    import("../packages/keiko-server/dist/coding-runtime/opencodeServiceHostArtifact.js"),
    import("../packages/keiko-security/dist/portable-tree-attestation.js"),
    import("../packages/keiko-server/dist/update-portable-handoff-tree.js"),
    import("../packages/keiko-contracts/dist/opencode-service-host.js"),
  ]);
  return { adapter, artifact, security, handoff, contract };
}

function fixedHostAssets({ adapter, artifact }) {
  return {
    "keiko-governed-tools.mjs": adapter.createGeneratedOpenCodeV2HostFactory("direct"),
    "keiko-governed-tools-code-mode.mjs": adapter.createGeneratedOpenCodeV2HostFactory("code-mode"),
    "keiko-native-context.mjs": adapter.createGeneratedOpenCodeV2Plugins().keiko_native_context,
    "keiko-host-packet-data.mjs": artifact.createOpenCodeServiceHostPacketDataAsset(),
  };
}

function runHostNpm(root, args) {
  return execFileSync(npmCommand(), args, {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: NPM_PACK_STDIO_MAX_BUFFER,
    shell: shouldShellNpmCommand(),
  });
}

function installFixedHost(root) {
  runHostNpm(root, [
    "ci",
    "--ignore-scripts",
    "--omit=dev",
    "--workspaces=false",
    "--bin-links=false",
    "--offline",
    "--no-audit",
    "--no-fund",
  ]);
}

function originalHostSbom(root) {
  const sbom = JSON.parse(
    runHostNpm(root, ["sbom", "--sbom-format", "cyclonedx", "--omit=dev", "--workspaces=false"]),
  );
  // npm includes wall-clock build time; serial identity is derived after deterministic facts.
  if (sbom.metadata !== undefined) delete sbom.metadata.timestamp;
  return sbom;
}

function writeEvidence(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

function hostLicenseInventory(root, sbom) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const paths = candidateFilePaths(root).sort();
  const packages = paths
    .filter((path) => path.startsWith("node_modules/") && path.endsWith("/package.json"))
    .map((path) => {
      const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
      return {
        path,
        name: manifest.name ?? null,
        version: manifest.version ?? null,
        license: manifest.license ?? null,
        manifestSha256: sha256File(join(root, path)),
        role:
          lock.packages[path.slice(0, -"/package.json".length)] === undefined
            ? "bundled-package-metadata"
            : "installed-locked-dependency",
      };
    });
  return {
    schemaVersion: 1,
    packages,
    sbomCoverage: hostSbomCoverage(packages, sbom),
    noticeFiles: paths.filter((path) =>
      /\/(?:licen[cs]e|notice|copying|readme)(?:[.-].*)?$/iu.test(path),
    ),
    offenders: (sbom.components ?? []).flatMap(offendersForComponent),
  };
}

function hostSbomCoverage(packages, sbom) {
  const keys = new Set(
    (sbom.components ?? []).map((component) => `${component.name}@${component.version}`),
  );
  const installed = packages.filter((entry) => entry.role === "installed-locked-dependency");
  const covered = new Set(
    installed
      .filter((entry) => {
        const alias = entry.path.slice(0, -"/package.json".length).split("node_modules/").at(-1);
        return keys.has(`${alias}@${entry.version}`) || keys.has(`${entry.name}@${entry.version}`);
      })
      .map((entry) => `${entry.name}@${entry.version}`),
  );
  const missing = installed
    .filter((entry) => !covered.has(`${entry.name}@${entry.version}`))
    .map(({ path }) => path);
  if (missing.length > 0) throw new Error("original npm SBOM omits installed locked dependencies");
  return {
    semantics: "npm identities resolved through actual installed alias manifests",
    installedLockedPackageCount: installed.length,
    missing,
  };
}

function completeHostSbom(original, facts, nodeFacts) {
  const components = [
    ...(original.components ?? []),
    {
      type: "application",
      name: "node",
      version: facts.nodeVersion,
      "bom-ref": `node@${facts.nodeVersion}`,
      hashes: [{ alg: "SHA-256", content: nodeFacts.executableSha256 }],
      licenses: [{ license: { id: "MIT" } }],
    },
  ];
  const dependencies = (original.dependencies ?? []).map((entry) =>
    entry.ref === original.metadata?.component?.["bom-ref"]
      ? { ...entry, dependsOn: [...entry.dependsOn, `node@${facts.nodeVersion}`] }
      : entry,
  );
  dependencies.push({ ref: `node@${facts.nodeVersion}`, dependsOn: [] });
  return withCyclonedxSerialNumber({ ...original, components, dependencies });
}

function serviceThirdPartyNotice() {
  return [
    "# Original service host third-party notices",
    "",
    "Dependency license and notice files are retained unchanged under node_modules.",
    "Node.js distribution notices are retained in Node-LICENSE and Node-NOTICE.",
    "",
    "## spdx-exceptions 2.5.0",
    "",
    "SPDX license exception identifiers. Copyright © 2010–2015 Linux Foundation and its Contributors.",
    "Package contributor: Kyle E. Mitchell.",
    "Source: https://github.com/kemitchell/spdx-exceptions.json/tree/3aa64bec339abc6a3eca00c3436aaa7e154b8799.",
    "License: Creative Commons Attribution 3.0 Unported (CC-BY-3.0), https://creativecommons.org/licenses/by/3.0/.",
    "Distributed package files are unchanged. Upstream notices remain in node_modules/spdx-exceptions/README.md.",
    "No endorsement by the original authors is implied.",
    "",
    "This private candidate remains blocked by the existing license policy; this notice is not an exception.",
    "",
  ].join("\n");
}

function lockedHostInputs(source, facts) {
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(source, "package-lock.json"), "utf8"));
  const expected = {
    "@opencode/server": facts.moduleVersion,
    "@opencode/core": facts.moduleVersion,
    "@opencode/util": facts.moduleVersion,
    "@opencode/ai": facts.moduleVersion,
    "@opencode/plugin": facts.moduleVersion,
    effect: facts.effectVersion,
    "@effect/platform-node": facts.effectVersion,
    "@effect/platform-node-shared": facts.effectVersion,
  };
  if (
    manifest.private !== true ||
    !isDeepStrictEqual(manifest.dependencies, expected) ||
    !isDeepStrictEqual(lock.packages?.[""].dependencies, expected)
  ) {
    throw new Error("fixed host dependency inputs differ from the canonical module facts");
  }
  return Object.entries(lock.packages)
    .filter(([path]) => path !== "")
    .map(([path, value]) => ({
      path,
      version: value.version,
      integrity: value.integrity ?? null,
      resolved: value.resolved ?? null,
      dev: value.dev === true,
      optional: value.optional === true,
    }));
}

async function stageFixedHost(input, owners) {
  const root = join(input.outDir, SERVICE_HOST_PATH);
  const source = join(repoRoot, "native/opencode-service-host");
  const facts = owners.contract.OPENCODE_SERVICE_HOST_FIXED_FACTS;
  const lockedInputs = lockedHostInputs(source, facts);
  mkdirSync(root, { recursive: true });
  for (const member of HOST_SOURCE_MEMBERS) copyFileSync(join(source, member), join(root, member));
  const assets = fixedHostAssets(owners);
  const codec = owners.artifact.createOpenCodeServiceHostNativeCodecAsset();
  copyFileSync(codec.source, join(root, codec.filename));
  const policyAssets = owners.artifact.createOpenCodeServiceHostNativePolicyAssets();
  for (const asset of policyAssets) {
    mkdirSync(dirname(join(root, asset.filename)), { recursive: true });
    copyFileSync(asset.source, join(root, asset.filename));
  }
  for (const [path, body] of Object.entries(assets)) writeFileSync(join(root, path), body);
  await (input.deps.installHost ?? installFixedHost)(root);
  const node = await stageFixedHostNode(input, root, facts);
  const original = await (input.deps.hostSbom ?? originalHostSbom)(root);
  const sbom = completeHostSbom(original, facts, node);
  const inventory = hostLicenseInventory(root, original);
  writeEvidence(root, "evidence/sbom.cdx.json", sbom);
  writeEvidence(root, "evidence/installed-package-license-inventory.json", inventory);
  writeFileSync(join(root, "evidence/THIRD-PARTY-NOTICES.md"), serviceThirdPartyNotice());
  const sourceFiles = HOST_SOURCE_MEMBERS.map((path) => ({
    path,
    sha256: sha256File(join(source, path)),
  }));
  const generatedFiles = [
    ...Object.entries(assets).map(([path, body]) => ({
      path,
      sha256: createHash("sha256").update(body).digest("hex"),
    })),
    { path: codec.filename, sha256: sha256File(codec.source) },
    ...policyAssets.map((asset) => ({ path: asset.filename, sha256: sha256File(asset.source) })),
  ];
  writeEvidence(root, "evidence/build-provenance.json", {
    schemaVersion: 1,
    qualification: "private-functional-unapproved",
    ...facts,
    builderSha256: sha256File(fileURLToPath(import.meta.url)),
    sourceFiles,
    generatedFiles,
    lockedInputs,
    node,
    sourceBuildProvenance: facts.sourceBuildProvenance,
  });
  return { root, inventory, node };
}

async function stageFixedHostNode(input, root, facts) {
  const staging = mkdtempSync(join(tmpdir(), "keiko-service-node-"));
  try {
    const options = { ...input.node, nodeVersion: facts.nodeVersion };
    const archiveSha256 = await (input.deps.stageNode ?? stageNodeRuntime)(
      options,
      portableTargetByName(input.target),
      staging,
    );
    const source = join(staging, "runtime/node");
    mkdirSync(join(root, "runtime"), { recursive: true });
    copyFileSync(join(source, "bin/node"), join(root, facts.nodeExecutablePath));
    for (const name of ["LICENSE", "NOTICE"]) {
      mkdirSync(join(root, "evidence"), { recursive: true });
      copyFileSync(join(source, name), join(root, "evidence", `Node-${name}`));
    }
    return {
      archiveSha256,
      executableSha256: sha256File(join(root, facts.nodeExecutablePath)),
      licenseSha256: sha256File(join(root, "evidence/Node-LICENSE")),
      noticeSha256: sha256File(join(root, "evidence/Node-NOTICE")),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function servicePackedFileFacts(packageDir) {
  const staged = candidateFilePaths(packageDir).sort();
  const packed = packFiles({ packageDir })
    .map(({ path }) => path)
    .sort();
  const retained = new Set(packed);
  const stagedSet = new Set(staged);
  const excluded = staged.filter((path) => !retained.has(path));
  if (
    excluded.some(
      (path) =>
        !path.startsWith(`${SERVICE_HOST_PATH}/node_modules/`) || !path.endsWith("/.npmignore"),
    )
  ) {
    throw new Error("npm excluded required service payload files");
  }
  if (packed.some((path) => !stagedSet.has(path)))
    throw new Error("npm added unknown service payload files");
  return { files: fileFactsForPaths(packageDir, packed), excluded };
}

async function attestServiceHost(root, owners) {
  const selected = owners.artifact.OPENCODE_SERVICE_HOST_DISK_EVIDENCE.map(([path]) => path);
  return owners.security.attestPortableSidecarTree(
    root,
    owners.contract.OPENCODE_SERVICE_HOST_FIXED_FACTS.nodeExecutablePath,
    owners.handoff.portableHandoffOperationFrom({ deadline: Date.now() + 300_000 }),
    selected,
  );
}

async function inspectPackedService(owners, candidate, tarballPath) {
  const extracted = mkdtempSync(join(tmpdir(), "keiko-service-packed-"));
  try {
    extractPackedRuntimePackage(tarballPath, extracted);
    const actual = fileFactsForPaths(extracted, candidateFilePaths(extracted).sort());
    if (!isDeepStrictEqual(actual, candidate.files))
      throw new Error("packed service bytes, inventory or permissions mismatch");
    const root = join(extracted, SERVICE_HOST_PATH);
    const attestation = await attestServiceHost(root, owners);
    const hostFiles = actual.filter((file) => file.path.startsWith(`${SERVICE_HOST_PATH}/`));
    return {
      ...attestation,
      payloadFileCount: hostFiles.length,
      payloadSizeBytes: hostFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      nodeVersion: owners.contract.OPENCODE_SERVICE_HOST_FIXED_FACTS.nodeVersion,
      moduleVersion: owners.contract.OPENCODE_SERVICE_HOST_FIXED_FACTS.moduleVersion,
    };
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

/** Private nonpublishable engineering artifact; no catalog approval, selector, or license exception. */
export async function buildCodingRuntimeNpmServiceHostCandidate(input) {
  const deps = input.deps ?? {};
  const build = await buildCodingRuntimeNpmPackage({ ...input, deps });
  const owners = await serviceHostOwners();
  const host = await stageFixedHost({ ...input, deps }, owners);
  const manifest = { ...codingRuntimePackageManifest(input.target, input.version), private: true };
  delete manifest.publishConfig;
  writeEvidence(input.outDir, "package.json", manifest);
  writeFileSync(
    join(input.outDir, "LICENSE.md"),
    licenseNotice(input.target) +
      "\nThe private original service host retains its full dependency notices and SBOM under\n`runtime/opencode-compatible/service-host/payload/evidence`. Its license review is pending.\n",
  );
  const stagedAttestation = await attestServiceHost(host.root, owners);
  const candidate = servicePackedFileFacts(input.outDir);
  const artifactDir = input.artifactDir ?? join(dirname(input.outDir), "artifacts");
  prepareArtifactDirectory(artifactDir);
  const packed = packRuntimeCandidate(input.outDir, artifactDir);
  assertPackedCandidate(packed, { ...build, version: input.version, files: candidate.files });
  const tarball = tarballFacts(artifactDir, packed.filename);
  if (packed.integrity !== tarball.integrity) throw new Error("service tarball integrity mismatch");
  const final = await inspectPackedService(owners, candidate, join(artifactDir, packed.filename));
  if (!isDeepStrictEqual(stagedAttestation, await attestServiceHost(host.root, owners)))
    throw new Error("staged service changed during packing");
  return sealPrivateServiceReceipt(input, build, host, candidate, tarball, final, artifactDir);
}

function sealPrivateServiceReceipt(input, build, host, candidate, tarball, final, artifactDir) {
  const license = {
    status: host.inventory.offenders.length > 0 ? "blocked" : "unreviewed",
    offenders: host.inventory.offenders,
  };
  const receipt = {
    schemaVersion: 1,
    qualification: "private-functional-unapproved",
    name: build.name,
    version: input.version,
    target: input.target,
    license,
    tarball,
    finalPayload: final,
    excludedNpmMetadata: candidate.excluded,
    files: candidate.files,
  };
  const receiptPath = join(artifactDir, "service-host-private-receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  chmodSync(join(artifactDir, tarball.filename), 0o444);
  return {
    ...receipt,
    outDir: input.outDir,
    receiptPath,
    tarballPath: join(artifactDir, tarball.filename),
  };
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
  return fileFactsForPaths(packageDir, paths);
}

function fileFactsForPaths(packageDir, paths) {
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
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (!isDeepStrictEqual(files, expected)) {
    throw new Error("npm pack did not retain the approved file inventory and permissions");
  }
}

function verifyPackedContents(tarballPath, candidate) {
  const extracted = mkdtempSync(join(tmpdir(), "keiko-runtime-packed-inspection-"));
  try {
    extractPackedRuntimePackage(tarballPath, extracted);
    const actual = fileFactsForPaths(extracted, candidateFilePaths(extracted).sort());
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
