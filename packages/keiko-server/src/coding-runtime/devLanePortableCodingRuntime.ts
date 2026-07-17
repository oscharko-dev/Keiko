import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

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

const APPROVALS_CATALOG_FILE = "portable-runtime-approvals.json";
const SIDECAR_NAME = "opencode-compatible";
const HELPER_SOURCE_DIR = "native/secure-workspace-read";
const ENABLE_TOKENS = new Set(["1", "true", "on", "yes", "enabled"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

export type DevLaneOpenCodeTarget = "macos-arm64" | "macos-x64";

export type DevLaneOpenCodeRefusalReason =
  | "platform-unsupported"
  | "packaged-install-present"
  | "not-a-dev-checkout"
  | "payload-missing"
  | "payload-unapproved"
  | "payload-tampered"
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
 * Explicit, opt-in discovery of a locally staged, review-approved OpenCode payload on a macOS
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
  const target = devLaneTarget(input.platform ?? process.platform, input.arch ?? process.arch);
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
  return {
    outcome: "activated",
    runtime: {
      evidenceClass: "functional-not-platform-qualified",
      lane: "dev-checkout",
      installRoot: join(stagedTargetRoot, SIDECAR_NAME),
      target,
      sidecar: payload.sidecar,
      qualification: devLaneQualification(target, payload.sidecar, secureRead.binding),
      secureRead: secureRead.binding,
    },
  };
}

function refused(reason: DevLaneOpenCodeRefusalReason): DevLaneOpenCodeDiscovery {
  return { outcome: "refused", reason };
}

function devLaneTarget(platform: NodeJS.Platform, arch: string): DevLaneOpenCodeTarget | undefined {
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
}

/** The checked-in redistribution catalog is the dev lane's review-approved trust anchor. */
function approvedSidecar(
  root: string,
  target: DevLaneOpenCodeTarget,
): ApprovedDevLaneSidecar | undefined {
  const runtime = approvedCatalogRuntime(join(root, APPROVALS_CATALOG_FILE));
  if (runtime === undefined) return undefined;
  const adapter = record(runtime.adapterCompatibility);
  const candidate = {
    upstreamVersion: record(runtime.upstream)?.version,
    adapterName: adapter?.adapterName,
    adapterVersion: adapter?.adapterVersion,
    executableTreeSha256: record(record(runtime.archives)?.[target])?.executableTreeSha256,
    licenseSha256: record(runtime.license)?.sha256,
    protocolSchemaSha256: record(runtime.protocolSchema)?.sha256,
  };
  return approvedSidecarShape(candidate) ? candidate : undefined;
}

function approvedSidecarShape(
  candidate: Record<keyof ApprovedDevLaneSidecar, unknown>,
): candidate is ApprovedDevLaneSidecar {
  return (
    typeof candidate.upstreamVersion === "string" &&
    typeof candidate.adapterName === "string" &&
    typeof candidate.adapterVersion === "string" &&
    isSha256(candidate.executableTreeSha256) &&
    isSha256(candidate.licenseSha256) &&
    isSha256(candidate.protocolSchemaSha256)
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
  const executablePath = "payload/bin/opencode";
  const licensePath = "payload/evidence/LICENSE";
  const sbomPath = "payload/evidence/sbom.cdx.json";
  const files = [executablePath, licensePath, sbomPath].map((file) => join(installRoot, file));
  if (!files.every(isRegularFile)) return { ok: false, refusal: "payload-missing" };
  const executableSha256 = sha256File(join(installRoot, executablePath));
  const executableTreeSha256 = digestText(`bin/opencode\0${executableSha256}\0`);
  if (
    executableTreeSha256 !== approved.executableTreeSha256 ||
    sha256File(join(installRoot, licensePath)) !== approved.licenseSha256
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
      sbomEvidenceSha256: sha256File(join(installRoot, sbomPath)),
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
  const helperPath = join(stagedTargetRoot, DEV_LANE_HELPER_RELATIVE_PATH);
  const manifest = devLaneManifestHelper(join(stagedTargetRoot, DEV_LANE_MANIFEST_FILE), target);
  if (manifest === undefined || !isRegularFile(helperPath)) {
    return { ok: false, refusal: "secure-read-helper-missing" };
  }
  const helperStat = statSync(helperPath);
  if (
    sha256File(helperPath) !== manifest.sha256 ||
    helperStat.size !== manifest.sizeBytes ||
    hashDirectoryTree(join(checkoutRoot, HELPER_SOURCE_DIR)) !== manifest.sourceTreeSha256
  ) {
    return { ok: false, refusal: "secure-read-helper-stale" };
  }
  return {
    ok: true,
    binding: {
      helperPath,
      helperSizeBytes: manifest.sizeBytes,
      artifact: {
        target: target === "macos-arm64" ? "darwin-arm64" : "darwin-x64",
        installRelativePath: "runtime/native/keiko-secure-workspace-read",
        sha256: manifest.sha256,
        protocol: "KSR1/KSS1",
        sourceCommit: manifest.sourceCommit,
        sourceTreeSha256: manifest.sourceTreeSha256,
        // macOS refuses to execute unsigned arm64 binaries; the dev-lane helper carries the
        // linker's ad-hoc signature. Integrity is proven by digest, never by a signature chain.
        signed: true,
      },
    },
  };
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
  const helper = record(manifest.helper);
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
): LongLivedRuntimeQualification {
  const binding = JSON.stringify({
    lane: "dev-checkout",
    target,
    executableTreeSha256: sidecar.executableTreeSha256,
    helperSha256: secureRead.artifact.sha256,
  });
  return {
    platform: "darwin",
    arch: target === "macos-arm64" ? "arm64" : "x64",
    backend: "macos-app-sandbox",
    releaseReceipt: `sha256:${digestText(binding)}`,
  };
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

function hashDirectoryTree(root: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(root)) {
    const rel = relative(root, file).split(sep).join("/");
    hash.update(`${rel}\0${sha256File(file)}\0`);
  }
  return hash.digest("hex");
}

function listFiles(root: string): readonly string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(resolve(full));
  }
  return out.sort((left, right) => left.localeCompare(right));
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
