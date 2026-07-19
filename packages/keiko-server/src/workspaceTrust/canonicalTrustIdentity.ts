// Issue #2521/#2524, ADR-0146 D1/D3 — pure derivation of WorkspaceTrustBinding from a
// server-resolved canonical root and the observed package-script trust basis. No IO: the caller
// resolves realpath and reads the manifest; this module only frames and hashes already-canonical
// facts. Every digest is domain-separated and length-framed so no field concatenation is ambiguous
// (ADR-0146 D1). Derivation is deterministic: the same canonical root yields the same references and
// digests across restarts, so a persisted record matches on reload and any root change fails closed.

import { createHash } from "node:crypto";
import { WORKSPACE_TRUST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import type {
  WorkspaceFact,
  WorkspaceManifest,
  WorkspaceManifestDigest,
  WorkspaceManifestRef,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
  WorkspaceTrustBasisDigest,
  WorkspaceTrustBinding,
} from "@oscharko-dev/keiko-contracts";
import { deriveWorkspaceRootRef as deriveCanonicalWorkspaceRootRef } from "../workspace-root-identity.js";

// Single synthetic-root manifest revision. #2521 owns exactly one canonical root per project;
// ordered multi-root membership and real manifest revisions land with #2524, at which point older
// records mismatch and fail closed to restricted (a one-time re-grant, per the issue Update Impact).
const SINGLE_ROOT_MANIFEST_REVISION = 1;
// Opaque references stay well inside the contract's 3..96 char bound: "root-"/"mf-" + 40 hex chars.
const REFERENCE_HEX_CHARS = 40;

// Domain-separated, length-framed SHA-256. The domain tag and each part are framed by an explicit
// 4-byte big-endian length so ("a","bc") can never collide with ("ab","c").
function framedDigestHex(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  const domainBytes = Buffer.from(domain, "utf8");
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32BE(domainBytes.length, 0);
  hash.update(domainLength);
  hash.update(domainBytes);
  for (const part of parts) {
    const partBytes = Buffer.from(part, "utf8");
    const partLength = Buffer.alloc(4);
    partLength.writeUInt32BE(partBytes.length, 0);
    hash.update(partLength);
    hash.update(partBytes);
  }
  return hash.digest("hex");
}

// A self-computed SHA-256 hex string is by construction a valid digest brand; a derived
// "root-"/"mf-" + hex string is by construction a valid opaque reference. The casts document that
// these values never cross a trust boundary — untrusted input is validated separately on store read.
function legacyRootIdentityDigestOf(canonicalRoot: string): WorkspaceRootIdentityDigest {
  return framedDigestHex("keiko.m11.root-identity.v1", [
    canonicalRoot,
  ]) as WorkspaceRootIdentityDigest;
}

function manifestReferenceOf(canonicalRoot: string): WorkspaceManifestRef {
  const digest = framedDigestHex("keiko.m11.manifest-ref.v1", [canonicalRoot]);
  return `mf-${digest.slice(0, REFERENCE_HEX_CHARS)}` as WorkspaceManifestRef;
}

function manifestDigestOf(
  rootRef: WorkspaceRootRef,
  rootIdentityDigest: WorkspaceRootIdentityDigest,
): WorkspaceManifestDigest {
  return framedDigestHex("keiko.m11.manifest.v1", [
    String(WORKSPACE_TRUST_SCHEMA_VERSION),
    String(SINGLE_ROOT_MANIFEST_REVISION),
    rootRef,
    rootIdentityDigest,
  ]) as WorkspaceManifestDigest;
}

// The opaque root reference is also the persistence key; exposed so the store lookup and the derived
// binding always agree on the identity of the root under evaluation.
export function deriveWorkspaceRootRef(canonicalRoot: string): WorkspaceRootRef {
  return deriveCanonicalWorkspaceRootRef(canonicalRoot);
}

export function deriveWorkspaceTrustBinding(
  canonicalRoot: string,
  trustBasisDigest: WorkspaceFact<WorkspaceTrustBasisDigest>,
  manifest?: WorkspaceManifest,
): WorkspaceTrustBinding {
  const manifestRoot = manifest?.roots.find((root) => root.canonicalRoot === canonicalRoot);
  if (manifest !== undefined && manifestRoot === undefined) {
    throw new Error("WORKSPACE_ROOT_NOT_MEMBER");
  }
  if (manifest !== undefined && manifestRoot !== undefined) {
    return {
      manifestRef: manifest.manifestRef,
      manifestRevision: manifest.revision,
      manifestDigest: manifest.manifestDigest,
      rootRef: manifestRoot.rootRef,
      rootIdentityDigest: manifestRoot.identityDigest,
      trustBasisDigest,
    };
  }
  const rootIdentityDigest = legacyRootIdentityDigestOf(canonicalRoot);
  const rootRef = deriveCanonicalWorkspaceRootRef(canonicalRoot);
  return {
    manifestRef: manifestReferenceOf(canonicalRoot),
    manifestRevision: SINGLE_ROOT_MANIFEST_REVISION,
    manifestDigest: manifestDigestOf(rootRef, rootIdentityDigest),
    rootRef,
    rootIdentityDigest,
    trustBasisDigest,
  };
}
