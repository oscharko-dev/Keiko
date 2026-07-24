import { describe, expect, it } from "vitest";
import {
  isWorkspaceManifestDigest,
  isWorkspaceManifestRef,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  validateWorkspaceTrustBinding,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFact, WorkspaceTrustBasisDigest } from "@oscharko-dev/keiko-contracts";
import { deriveWorkspaceRootRef, deriveWorkspaceTrustBinding } from "./canonicalTrustIdentity.js";

const KNOWN_BASIS: WorkspaceFact<WorkspaceTrustBasisDigest> = {
  outcome: "known",
  value: "a".repeat(64) as WorkspaceTrustBasisDigest,
};

describe("canonical trust identity derivation", () => {
  it("is deterministic for the same canonical root", () => {
    expect(deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS)).toEqual(
      deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS),
    );
    expect(deriveWorkspaceRootRef("/ws/alpha")).toBe(
      deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS).rootRef,
    );
  });

  it("produces a contract-valid binding with a fixed single-root manifest revision", () => {
    const binding = deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS);
    expect(validateWorkspaceTrustBinding(binding).ok).toBe(true);
    expect(binding.manifestRevision).toBe(1);
    expect(isWorkspaceRootRef(binding.rootRef)).toBe(true);
    expect(isWorkspaceManifestRef(binding.manifestRef)).toBe(true);
    expect(isWorkspaceRootIdentityDigest(binding.rootIdentityDigest)).toBe(true);
    expect(isWorkspaceManifestDigest(binding.manifestDigest)).toBe(true);
  });

  it("domain-separates the derived references and digests for one root", () => {
    const binding = deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS);
    const values = new Set<string>([
      binding.rootRef,
      binding.manifestRef,
      binding.rootIdentityDigest,
      binding.manifestDigest,
    ]);
    expect(values.size).toBe(4);
  });

  it("separates distinct roots across every identity dimension", () => {
    const alpha = deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS);
    const beta = deriveWorkspaceTrustBinding("/ws/beta", KNOWN_BASIS);
    expect(alpha.rootRef).not.toBe(beta.rootRef);
    expect(alpha.manifestRef).not.toBe(beta.manifestRef);
    expect(alpha.rootIdentityDigest).not.toBe(beta.rootIdentityDigest);
    expect(alpha.manifestDigest).not.toBe(beta.manifestDigest);
  });

  it("embeds the trust basis fact verbatim, including non-known outcomes", () => {
    expect(deriveWorkspaceTrustBinding("/ws/alpha", KNOWN_BASIS).trustBasisDigest).toEqual(
      KNOWN_BASIS,
    );
    const absentBasis = deriveWorkspaceTrustBinding("/ws/alpha", { outcome: "absent" });
    expect(absentBasis.trustBasisDigest).toEqual({ outcome: "absent" });
    expect(validateWorkspaceTrustBinding(absentBasis).ok).toBe(true);
  });
});
