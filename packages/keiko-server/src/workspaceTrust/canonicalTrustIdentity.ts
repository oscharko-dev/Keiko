// Issue #2521/#2524/#2615, ADR-0147 D1/D3, ADR-0155 — pure derivation of a WorkspaceTrustBinding
// from an already-canonical root, the observed package-script trust basis, the persisted workspace
// manifest, and the LIVE filesystem-identity digest of the root under evaluation. No IO in this
// module: the caller resolves realpath, reads the manifest, and re-inspects the live filesystem
// identity, so if a directory is replaced under the same path the caller supplies a fresh digest
// that no longer matches the persisted record and `projectCommandTaskTrustState` fails closed.
// A binding is expressible only when the root is a member of the current manifest; there is no
// implicit no-manifest fallback, because a manifest is always present in the production path and
// keeping a second digest framing would silently mask a caller wiring mistake.

import type {
  WorkspaceFact,
  WorkspaceManifest,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
  WorkspaceTrustBasisDigest,
  WorkspaceTrustBinding,
} from "@oscharko-dev/keiko-contracts";
import { deriveWorkspaceRootRef as deriveCanonicalWorkspaceRootRef } from "../workspace-root-identity.js";

// The opaque root reference is also the persistence key; exposed so the store lookup and the derived
// binding always agree on the identity of the root under evaluation.
export function deriveWorkspaceRootRef(canonicalRoot: string): WorkspaceRootRef {
  return deriveCanonicalWorkspaceRootRef(canonicalRoot);
}

export function deriveWorkspaceTrustBinding(
  canonicalRoot: string,
  trustBasisDigest: WorkspaceFact<WorkspaceTrustBasisDigest>,
  manifest: WorkspaceManifest,
  liveRootIdentityDigest: WorkspaceRootIdentityDigest,
): WorkspaceTrustBinding {
  const manifestRoot = manifest.roots.find((root) => root.canonicalRoot === canonicalRoot);
  if (manifestRoot === undefined) throw new Error("WORKSPACE_ROOT_NOT_MEMBER");
  return {
    manifestRef: manifest.manifestRef,
    manifestRevision: manifest.revision,
    manifestDigest: manifest.manifestDigest,
    rootRef: manifestRoot.rootRef,
    rootIdentityDigest: liveRootIdentityDigest,
    trustBasisDigest,
  };
}
