import { createHash } from "node:crypto";
import { isAbsolute, resolve, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  secureWorkspaceReadTargetFor,
  type SecureWorkspaceTextReadArtifact,
  type SecureWorkspaceTextReadArtifactVerifier,
} from "./secureWorkspaceTextReadArtifact.js";
import type { SecureWorkspaceReadPlatform } from "./secureWorkspaceTextReadProcess.js";
import {
  declaredPortableRuntimeLane,
  evaluationAttestationDeclaredNegative,
  type PortableRuntimeLane,
} from "./portableRuntimeLane.js";

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
  /** The lane the packaged artifact declares; the caller derives it, never this module. */
  readonly lane: PortableRuntimeLane;
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
    input.lane,
  );
  if (helper === undefined || !verifiedManifestBinding(manifest, helper, target, input.lane)) {
    return undefined;
  }
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
      // STRUCTURAL ARTIFACT-SHAPE LITERAL, NOT A PLATFORM-SIGNATURE CLAIM. It means "this record
      // is the verified artifact identity". `isValidSecureWorkspaceTextReadArtifact` hard-requires
      // it to be truthy before the point-of-use verifier ever runs, and the node process compares
      // it, so flipping it to false "for honesty" on the evaluation lane would silently disable
      // every workspace read with no diagnostic. It stays true on every lane — the dev lane sets
      // it true on an ad-hoc-signed helper for exactly this reason (ADR-0140, ADR-0163 D9).
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
  lane: PortableRuntimeLane,
): Record<string, unknown> | undefined {
  const helpers = manifest?.nativeHelpers;
  if (!closedHelperSet(helpers, target)) return undefined;
  const helper = helpers
    .map((candidate) => record(candidate))
    .find((candidate) => candidate?.name === "keiko-secure-workspace-read");
  if (helper === undefined || !exactKeys(helper, HELPER_KEYS)) return undefined;
  return validHelperIdentity(helper, target, version, lane) ? helper : undefined;
}

function closedHelperSet(
  value: unknown,
  target: TargetContract,
): value is readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return false;
  const helpers = value.map((candidate) => record(candidate));
  if (helpers.includes(undefined)) return false;
  const names = helpers.map((candidate) => candidate?.name);
  if (new Set(names).size !== names.length || !names.includes("keiko-secure-workspace-read")) {
    return false;
  }
  const supervisor = helpers.find((candidate) => candidate?.name === "keiko-runtime-supervisor");
  return value.length === 1 || validSupervisorIdentity(supervisor, target);
}

function validSupervisorIdentity(
  helper: Record<string, unknown> | undefined,
  target: TargetContract,
): boolean {
  if (helper === undefined || !exactKeys(helper, HELPER_KEYS)) return false;
  const protocol = record(helper.protocol);
  const source = record(helper.source);
  return (
    supervisorIdentityMatches(helper, target) &&
    supervisorProtocolMatches(protocol) &&
    supervisorSourceMatches(source, target)
  );
}

function supervisorIdentityMatches(
  helper: Record<string, unknown>,
  target: TargetContract,
): boolean {
  const suffix = target.artifactTarget === "win32-x64" ? ".exe" : "";
  return (
    helper.kind === "runtime-process-supervisor" &&
    helper.platformTarget === target.manifestTarget &&
    helper.architecture === target.architecture &&
    helper.executablePath === `runtime/native/keiko-runtime-supervisor${suffix}`
  );
}

function supervisorProtocolMatches(protocol: Record<string, unknown> | undefined): boolean {
  return (
    protocol?.schemaVersion === 1 &&
    protocol.requestMagic === "KRP1" &&
    protocol.responseMagic === "KRS1"
  );
}

function supervisorSourceMatches(
  source: Record<string, unknown> | undefined,
  target: TargetContract,
): boolean {
  const platform = target.artifactTarget === "win32-x64" ? "windows" : "macos";
  return source?.path === `native/runtime-supervisor/${platform}`;
}

