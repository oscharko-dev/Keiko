import { createHash } from "node:crypto";
import { isAbsolute, resolve, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  secureWorkspaceReadTargetFor,
  type SecureWorkspaceTextReadArtifact,
  type SecureWorkspaceTextReadArtifactVerifier,
} from "./secureWorkspaceTextReadArtifact.js";
import type { SecureWorkspaceReadPlatform } from "./secureWorkspaceTextReadProcess.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const HELPER_KEYS =
  "name kind platformTarget architecture executablePath protocol source unsignedSha256 shippedSha256 sizeBytes sbomBomRef signing".split(
    " ",
  );

export interface PortableSecureWorkspaceReadBinding {
  readonly artifact: SecureWorkspaceTextReadArtifact;
  readonly executable: string;
  readonly helperSizeBytes: number;
  readonly resourceRoot: string;
}

export interface PortableSecureWorkspaceReadBindingInput {
  readonly manifest: unknown;
  readonly platform: SecureWorkspaceReadPlatform;
  readonly resourceRoot: string;
}

interface TargetContract {
  readonly artifactTarget: "win32-x64" | "darwin-arm64" | "darwin-x64";
  readonly manifestTarget: "windows-x64" | "macos-arm64" | "macos-x64";
  readonly architecture: "x64" | "arm64";
  readonly executablePath: string;
  readonly notarized: boolean;
}

export interface PortableSecureWorkspaceReadMetadata {
  readonly identity: string;
  readonly size: number;
  readonly modifiedNs: string;
  readonly changedNs: string;
  readonly regularFile: boolean;
  readonly linkCount: number;
}

export interface PortableSecureWorkspaceReadPathEntry {
  readonly symbolicLink: boolean;
  readonly reparsePoint: boolean;
  readonly safeType: boolean;
}

export interface PortableSecureWorkspaceReadPlatformInspection {
  inspectPath(
    resourceRoot: string,
    executable: string,
  ): Promise<readonly PortableSecureWorkspaceReadPathEntry[]>;
  openReadSameIdentity(
    executable: string,
    maximumBytes: number,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly before: PortableSecureWorkspaceReadMetadata;
    readonly after: PortableSecureWorkspaceReadMetadata;
  }>;
  verifySignature(executable: string, target: TargetContract["artifactTarget"]): Promise<boolean>;
}

export interface PortableSecureWorkspaceReadVerifierDeps {
  readonly proveImmutableResourceTree: (resourceRoot: string) => Promise<boolean>;
  readonly platform: PortableSecureWorkspaceReadPlatformInspection;
}

export function resolvePortableSecureWorkspaceReadBinding(
  input: PortableSecureWorkspaceReadBindingInput,
): PortableSecureWorkspaceReadBinding | undefined {
  try {
    return parsePortableBinding(input);
  } catch {
    return undefined;
  }
}

function parsePortableBinding(
  input: PortableSecureWorkspaceReadBindingInput,
): PortableSecureWorkspaceReadBinding | undefined {
  const target = contractFor(input.platform);
  if (target === undefined) return undefined;
  const root = absoluteResourceRoot(input.resourceRoot, target);
  if (root === undefined) return undefined;
  const manifest = record(input.manifest);
  const version = record(manifest?.product)?.packageVersion;
  const helper = manifestHelper(
    manifest,
    target,
    typeof version === "string" ? version : undefined,
  );
  if (helper === undefined || !verifiedManifestBinding(manifest, helper, target)) return undefined;
  const executable = containedExecutable(root, target);
  if (executable === undefined) return undefined;
  const source = record(helper.source) ?? {};
  return Object.freeze({
    artifact: Object.freeze({
      target: target.artifactTarget,
      installRelativePath: target.executablePath,
      sha256: String(helper.shippedSha256),
      protocol: "KSR1/KSS1",
      sourceCommit: String(source.commitSha),
      sourceTreeSha256: String(source.treeSha256),
      signed: true,
    }),
    executable,
    helperSizeBytes: Number(helper.sizeBytes),
    resourceRoot: root,
  });
}

function contractFor(platform: SecureWorkspaceReadPlatform): TargetContract | undefined {
  const artifactTarget = secureWorkspaceReadTargetFor(platform);
  if (artifactTarget === "win32-x64")
    return {
      artifactTarget,
      manifestTarget: "windows-x64",
      architecture: "x64",
      executablePath: "runtime/native/keiko-secure-workspace-read.exe",
      notarized: false,
    };
  if (artifactTarget === "darwin-arm64" || artifactTarget === "darwin-x64")
    return {
      artifactTarget,
      manifestTarget: artifactTarget === "darwin-arm64" ? "macos-arm64" : "macos-x64",
      architecture: artifactTarget === "darwin-arm64" ? "arm64" : "x64",
      executablePath: "runtime/native/keiko-secure-workspace-read",
      notarized: true,
    };
  return undefined;
}

