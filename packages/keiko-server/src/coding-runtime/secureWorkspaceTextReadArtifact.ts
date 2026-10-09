import type { SecureWorkspaceReadPlatform } from "./secureWorkspaceTextReadProcess.js";
import {
  isSecureWorkspaceReadByteCap,
  SECURE_WORKSPACE_TEXT_READ_MAX_BYTES,
} from "./secureWorkspaceTextReadProtocol.js";

export type SecureWorkspaceReadTarget = "linux-x64" | "win32-x64" | "darwin-arm64" | "darwin-x64";

export interface SecureWorkspaceTextReadArtifact {
  readonly target: string;
  /** Fixed, verified install-relative identity; never caller input. */
  readonly installRelativePath: string;
  readonly sha256: string;
  readonly protocol: string;
  readonly sourceCommit: string;
  readonly sourceTreeSha256: string;
  readonly signed: boolean;
  /** Server-pinned helper capability; absent for the current portable/dev helper. */
  readonly byteCap?: number;
  /** Server-pinned, digest-bound optional capability; absent on every current shipped helper. */
  readonly snapshotProtocol?: "KSR2/KSS2";
  /** Separately digest-bound private bytes/range/stat/list capability. Never implied by text IO. */
  readonly nativeProtocol?: "KSR3/KSS3";
}

export interface SecureWorkspaceTextReadArtifactVerifier {
  verify(artifact: SecureWorkspaceTextReadArtifact): Promise<boolean> | boolean;
}

/**
 * Fixed point-of-use verification seam. This validates immutable metadata before
 * delegating the platform-specific signature/identity/digest proof to the installer.
 */
export async function resolveSecureWorkspaceReadArtifact(
  artifact: SecureWorkspaceTextReadArtifact,
  platform: SecureWorkspaceReadPlatform,
  verifier: SecureWorkspaceTextReadArtifactVerifier,
): Promise<SecureWorkspaceTextReadArtifact | undefined> {
  const target = secureWorkspaceReadTargetFor(platform);
  if (target === undefined || !isValidSecureWorkspaceTextReadArtifact(artifact, target))
    return undefined;
  return (await verifier.verify(artifact)) ? artifact : undefined;
}

export function secureWorkspaceReadTargetFor(
  platform: SecureWorkspaceReadPlatform,
): SecureWorkspaceReadTarget | undefined {
  if (platform.os === "linux" && platform.arch === "x64") return "linux-x64";
  if (platform.os === "win32" && platform.arch === "x64") return "win32-x64";
  if (platform.os === "darwin" && platform.arch === "arm64") return "darwin-arm64";
  if (platform.os === "darwin" && platform.arch === "x64") return "darwin-x64";
  return undefined;
}

/** Validates static manifest metadata before the point-of-use verifier is invoked. */
export function isValidSecureWorkspaceTextReadArtifact(
  artifact: SecureWorkspaceTextReadArtifact,
  target: SecureWorkspaceReadTarget,
): boolean {
  const expectedPath =
    target === "win32-x64"
      ? "runtime/native/keiko-secure-workspace-read.exe"
      : "runtime/native/keiko-secure-workspace-read";
  return (
    validInstallShape(artifact, target, expectedPath) &&
    validSnapshotCapability(artifact) &&
    validNativeCapability(artifact, target) &&
    artifact.signed &&
    isSecureWorkspaceReadByteCap(secureWorkspaceReadArtifactByteCap(artifact)) &&
    /^[a-f0-9]{64}$/.test(artifact.sha256) &&
    /^[a-f0-9]{40}$/.test(artifact.sourceCommit) &&
    /^[a-f0-9]{64}$/.test(artifact.sourceTreeSha256)
  );
}

export function secureWorkspaceReadArtifactByteCap(
  artifact: SecureWorkspaceTextReadArtifact,
): number {
  return artifact.byteCap ?? SECURE_WORKSPACE_TEXT_READ_MAX_BYTES;
}

function validSnapshotCapability(artifact: SecureWorkspaceTextReadArtifact): boolean {
  return snapshotProtocolApproved(
    artifact.snapshotProtocol,
    secureWorkspaceReadArtifactByteCap(artifact),
  );
}

function snapshotProtocolApproved(protocol: unknown, byteCap: number): boolean {
  return (
    protocol === undefined ||
    (protocol === "KSR2/KSS2" && byteCap === SECURE_WORKSPACE_TEXT_READ_MAX_BYTES)
  );
}

function validNativeCapability(
  artifact: SecureWorkspaceTextReadArtifact,
  target: SecureWorkspaceReadTarget,
): boolean {
  return nativeProtocolApproved(artifact.nativeProtocol, target);
}

function validInstallShape(
  artifact: SecureWorkspaceTextReadArtifact,
  target: string,
  expectedPath: string,
): boolean {
  return (
    artifact.target === target &&
    artifact.installRelativePath === expectedPath &&
    artifact.protocol === "KSR1/KSS1"
  );
}
function nativeProtocolApproved(protocol: unknown, target: SecureWorkspaceReadTarget): boolean {
  return protocol === undefined || (protocol === "KSR3/KSS3" && target !== "win32-x64");
}