function validHelperIdentity(
  helper: Record<string, unknown>,
  target: TargetContract,
  version: string | undefined,
  lane: PortableRuntimeLane,
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
    validSigning(signing, target, lane),
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

/**
 * The closed 5-key helper signing shape and the target-bound signature kind and notarization
 * requirement are lane-independent. Only the platform PROOF differs: release-qualified requires it
 * true, evaluation requires it declared present-and-false. The helper block carries no
 * `verificationPolicy`, reason codes or `verificationChecks`, so the negative assertion covers the
 * two booleans it does carry plus its status.
 */
function validSigning(
  value: Record<string, unknown> | undefined,
  target: TargetContract,
  lane: PortableRuntimeLane,
): boolean {
  if (
    value === undefined ||
    !exactKeys(value, [
      "signatureKind",
      "verificationStatus",
      "signatureVerified",
      "notarizationRequired",
      "notarizationVerified",
    ]) ||
    value.signatureKind !== (target.notarized ? "developer-id-notarized" : "authenticode") ||
    value.notarizationRequired !== target.notarized
  ) {
    return false;
  }
  if (lane === "evaluation-unqualified") {
    return evaluationAttestationDeclaredNegative(value, target.manifestTarget, {
      requireReasonCodes: false,
      requirePolicy: false,
    });
  }
  return (
    value.verificationStatus === "verified-production" &&
    value.signatureVerified === true &&
    value.notarizationVerified === target.notarized
  );
}

function verifiedManifestBinding(
  manifest: Record<string, unknown> | undefined,
  helper: Record<string, unknown>,
  target: TargetContract,
  lane: PortableRuntimeLane,
): boolean {
  const artifact = record(manifest?.artifact);
  const runtime = record(manifest?.runtime);
  const security = record(manifest?.security);
  const reviewed = record(record(manifest?.releaseImpact)?.reviewedBinding);
  return [
    matchingManifestTarget(artifact, runtime, target),
    validSecurity(security, target, false, lane),
    validSecurity(reviewed, target, true, lane),
    reviewedHelperMatches(reviewed, manifest?.nativeHelpers, helper),
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
  manifestHelpers: unknown,
  helper: Record<string, unknown>,
): boolean {
  const reviewedHelpers = reviewed?.nativeHelpers;
  const helpers = Array.isArray(reviewedHelpers) ? reviewedHelpers : [];
  return [
    isDeepStrictEqual(reviewedHelpers, manifestHelpers),
    helpers.some((candidate) => isDeepStrictEqual(record(candidate), helper)),
    Array.isArray(reviewedHelpers) && reviewedHelpers.length > 0 && reviewedHelpers.length <= 2,
  ].every(Boolean);
}

function validSecurity(
  value: Record<string, unknown> | undefined,
  target: TargetContract,
  reviewed: boolean,
  lane: PortableRuntimeLane,
): boolean {
  if (value === undefined) return false;
  if (
    value.signatureKind !== (target.notarized ? "developer-id-notarized" : "authenticode") ||
    value.notarizationRequired !== target.notarized ||
    !validVerificationChecksShape(record(value.verificationChecks), target)
  ) {
    return false;
  }
  return lane === "evaluation-unqualified"
    ? validEvaluationSecurity(value, target, reviewed)
    : validProductionSecurity(value, target, reviewed);
}

function validProductionSecurity(
  value: Record<string, unknown>,
  target: TargetContract,
  reviewed: boolean,
): boolean {
  return [
    value.verificationPolicy === "production",
    value.verificationStatus === "verified-production",
    Array.isArray(value.verificationReasonCodes) && value.verificationReasonCodes.length === 0,
    value.signatureVerified === true,
    value.notarizationVerified === target.notarized,
    !reviewed || value.platformSignatureLocallyVerified === true,
    platformChecksAll(record(value.verificationChecks), target, true),
  ].every(Boolean);
}

/**
 * The evaluation mirror: every platform boolean must be present and FALSE, both evaluation reason
 * codes must be declared, and the reviewed copy must additionally state that no platform signature
 * was locally verified. Nothing is skipped — a block that merely omits the platform facts is not
 * this lane.
 */
function validEvaluationSecurity(
  value: Record<string, unknown>,
  target: TargetContract,
  reviewed: boolean,
): boolean {
  return [
    declaredPortableRuntimeLane(value) === "evaluation-unqualified",
    evaluationAttestationDeclaredNegative(value, target.manifestTarget, {
      requireReasonCodes: true,
      requirePolicy: true,
    }),
    !reviewed || value.platformSignatureLocallyVerified === false,
    platformChecksAll(record(value.verificationChecks), target, false),
  ].every(Boolean);
}

/** The exact key set is lane-independent; only the required VALUE flips. */
function validVerificationChecksShape(
  checks: Record<string, unknown> | undefined,
  target: TargetContract,
): boolean {
  return checks !== undefined && exactKeys(checks, verificationCheckKeys(target));
}

function platformChecksAll(
  checks: Record<string, unknown> | undefined,
  target: TargetContract,
  expected: boolean,
): boolean {
  return (
    checks !== undefined && verificationCheckKeys(target).every((key) => checks[key] === expected)
  );
}

function verificationCheckKeys(target: TargetContract): readonly string[] {
  return target.notarized
    ? ["developerIdVerified", "notarizationVerified", "stapleVerified", "assessmentVerified"]
    : ["publisherChainVerified", "timestampVerified"];
}

function absoluteResourceRoot(root: string, target: TargetContract): string | undefined {
  const path = target.artifactTarget === "win32-x64" ? win32 : { isAbsolute, resolve };
  return path.isAbsolute(root) && path.resolve(root) === root ? root : undefined;
}

function containedExecutable(root: string, target: TargetContract): string | undefined {
  const path = target.artifactTarget === "win32-x64" ? win32 : { resolve };
  const executable = path.resolve(root, ...target.executablePath.split("/"));
  const separator = target.artifactTarget === "win32-x64" ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
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