function manifestHelper(
  manifest: Record<string, unknown> | undefined,
  target: TargetContract,
  version: string | undefined,
): Record<string, unknown> | undefined {
  const helpers = manifest?.nativeHelpers;
  if (!Array.isArray(helpers) || helpers.length !== 1) return undefined;
  const helper = record(helpers[0]);
  if (helper === undefined || !exactKeys(helper, HELPER_KEYS)) return undefined;
  return validHelperIdentity(helper, target, version) ? helper : undefined;
}

function validHelperIdentity(
  helper: Record<string, unknown>,
  target: TargetContract,
  version: string | undefined,
): boolean {
  const protocol = record(helper.protocol);
  const source = record(helper.source);
  const signing = record(helper.signing);
  return [
    helper.name === "keiko-secure-workspace-read" && helper.kind === "secure-workspace-text-read",
    helper.platformTarget === target.manifestTarget && helper.architecture === target.architecture,
    helper.executablePath === target.executablePath,
    validProtocol(protocol),
    validSource(source),
    validSigning(signing, target),
    typeof helper.unsignedSha256 === "string" && DIGEST.test(helper.unsignedSha256),
    typeof helper.shippedSha256 === "string" && DIGEST.test(helper.shippedSha256),
    Number.isSafeInteger(helper.sizeBytes) &&
      Number(helper.sizeBytes) > 0 &&
      Number(helper.sizeBytes) <= 16 * 1024 * 1024,
    version !== undefined &&
      helper.sbomBomRef ===
        `pkg:generic/keiko-secure-workspace-read@${version}?platform=${target.manifestTarget}`,
  ].every(Boolean);
}

function validProtocol(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    exactKeys(value, ["schemaVersion", "requestMagic", "responseMagic"]) &&
    value.schemaVersion === 1 &&
    value.requestMagic === "KSR1" &&
    value.responseMagic === "KSS1"
  );
}

function validSource(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    exactKeys(value, ["commitSha", "path", "treeSha256"]) &&
    typeof value.commitSha === "string" &&
    COMMIT.test(value.commitSha) &&
    value.path === "native/secure-workspace-read" &&
    typeof value.treeSha256 === "string" &&
    DIGEST.test(value.treeSha256)
  );
}

function validSigning(value: Record<string, unknown> | undefined, target: TargetContract): boolean {
  return (
    value !== undefined &&
    exactKeys(value, [
      "signatureKind",
      "verificationStatus",
      "signatureVerified",
      "notarizationRequired",
      "notarizationVerified",
    ]) &&
    value.signatureKind === (target.notarized ? "developer-id-notarized" : "authenticode") &&
    value.verificationStatus === "verified-production" &&
    value.signatureVerified === true &&
    value.notarizationRequired === target.notarized &&
    value.notarizationVerified === target.notarized
  );
}

function verifiedManifestBinding(
  manifest: Record<string, unknown> | undefined,
  helper: Record<string, unknown>,
  target: TargetContract,
): boolean {
  const artifact = record(manifest?.artifact);
  const runtime = record(manifest?.runtime);
  const security = record(manifest?.security);
  const reviewed = record(record(manifest?.releaseImpact)?.reviewedBinding);
  return [
    matchingManifestTarget(artifact, runtime, target),
    validSecurity(security, target, false),
    validSecurity(reviewed, target, true),
    reviewedHelperMatches(reviewed, helper),
  ].every(Boolean);
}

function matchingManifestTarget(
  artifact: Record<string, unknown> | undefined,
  runtime: Record<string, unknown> | undefined,
  target: TargetContract,
): boolean {
  return [
    artifact?.platformTarget === target.manifestTarget,
    runtime?.nodePlatform === (target.notarized ? "darwin" : "win32"),
    runtime?.nodeArchitecture === target.architecture,
  ].every(Boolean);
}

function reviewedHelperMatches(
  reviewed: Record<string, unknown> | undefined,
  helper: Record<string, unknown>,
): boolean {
  const reviewedHelpers = reviewed?.nativeHelpers;
  return [
    isDeepStrictEqual(
      record(Array.isArray(reviewed?.nativeHelpers) ? reviewed.nativeHelpers[0] : undefined),
      helper,
    ),
    Array.isArray(reviewedHelpers) && reviewedHelpers.length === 1,
  ].every(Boolean);
}

