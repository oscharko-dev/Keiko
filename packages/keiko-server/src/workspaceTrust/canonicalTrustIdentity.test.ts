import { describe, expect, it } from "vitest";
import { isWorkspaceRootRef } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import { validateWorkspaceTrustBinding } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import { WORKSPACE_MANIFEST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-manifest";
import type {
  WorkspaceFact,
  WorkspaceManifest,
  WorkspaceManifestDigest,
  WorkspaceManifestRef,
  WorkspaceRootDescriptor,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
  WorkspaceTrustBasisDigest,
} from "@oscharko-dev/keiko-contracts";
import { deriveWorkspaceRootRef, deriveWorkspaceTrustBinding } from "./canonicalTrustIdentity.js";

const KNOWN_BASIS: WorkspaceFact<WorkspaceTrustBasisDigest> = {
  outcome: "known",
  value: "a".repeat(64) as WorkspaceTrustBasisDigest,
};
const IDENTITY_A = "b".repeat(64) as WorkspaceRootIdentityDigest;
const IDENTITY_B = "c".repeat(64) as WorkspaceRootIdentityDigest;

function rootDescriptor(
  canonicalRoot: string,
  identity: WorkspaceRootIdentityDigest,
): {
  readonly root: WorkspaceRootDescriptor;
  readonly rootRef: WorkspaceRootRef;
} {
  const rootRef = deriveWorkspaceRootRef(canonicalRoot);
  return {
    rootRef,
    root: {
      rootRef,
      canonicalRoot,
      displayName: canonicalRoot,
      identityDigest: identity,
      sourceDigest: { outcome: "unknown" },
    },
  };
}

function singleRootManifest(
  canonicalRoot: string,
  identity: WorkspaceRootIdentityDigest,
): WorkspaceManifest {
  const { root, rootRef } = rootDescriptor(canonicalRoot, identity);
  return {
    kind: "workspace-manifest",
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    manifestRef: `mf-${"d".repeat(40)}` as WorkspaceManifestRef,
    manifestDigest: "e".repeat(64) as WorkspaceManifestDigest,
    workspaceId: "workspace-fixture",
    revision: 1,
    roots: [root],
    focusedRootRef: rootRef,
  };
}

describe("canonical trust identity derivation", () => {
  it("is deterministic for the same canonical root, manifest, and live identity", () => {
    const manifest = singleRootManifest("/ws/alpha", IDENTITY_A);
    expect(deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS, manifest, IDENTITY_A)).toEqual(
      deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS, manifest, IDENTITY_A),
    );
    expect(deriveWorkspaceRootRef("/ws/alpha")).toBe(
      deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS, manifest, IDENTITY_A).rootRef,
    );
  });

  it("produces a contract-valid binding sourced from the persisted manifest", () => {
    const manifest = singleRootManifest("/ws/alpha", IDENTITY_A);
    const binding = deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS, manifest, IDENTITY_A);
    expect(validateWorkspaceTrustBinding(binding).ok).toBe(true);
    expect(binding.manifestRef).toBe(manifest.manifestRef);
    expect(binding.manifestDigest).toBe(manifest.manifestDigest);
    expect(binding.manifestRevision).toBe(manifest.revision);
    expect(isWorkspaceRootRef(binding.rootRef)).toBe(true);
  });

  it("uses the LIVE root identity digest, not the one persisted in the manifest (#2615)", () => {
    // ADR-0147 D1 binds trust to "root reference and current filesystem identity digest". A manifest
    // that was written before the directory was swapped still carries the old identity; the trust
    // decision must reflect the *current* filesystem so replacing the directory under the same path
    // invalidates the grant.
    const manifest = singleRootManifest("/ws/alpha", IDENTITY_A);
    const binding = deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS, manifest, IDENTITY_B);
    expect(binding.rootIdentityDigest).toBe(IDENTITY_B);
    expect(manifest.roots[0]?.identityDigest).toBe(IDENTITY_A);
  });

  it("rejects a root that is not a current manifest member", () => {
    const manifest = singleRootManifest("/ws/alpha", IDENTITY_A);
    expect(() =>
      deriveWorkspaceTrustBinding("/ws/beta", KNOWN_BASIS, manifest, IDENTITY_A),
    ).toThrow(/WORKSPACE_ROOT_NOT_MEMBER/u);
  });

  it("embeds the trust basis fact verbatim, including non-known outcomes", () => {
    const manifest = singleRootManifest("/ws/alpha", IDENTITY_A);
    const known = deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS, manifest, IDENTITY_A);
    expect(known.trustBasisDigest).toEqual(KNOWN_BASIS);
    const absent = deriveWorkspaceTrustBinding(
      "/ws/alpha",
      { outcome: "absent" },
      manifest,
      IDENTITY_A,
    );
    expect(absent.trustBasisDigest).toEqual({ outcome: "absent" });
    expect(validateWorkspaceTrustBinding(absent).ok).toBe(true);
  });
});
