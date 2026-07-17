import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { DevLaneSecureReadBinding } from "./devLanePortableCodingRuntime.js";
import {
  createSecureWorkspaceTextReadPort,
  type SecureWorkspaceTextReadPort,
} from "./secureWorkspaceTextRead.js";
import type {
  SecureWorkspaceTextReadArtifact,
  SecureWorkspaceTextReadArtifactVerifier,
} from "./secureWorkspaceTextReadArtifact.js";
import { createNodeSecureWorkspaceReadProcessFactory } from "./secureWorkspaceTextReadNodeProcess.js";

export interface DevLaneSecureWorkspaceTextReadInput {
  readonly binding: DevLaneSecureReadBinding;
  readonly resolveWorkspaceRoot: () => string | undefined | Promise<string | undefined>;
  /** Fixed server-owned working directory for the one-shot helper, never the workspace root. */
  readonly safeCwd: string;
  /** Test seam mirroring `SecureWorkspaceTextReadDeps.platform`; production omits it. */
  readonly platform?: { readonly os: string; readonly arch: string } | undefined;
}

/**
 * Dev-lane construction of the secure workspace read port (#2475, ADR-0140). The point-of-use
 * verifier recomputes the helper's digest, size, and file identity against the staged dev-lane
 * binding on every admitted read. Posture: the packaged platform inspection — signature chain
 * and immutable-resource-tree proof — is deliberately absent on this lane; digest-pinned
 * integrity of a locally built helper is the honest maximum a repository checkout can prove.
 */
export function createDevLaneSecureWorkspaceTextReadPort(
  input: DevLaneSecureWorkspaceTextReadInput,
): SecureWorkspaceTextReadPort {
  return createSecureWorkspaceTextReadPort({
    resolveWorkspaceRoot: input.resolveWorkspaceRoot,
    artifact: input.binding.artifact,
    artifactVerifier: devLaneArtifactVerifier(input.binding),
    processFactory: createNodeSecureWorkspaceReadProcessFactory({
      binding: {
        artifact: input.binding.artifact,
        executable: input.binding.helperPath,
        helperSizeBytes: input.binding.helperSizeBytes,
        resourceRoot: dirname(input.binding.helperPath),
      },
      safeCwd: input.safeCwd,
    }),
    ...(input.platform ? { platform: input.platform } : {}),
  });
}

function devLaneArtifactVerifier(
  binding: DevLaneSecureReadBinding,
): SecureWorkspaceTextReadArtifactVerifier {
  return {
    verify: (artifact: SecureWorkspaceTextReadArtifact): boolean =>
      artifact.sha256 === binding.artifact.sha256 &&
      artifact.installRelativePath === binding.artifact.installRelativePath &&
      helperIntegrityHolds(binding),
  };
}

/** Recomputed at every admitted read so a swapped or drifted helper fails closed mid-session. */
function helperIntegrityHolds(binding: DevLaneSecureReadBinding): boolean {
  try {
    const status = lstatSync(binding.helperPath, { bigint: true });
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1n) return false;
    if (statSync(binding.helperPath).size !== binding.helperSizeBytes) return false;
    const digest = createHash("sha256").update(readFileSync(binding.helperPath)).digest("hex");
    return digest === binding.artifact.sha256;
  } catch {
    return false;
  }
}
