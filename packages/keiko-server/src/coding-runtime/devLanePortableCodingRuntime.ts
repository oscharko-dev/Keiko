import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import type { LongLivedRuntimeQualification } from "@oscharko-dev/keiko-sandbox";

import { productionUpdateFacts } from "../update-install-mode.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import {
  OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
  OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM,
} from "./opencodeProtocolSurface.js";
import type { SecureWorkspaceTextReadArtifact } from "./secureWorkspaceTextReadArtifact.js";

export const KEIKO_CODING_RUNTIME_DEV_LANE_ENV = "KEIKO_CODING_RUNTIME_DEV_LANE";
export const DEV_LANE_STAGED_PAYLOADS_DIR = ".portable-sidecar-payloads";
export const DEV_LANE_MANIFEST_FILE = "dev-lane-manifest.json";
export const DEV_LANE_HELPER_RELATIVE_PATH = "native/keiko-secure-workspace-read";
export const DEV_LANE_RUNTIME_SUPERVISOR_RELATIVE_PATH = "native/keiko-runtime-supervisor";

const APPROVALS_CATALOG_FILE = "portable-runtime-approvals.json";
const SIDECAR_NAME = "opencode-compatible";
const HELPER_SOURCE_DIR = "native/secure-workspace-read";
const ENABLE_TOKENS = new Set(["1", "true", "on", "yes", "enabled"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

export type DevLaneOpenCodeTarget = "windows-x64" | "macos-arm64" | "macos-x64";

export type DevLaneOpenCodeRefusalReason =
  | "platform-unsupported"
  | "packaged-install-present"
  | "not-a-dev-checkout"
  | "payload-missing"
  | "payload-unapproved"
  | "payload-tampered"
  | "native-helper-directory-untrusted"
  | "secure-read-helper-missing"
  | "secure-read-helper-stale";

export interface DevLaneSecureReadBinding {
  readonly helperPath: string;
  readonly helperSizeBytes: number;
  readonly artifact: SecureWorkspaceTextReadArtifact;
}

/**
 * Development-lane stand-in for a platform-qualified portable OpenCode runtime (#2475). The
 * payload is verified byte-for-byte against the review-approved redistribution catalog, but the
 * lane deliberately carries no platform signature chain and no supervisor qualification —
 * `evidenceClass` and the honest availability booleans record exactly that posture (ADR-0140).
 */
export interface DevLanePortableOpenCodeRuntime {
  readonly evidenceClass: "functional-not-platform-qualified";
  readonly lane: "dev-checkout";
  readonly installRoot: string;
  readonly target: DevLaneOpenCodeTarget;
  readonly sidecar: PortableSidecarRuntimeVerification;
  readonly qualification: LongLivedRuntimeQualification;
  readonly secureRead: DevLaneSecureReadBinding;
  /** Present on Windows, where the native Job Object supervisor is part of the dev-lane layout. */
  readonly nativeHelperPath?: string | undefined;
  /** The verified Windows supervisor digest is re-checked immediately before every spawn. */
  readonly nativeHelperSha256?: string | undefined;
}

export type DevLaneOpenCodeDiscovery =
  | { readonly outcome: "inactive" }
  | { readonly outcome: "refused"; readonly reason: DevLaneOpenCodeRefusalReason }
  | { readonly outcome: "activated"; readonly runtime: DevLanePortableOpenCodeRuntime };

export interface DevLaneOpenCodeDiscoveryInput {
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
}

export function devLaneEnvEnabled(value: string | undefined): boolean {
  return value !== undefined && ENABLE_TOKENS.has(value.trim().toLowerCase());
}

/**
 * Explicit, opt-in discovery of a locally staged, review-approved OpenCode payload on a supported
 * repository checkout. Structural confinement is evaluated before any payload trust: a package
 * root that carries a packaged-install manifest, or that is not a repository checkout, refuses
 * the lane regardless of what is staged. Packaged installs never reach the verification steps.
 */
export function discoverDevLaneOpenCode(
  input: DevLaneOpenCodeDiscoveryInput,
): DevLaneOpenCodeDiscovery {
  if (!devLaneEnvEnabled(input.env[KEIKO_CODING_RUNTIME_DEV_LANE_ENV])) {
    return { outcome: "inactive" };
  }
  try {
    return discoverEnabledLane(input);
  } catch {
    return refused("payload-tampered");
  }
}

function discoverEnabledLane(input: DevLaneOpenCodeDiscoveryInput): DevLaneOpenCodeDiscovery {
  const target = targetFromDiscoveryInput(input);
  if (target === undefined) return refused("platform-unsupported");
  const checkoutRoot = devCheckoutRoot(input.env);
  if (checkoutRoot.refusal !== undefined) return refused(checkoutRoot.refusal);
  const approved = approvedSidecar(checkoutRoot.root, target);
  if (approved === undefined) return refused("payload-unapproved");
  const stagedTargetRoot = join(checkoutRoot.root, DEV_LANE_STAGED_PAYLOADS_DIR, target);
  const payload = verifiedPayload(join(stagedTargetRoot, SIDECAR_NAME), target, approved);
  if (!payload.ok) return refused(payload.refusal);
  const secureRead = verifiedSecureRead(checkoutRoot.root, stagedTargetRoot, target);
  if (!secureRead.ok) return refused(secureRead.refusal);
  const runtimeSupervisor = verifiedRuntimeSupervisor(checkoutRoot.root, stagedTargetRoot, target);
  if (target === "windows-x64" && runtimeSupervisor === undefined)
    return refused("payload-missing");
  if (!trustedNativeHelperDirectory(stagedTargetRoot, target)) {
    return refused("native-helper-directory-untrusted");
  }
  return activatedDevLaneRuntime(
    target,
    stagedTargetRoot,
    payload.sidecar,
    secureRead.binding,
    runtimeSupervisor,
  );
}

function targetFromDiscoveryInput(
  input: DevLaneOpenCodeDiscoveryInput,
): DevLaneOpenCodeTarget | undefined {
  return devLaneTarget(input.platform ?? process.platform, input.arch ?? process.arch);
}

function activatedDevLaneRuntime(
  target: DevLaneOpenCodeTarget,
  stagedTargetRoot: string,
  sidecar: PortableSidecarRuntimeVerification,
  secureRead: DevLaneSecureReadBinding,
  runtimeSupervisor: VerifiedRuntimeSupervisor | undefined,
): DevLaneOpenCodeDiscovery {
  const runtime = {
    evidenceClass: "functional-not-platform-qualified" as const,
    lane: "dev-checkout" as const,
    installRoot: join(stagedTargetRoot, SIDECAR_NAME),
    target,
    sidecar,
    qualification: devLaneQualification(target, sidecar, secureRead, runtimeSupervisor),
    secureRead,
  };
  if (runtimeSupervisor === undefined) return { outcome: "activated", runtime };
  return {
    outcome: "activated",
    runtime: {
      ...runtime,
      nativeHelperPath: runtimeSupervisor.path,
      nativeHelperSha256: runtimeSupervisor.sha256,
    },
  };
}

function refused(reason: DevLaneOpenCodeRefusalReason): DevLaneOpenCodeDiscovery {
  return { outcome: "refused", reason };
}

function devLaneTarget(platform: NodeJS.Platform, arch: string): DevLaneOpenCodeTarget | undefined {
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform !== "darwin") return undefined;
  if (arch === "arm64") return "macos-arm64";
  return arch === "x64" ? "macos-x64" : undefined;
}

interface DevCheckoutRoot {
  readonly root: string;
  readonly refusal?: DevLaneOpenCodeRefusalReason | undefined;
}

function devCheckoutRoot(env: NodeJS.ProcessEnv): DevCheckoutRoot {
  const root = productionUpdateFacts(env).packageRoot;
  if (root === undefined) return { root: "", refusal: "not-a-dev-checkout" };
  const packagedManifests = [
    join(root, ".portable", "update-portable-manifest.json"),
    join(root, ".portable", "setup-manifest.json"),
  ];
  if (packagedManifests.some((path) => existsSync(path))) {
    return { root, refusal: "packaged-install-present" };
  }
  const checkoutMarkers = [join(root, ".git"), join(root, "tsconfig.packages.json")];
  if (!checkoutMarkers.some((path) => existsSync(path))) {
    return { root, refusal: "not-a-dev-checkout" };
  }
  return { root };
}

interface ApprovedDevLaneSidecar {
  readonly upstreamVersion: string;
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly executableTreeSha256: string;
  readonly licenseSha256: string;
  readonly protocolSchemaSha256: string;
  // KEIKO-0763/KEIKO-0763-r3: catalog-approved SBOM digest for this target. verifiedPayload
  // compares it against the SBOM file's freshly-hashed contents so a tampered SBOM cannot slip
  // past the dev lane's payload-verification step. Sourced from the catalog's runtime.archives
  // [target] entry alongside executableTreeSha256. REQUIRED, not optional: an earlier revision
  // let a catalog entry that omitted sbomSha256 skip the comparison entirely, so a modified SBOM
  // was silently accepted (its freshly-computed digest reported back as if it had been verified).
  // A target
  // whose catalog entry has no sbomSha256 now fails approvedSidecarShape and is treated exactly
  // like any other incomplete catalog entry -- refused "payload-unapproved" by the existing
  // `approved === undefined` check in discoverDevLaneOpenCode, never silently downgraded to
  // "compare what we can". Restoring the dev lane on the real catalog requires a human,
  // PR-reviewed addition of the real upstream SBOM digest to portable-runtime-approvals.json (see
  // that file's own header: digest changes there are the release-approval act).
  readonly sbomSha256: string;
}

/** The checked-in redistribution catalog is the dev lane's review-approved trust anchor. */
function approvedSidecar(
  root: string,
  target: DevLaneOpenCodeTarget,
): ApprovedDevLaneSidecar | undefined {
  const runtime = approvedCatalogRuntime(join(root, APPROVALS_CATALOG_FILE));
  if (runtime === undefined) return undefined;
  const candidate = candidateSidecarFromCatalog(runtime, target);
  return approvedSidecarShape(candidate) ? candidate : undefined;
}

/**
 * Reads the per-target candidate sidecar fields out of the catalog's runtime record. Each field
 * is read via optional chaining through possibly-absent nested records, so a missing or malformed
 * catalog entry surfaces here as `undefined` rather than a throw; approvedSidecarShape is the one
 * place that decides whether the result is complete enough to trust.
 */
function candidateSidecarFromCatalog(
  runtime: Record<string, unknown>,
  target: DevLaneOpenCodeTarget,
): Partial<Record<keyof ApprovedDevLaneSidecar, unknown>> {
  const adapter = record(runtime.adapterCompatibility);
  const archiveEntry = record(record(runtime.archives)?.[target]);
  return {
    upstreamVersion: record(runtime.upstream)?.version,
    adapterName: adapter?.adapterName,
    adapterVersion: adapter?.adapterVersion,
    executableTreeSha256: archiveEntry?.executableTreeSha256,
    licenseSha256: record(runtime.license)?.sha256,
    protocolSchemaSha256: record(runtime.protocolSchema)?.sha256,
    sbomSha256: archiveEntry?.sbomSha256,
  };
}

function approvedSidecarShape(
  candidate: Partial<Record<keyof ApprovedDevLaneSidecar, unknown>>,
): candidate is ApprovedDevLaneSidecar {
  return (
    typeof candidate.upstreamVersion === "string" &&
    typeof candidate.adapterName === "string" &&
    typeof candidate.adapterVersion === "string" &&
    isSha256(candidate.executableTreeSha256) &&
    isSha256(candidate.licenseSha256) &&
    isSha256(candidate.protocolSchemaSha256) &&
    isSha256(candidate.sbomSha256)
  );
}

function approvedCatalogRuntime(catalogPath: string): Record<string, unknown> | undefined {
  const runtimes = readRecord(catalogPath)?.sidecarRuntimes;
  if (!Array.isArray(runtimes)) return undefined;
  const runtime = runtimes.map(record).find((entry) => entry?.name === SIDECAR_NAME);
  if (runtime?.kind !== "coding-runtime") return undefined;
  const redistribution = record(record(runtime.releaseApproval)?.redistribution);
  return redistribution?.status === "approved" ? runtime : undefined;
}

type VerifiedDevLanePayload =
  | { readonly ok: true; readonly sidecar: PortableSidecarRuntimeVerification }
  | { readonly ok: false; readonly refusal: DevLaneOpenCodeRefusalReason };

function verifiedPayload(
  installRoot: string,
  target: DevLaneOpenCodeTarget,
  approved: ApprovedDevLaneSidecar,
): VerifiedDevLanePayload {
  const executablePath = `payload/bin/${target === "windows-x64" ? "opencode.exe" : "opencode"}`;
  const licensePath = "payload/evidence/LICENSE";
  const sbomPath = "payload/evidence/sbom.cdx.json";
  const files = [executablePath, licensePath, sbomPath].map((file) => join(installRoot, file));
  if (!files.every(isRegularFile)) return { ok: false, refusal: "payload-missing" };
  const executableSha256 = sha256File(join(installRoot, executablePath));
  const executableTreeSha256 = digestText(
    `bin/${target === "windows-x64" ? "opencode.exe" : "opencode"}\0${executableSha256}\0`,
  );
  // KEIKO-0763/KEIKO-0763-r3: verify the SBOM's on-disk contents against the catalog-approved
  // digest the same way the executable-tree and license checks work. approved.sbomSha256 is
  // REQUIRED (approvedSidecarShape refuses "payload-unapproved" before this function is ever
  // reached without one), so this comparison always runs -- a drift-only SBOM (identical binary,
  // mutated provenance) can no longer flow through as "verified" by skipping the comparison.
  const sbomEvidenceSha256 = sha256File(join(installRoot, sbomPath));
  if (
    executableTreeSha256 !== approved.executableTreeSha256 ||
    sha256File(join(installRoot, licensePath)) !== approved.licenseSha256 ||
    sbomEvidenceSha256 !== approved.sbomSha256
  ) {
    return { ok: false, refusal: "payload-tampered" };
  }
  const payloadRoot = join(installRoot, "payload");
  return {
    ok: true,
    sidecar: {
      payloadRootPath: "payload",
      executablePath,
      shippedExecutableSha256: executableSha256,
      executableTreeSha256,
      licenseEvidencePath: licensePath,
      licenseEvidenceSha256: approved.licenseSha256,
      sbomEvidencePath: sbomPath,
      sbomEvidenceSha256,
      protocolSchemaRawSha256: approved.protocolSchemaSha256,
      protocolHandshakeDigest: OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
      protocolHandshakeAlgorithm: OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM,
      availability: devLaneAvailability(),
      summary: devLaneSummary(target, approved, payloadRoot, join(installRoot, executablePath)),
    },
  };
}

/**
 * Honest availability record: only checks the dev lane actually performs are marked verified.
 * Platform signature chains and supervisor qualification are deliberately absent on this lane
 * (ADR-0140); recording them as verified would forge packaged-grade evidence.
 */
function devLaneAvailability(): PortableSidecarRuntimeVerification["availability"] {
  return {
    redistributionApproved: true,
    payloadPresent: true,
    archiveDigestVerified: true,
    executableTreeDigestVerified: true,
    runtimeVersionVerified: true,
    protocolSchemaVerified: true,
    signatureVerified: false,
    qualificationVerified: false,
  };
}

function devLaneSummary(
  target: DevLaneOpenCodeTarget,
  approved: ApprovedDevLaneSidecar,
  payloadRoot: string,
  executable: string,
): PortableSidecarRuntimeVerification["summary"] {
  const payloadSha256 = hashDirectoryTree(payloadRoot);
  return {
    name: SIDECAR_NAME,
    kind: "coding-runtime",
    upstreamName: "opencode",
    upstreamVersion: approved.upstreamVersion,
    adapterName: approved.adapterName,
    adapterVersion: approved.adapterVersion,
    protocolVersion: "http-sse",
    platformTarget: target,
    payloadSha256,
    payloadSha256Prefix: payloadSha256.slice(0, 12),
    sizeBytes: statSync(executable).size,
    status: "verified",
  };
}

type VerifiedDevLaneSecureRead =
  | { readonly ok: true; readonly binding: DevLaneSecureReadBinding }
  | { readonly ok: false; readonly refusal: DevLaneOpenCodeRefusalReason };

function verifiedSecureRead(
  checkoutRoot: string,
  stagedTargetRoot: string,
  target: DevLaneOpenCodeTarget,
): VerifiedDevLaneSecureRead {
  const helperPath = join(stagedTargetRoot, helperRelativePath(target));
  const manifest = devLaneManifestHelper(join(stagedTargetRoot, DEV_LANE_MANIFEST_FILE), target);
  if (manifest === undefined || !isRegularFile(helperPath)) {
    return { ok: false, refusal: "secure-read-helper-missing" };
  }
  const helperStat = statSync(helperPath);
  if (
    sha256File(helperPath) !== manifest.sha256 ||
    helperStat.size !== manifest.sizeBytes ||
    hashHelperSourceTree(join(checkoutRoot, HELPER_SOURCE_DIR)) !== manifest.sourceTreeSha256
  ) {
    return { ok: false, refusal: "secure-read-helper-stale" };
  }
  return {
    ok: true,
    binding: {
      helperPath,
      helperSizeBytes: manifest.sizeBytes,
      artifact: {
        target: secureReadTarget(target),
        installRelativePath: `runtime/${helperRelativePath(target)}`,
        sha256: manifest.sha256,
        protocol: "KSR1/KSS1",
        sourceCommit: manifest.sourceCommit,
        sourceTreeSha256: manifest.sourceTreeSha256,
        // The dev-lane helper is verified by its content digest, never by a release signature chain.
        signed: true,
      },
    },
  };
}

interface VerifiedRuntimeSupervisor {
  readonly path: string;
  readonly sha256: string;
}

function verifiedRuntimeSupervisor(
  checkoutRoot: string,
  stagedTargetRoot: string,
  target: DevLaneOpenCodeTarget,
): VerifiedRuntimeSupervisor | undefined {
  if (target !== "windows-x64") return undefined;
  const path = join(stagedTargetRoot, runtimeSupervisorRelativePath(target));
  const manifest = devLaneManifestRuntimeSupervisor(
    join(stagedTargetRoot, DEV_LANE_MANIFEST_FILE),
    target,
  );
  if (manifest === undefined || !isRegularFile(path)) return undefined;
  const sha256 = sha256File(path);
  return sha256 === manifest.sha256 &&
    statSync(path).size === manifest.sizeBytes &&
    hashHelperSourceTree(join(checkoutRoot, "native", "runtime-supervisor", "windows")) ===
      manifest.sourceTreeSha256
    ? { path, sha256 }
    : undefined;
}

function trustedNativeHelperDirectory(
  stagedTargetRoot: string,
  target: DevLaneOpenCodeTarget,
): boolean {
  const nativeDirectory = join(stagedTargetRoot, "native");
  const expected = new Set([basename(helperRelativePath(target))]);
  if (target === "windows-x64") expected.add(basename(runtimeSupervisorRelativePath(target)));
  try {
    const entries = readdirSync(nativeDirectory);
    return (
      entries.length === expected.size &&
      entries.every((entry) => expected.has(entry) && isRegularFile(join(nativeDirectory, entry)))
    );
  } catch {
    return false;
  }
}

interface DevLaneHelperManifest {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly sourceCommit: string;
  readonly sourceTreeSha256: string;
}

function devLaneManifestHelper(
  manifestPath: string,
  target: DevLaneOpenCodeTarget,
): DevLaneHelperManifest | undefined {
  const manifest = readRecord(manifestPath);
  if (manifest?.schemaVersion !== 1 || manifest.target !== target) return undefined;
  return validDevLaneHelperManifest(record(manifest.helper));
}

function devLaneManifestRuntimeSupervisor(
  manifestPath: string,
  target: DevLaneOpenCodeTarget,
): DevLaneHelperManifest | undefined {
  if (target !== "windows-x64") return undefined;
  const manifest = readRecord(manifestPath);
  if (manifest?.schemaVersion !== 1 || manifest.target !== target) return undefined;
  return validDevLaneHelperManifest(record(manifest.runtimeSupervisor));
}

function validDevLaneHelperManifest(
  helper: Record<string, unknown> | undefined,
): DevLaneHelperManifest | undefined {
  if (helper === undefined || !isSha256(helper.sha256) || !isSha256(helper.sourceTreeSha256)) {
    return undefined;
  }
  if (!positiveSafeInteger(helper.sizeBytes) || !isCommitSha(helper.sourceCommit)) {
    return undefined;
  }
  return {
    sha256: helper.sha256,
    sizeBytes: helper.sizeBytes,
    sourceCommit: helper.sourceCommit,
    sourceTreeSha256: helper.sourceTreeSha256,
  };
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT.test(value);
}

/**
 * A deterministic receipt over the dev-lane admission facts. It satisfies the structural
 * qualification identity the supervisor requires; it is not a platform qualification receipt.
 */
function devLaneQualification(
  target: DevLaneOpenCodeTarget,
  sidecar: PortableSidecarRuntimeVerification,
  secureRead: DevLaneSecureReadBinding,
  runtimeSupervisor: VerifiedRuntimeSupervisor | undefined,
): LongLivedRuntimeQualification {
  const binding = JSON.stringify({
    lane: "dev-checkout",
    target,
    executableTreeSha256: sidecar.executableTreeSha256,
    helperSha256: secureRead.artifact.sha256,
    runtimeSupervisorSha256: runtimeSupervisor?.sha256,
  });
  return {
    platform: target === "windows-x64" ? "win32" : "darwin",
    arch: target === "macos-arm64" ? "arm64" : "x64",
    backend: target === "windows-x64" ? "windows-job-object" : "macos-app-sandbox",
    releaseReceipt: `sha256:${digestText(binding)}`,
  };
}

function helperRelativePath(target: DevLaneOpenCodeTarget): string {
  return `${DEV_LANE_HELPER_RELATIVE_PATH}${target === "windows-x64" ? ".exe" : ""}`;
}

function runtimeSupervisorRelativePath(target: DevLaneOpenCodeTarget): string {
  return `${DEV_LANE_RUNTIME_SUPERVISOR_RELATIVE_PATH}${target === "windows-x64" ? ".exe" : ""}`;
}

function secureReadTarget(
  target: DevLaneOpenCodeTarget,
): "win32-x64" | "darwin-arm64" | "darwin-x64" {
  if (target === "windows-x64") return "win32-x64";
  return target === "macos-arm64" ? "darwin-arm64" : "darwin-x64";
}

/** One lstat call: regular, non-symlink, single hard link — mirrors the hardened path helpers. */
function isRegularFile(path: string): boolean {
  try {
    const status = lstatSync(path, { bigint: true });
    return status.isFile() && !status.isSymbolicLink() && status.nlink === 1n;
  } catch {
    return false;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * KEIKO-0180 (and #3099 P2 follow-up): SINGLE canonical formula shared by the production tree
 * walker, the discovery pipeline, and tests. Given a set of `(relativePath, sha256)` pairs,
 * produces the tree digest — locale-sorted (the payload lane matches `localeCompare`). The
 * production directory walker `hashDirectoryTree` DELEGATES to this function so a formula
 * change touches one place and every consumer (including the manager test fixture) moves with
 * it. A test that hand-restated the concatenation could formerly drift silently; that path is
 * now closed.
 */
export function computePortableSidecarPayloadTreeDigest(
  entries: readonly { readonly relativePath: string; readonly sha256: string }[],
): string {
  const hash = createHash("sha256");
  const sorted = [...entries].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  for (const entry of sorted) {
    hash.update(`${entry.relativePath}\0${entry.sha256}\0`);
  }
  return hash.digest("hex");
}

/**
 * In-process payload digest. Delegates to the canonical
 * `computePortableSidecarPayloadTreeDigest` above — one formula, one place. Mirrors
 * `inspectStagedSidecarPayload`'s tree walk (locale-sorted) so the launch-time re-check agrees
 * byte-for-byte with the discovery-recorded summary.
 */
function hashDirectoryTree(root: string): string {
  const entries: { readonly relativePath: string; readonly sha256: string }[] = [];
  // #3099 R8 KfQ perf: `computePortableSidecarPayloadTreeDigest` re-sorts internally, so
  // passing a no-op comparator to `listFiles` avoids the redundant O(n log n) sort on the
  // discovery walk. Array.sort in modern V8 is stable, so `() => 0` preserves insertion order
  // (irrelevant here — the helper sorts by relativePath itself).
  for (const file of listFiles(root, () => 0)) {
    entries.push({
      relativePath: relative(root, file).split(sep).join("/"),
      sha256: sha256File(file),
    });
  }
  return computePortableSidecarPayloadTreeDigest(entries);
}

/**
 * Cross-process helper-source digest. The staging script records `sourceTreeSha256` in one
 * process and discovery re-derives it in another; a locale-dependent collation could diverge
 * between those processes and report a false stale helper, so this ordering is plain
 * code-unit comparison — locale-independent by construction. The staging script mirrors it.
 */
function hashHelperSourceTree(root: string): string {
  return hashTree(root, compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function hashTree(root: string, order: (left: string, right: string) => number): string {
  const hash = createHash("sha256");
  for (const file of listFiles(root, order)) {
    const rel = relative(root, file).split(sep).join("/");
    hash.update(`${rel}\0${sha256File(file)}\0`);
  }
  return hash.digest("hex");
}

function listFiles(
  root: string,
  order: (left: string, right: string) => number,
): readonly string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, order));
    else if (entry.isFile()) out.push(resolve(full));
  }
  return out.sort(order);
}

function readRecord(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return record(parsed);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
