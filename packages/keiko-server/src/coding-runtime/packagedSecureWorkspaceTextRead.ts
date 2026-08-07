import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";

import {
  createSecureWorkspaceTextReadPort,
  type SecureWorkspaceTextReadPort,
} from "./secureWorkspaceTextRead.js";
import { createNodeSecureWorkspaceReadProcessFactory } from "./secureWorkspaceTextReadNodeProcess.js";
import {
  createPortableSecureWorkspaceReadVerifier,
  resolvePortableSecureWorkspaceReadBinding,
  type PortableSecureWorkspaceReadPlatformInspection,
  type PortableSecureWorkspaceReadVerifierDeps,
} from "./secureWorkspaceTextReadPortable.js";
import {
  createNodePortableSecureWorkspaceReadInspection,
  provePortableImmutableResourceTree,
} from "./secureWorkspaceTextReadPlatformNode.js";
import type { QualifiedPortableOpenCodeRuntime } from "./productionPortableCodingRuntime.js";

export interface PackagedSecureWorkspaceTextReadInput {
  readonly runtime: QualifiedPortableOpenCodeRuntime;
  readonly resolveWorkspaceRoot: () => string | undefined | Promise<string | undefined>;
  readonly safeCwd: string;
}

export function createPackagedSecureWorkspaceTextReadPort(
  input: PackagedSecureWorkspaceTextReadInput,
): SecureWorkspaceTextReadPort | undefined {
  const platform = platformForTarget(input.runtime.target);
  const binding = resolvePortableSecureWorkspaceReadBinding({
    manifest: input.runtime.manifest,
    platform,
    resourceRoot: input.runtime.installRoot,
    lane: input.runtime.platformAssurance,
  });
  if (binding === undefined) return undefined;
  return createSecureWorkspaceTextReadPort({
    resolveWorkspaceRoot: input.resolveWorkspaceRoot,
    artifact: binding.artifact,
    artifactVerifier: createPortableSecureWorkspaceReadVerifier(
      binding,
      verifierDeps(input.runtime),
    ),
    processFactory: createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: input.safeCwd,
    }),
    platform,
  });
}

/**
 * The single seam where the two OS-vouching calls enter the point-of-use verifier, and therefore
 * the one place the evaluation lane waives them (ADR-0163 D9). Both shell out to a platform
 * signature check built from a Developer ID / Authenticode publisher identity that an unsigned
 * build does not have. The SUBSTITUTE PROOF is recomputation, not omission: `verifyAtPointOfUse`
 * still runs the deep artifact binding, the symlink/reparse-point path walk, the same-identity
 * open with before/after metadata and link-count equality, and a full sha256 re-hash of the bytes
 * actually read against the bound digest. `provePortableImmutableResourceTree` already returns
 * `true` structurally for win32-x64 for exactly this reason.
 */
function verifierDeps(
  runtime: QualifiedPortableOpenCodeRuntime,
): PortableSecureWorkspaceReadVerifierDeps {
  const inspection = createNodePortableSecureWorkspaceReadInspection({
    resourceRoot: runtime.installRoot,
  });
  if (runtime.platformAssurance === "release-qualified") {
    return {
      proveImmutableResourceTree: () =>
        provePortableImmutableResourceTree(runtime.installRoot, artifactTargetFor(runtime.target)),
      platform: inspection,
    };
  }
  return {
    proveImmutableResourceTree: () => Promise.resolve(true),
    platform: evaluationInspection(inspection),
  };
}

function evaluationInspection(
  inspection: PortableSecureWorkspaceReadPlatformInspection,
): PortableSecureWorkspaceReadPlatformInspection {
  return Object.freeze({
    inspectPath: (resourceRoot: string, executable: string) =>
      inspection.inspectPath(resourceRoot, executable),
    openReadSameIdentity: (executable: string, maximumBytes: number) =>
      inspection.openReadSameIdentity(executable, maximumBytes),
    verifySignature: () => Promise.resolve(true),
  });
}

function artifactTargetFor(
  target: UpdatePortableTarget,
): "win32-x64" | "darwin-arm64" | "darwin-x64" {
  if (target === "windows-x64") return "win32-x64";
  return target === "macos-arm64" ? "darwin-arm64" : "darwin-x64";
}

function platformForTarget(target: UpdatePortableTarget): {
  readonly os: "darwin" | "win32";
  readonly arch: "arm64" | "x64";
} {
  return target === "windows-x64"
    ? { os: "win32", arch: "x64" }
    : { os: "darwin", arch: target === "macos-arm64" ? "arm64" : "x64" };
}