function validSecurity(
  value: Record<string, unknown> | undefined,
  target: TargetContract,
  reviewed: boolean,
): boolean {
  if (value === undefined) return false;
  const checks = record(value.verificationChecks);
  return [
    value.verificationPolicy === "production",
    value.verificationStatus === "verified-production",
    Array.isArray(value.verificationReasonCodes) && value.verificationReasonCodes.length === 0,
    value.signatureKind === (target.notarized ? "developer-id-notarized" : "authenticode") &&
      value.signatureVerified === true,
    value.notarizationRequired === target.notarized,
    value.notarizationVerified === target.notarized,
    !reviewed || value.platformSignatureLocallyVerified === true,
    validVerificationChecks(checks, target),
  ].every(Boolean);
}

function validVerificationChecks(
  checks: Record<string, unknown> | undefined,
  target: TargetContract,
): boolean {
  const keys = target.notarized
    ? ["developerIdVerified", "notarizationVerified", "stapleVerified", "assessmentVerified"]
    : ["publisherChainVerified", "timestampVerified"];
  return (
    checks !== undefined && exactKeys(checks, keys) && keys.every((key) => checks[key] === true)
  );
}

function absoluteResourceRoot(root: string, target: TargetContract): string | undefined {
  const path = target.artifactTarget === "win32-x64" ? win32 : { isAbsolute, resolve };
  return path.isAbsolute(root) && path.resolve(root) === root ? root : undefined;
}

function containedExecutable(root: string, target: TargetContract): string | undefined {
  const path = target.artifactTarget === "win32-x64" ? win32 : { resolve };
  const executable = path.resolve(root, ...target.executablePath.split("/"));
  const prefix = root.endsWith(target.artifactTarget === "win32-x64" ? "\\" : "/")
    ? root
    : `${root}${target.artifactTarget === "win32-x64" ? "\\" : "/"}`;
  const candidate = target.artifactTarget === "win32-x64" ? executable.toLowerCase() : executable;
  const boundary = target.artifactTarget === "win32-x64" ? prefix.toLowerCase() : prefix;
  return candidate.startsWith(boundary) ? executable : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createPortableSecureWorkspaceReadVerifier(
  binding: PortableSecureWorkspaceReadBinding,
  deps: PortableSecureWorkspaceReadVerifierDeps,
): SecureWorkspaceTextReadArtifactVerifier {
  return Object.freeze({
    verify: (artifact: SecureWorkspaceTextReadArtifact) =>
      verifyAtPointOfUse(binding, artifact, deps),
  });
}

async function verifyAtPointOfUse(
  binding: PortableSecureWorkspaceReadBinding,
  artifact: SecureWorkspaceTextReadArtifact,
  deps: PortableSecureWorkspaceReadVerifierDeps,
): Promise<boolean> {
  try {
    if (!isDeepStrictEqual(binding.artifact, artifact)) return false;
    if (!(await deps.proveImmutableResourceTree(binding.resourceRoot))) return false;
    const path = await deps.platform.inspectPath(binding.resourceRoot, binding.executable);
    const expectedEntries = artifact.installRelativePath.split("/").length + 1;
    if (
      path.length !== expectedEntries ||
      path.some((entry) => !entry.safeType || entry.symbolicLink || entry.reparsePoint)
    )
      return false;
    const opened = await deps.platform.openReadSameIdentity(
      binding.executable,
      binding.helperSizeBytes + 1,
    );
    try {
      if (!validOpenedHelper(opened, binding)) return false;
      return await deps.platform.verifySignature(
        binding.executable,
        binding.artifact.target as TargetContract["artifactTarget"],
      );
    } finally {
      opened.bytes.fill(0);
    }
  } catch {
    return false;
  }
}

function validOpenedHelper(
  opened: Awaited<
    ReturnType<PortableSecureWorkspaceReadPlatformInspection["openReadSameIdentity"]>
  >,
  binding: PortableSecureWorkspaceReadBinding,
): boolean {
  const { before, after, bytes } = opened;
  return (
    bytes.byteLength === binding.helperSizeBytes &&
    before.regularFile &&
    after.regularFile &&
    before.linkCount === 1 &&
    after.linkCount === 1 &&
    before.size === bytes.byteLength &&
    sameMetadata(before, after) &&
    createHash("sha256").update(bytes).digest("hex") === binding.artifact.sha256
  );
}

function sameMetadata(
  before: PortableSecureWorkspaceReadMetadata,
  after: PortableSecureWorkspaceReadMetadata,
): boolean {
  return (
    before.identity === after.identity &&
    before.size === after.size &&
    before.modifiedNs === after.modifiedNs &&
    before.changedNs === after.changedNs &&
    before.regularFile === after.regularFile &&
    before.linkCount === after.linkCount
  );
}
