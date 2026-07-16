import type { SecureWorkspaceReadPlatform } from "./secureWorkspaceTextReadProcess.js";

export type SecureWorkspaceReadTarget = "win32-x64" | "darwin-arm64" | "darwin-x64";

export interface SecureWorkspaceTextReadArtifact {
  readonly target: string;
  /** Fixed, verified install-relative identity; never caller input. */
  readonly installRelativePath: string;
  readonly sha256: string;
  readonly protocol: string;
  readonly sourceCommit: string;
  readonly sourceTreeSha256: string;
  readonly signed: boolean;
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
    artifact.target === target &&
    artifact.installRelativePath === expectedPath &&
    artifact.protocol === "KSR1/KSS1" &&
    artifact.signed &&
    /^[a-f0-9]{64}$/.test(artifact.sha256) &&
    /^[a-f0-9]{40}$/.test(artifact.sourceCommit) &&
    /^[a-f0-9]{64}$/.test(artifact.sourceTreeSha256)
  );
}
