// Non-reversible scope reference for connector observability (Epic #750, Issue #760).
//
// An audit entry or consent record must NEVER carry a customer board id, link, file key, node id,
// or any design content. But it must still be keyed to "the same connected scope" so the operator
// can correlate connect → snapshot → re-snapshot → revoke for one board without ever recording which
// board it is. The scope reference is the SHA-256 of `${fileKey}:${nodeId}`, hex-encoded: a stable,
// collision-irrelevant, NON-REVERSIBLE digest. The same scope always yields the same ref; two
// different scopes (in practice) yield different refs; and the raw ids cannot be recovered from it.
//
// The hex digest also satisfies `assertValidRunId`'s bounded `[A-Za-z0-9._-]` charset, so it is a
// safe filename key for the reused contained JSON artifact store.

import { sha256Hex } from "@oscharko-dev/keiko-security";

/** Opaque, non-reversible reference to a connected Figma scope. Hex SHA-256, safe as a store key. */
export type FigmaScopeRef = string;

/**
 * Derive the opaque scope reference for a `(fileKey, nodeId)` pair. Pure and deterministic. The
 * inputs are design identifiers and are consumed ONLY to produce the one-way digest — they are not
 * retained anywhere by this function.
 */
export const deriveFigmaScopeRef = (fileKey: string, nodeId: string): FigmaScopeRef =>
  sha256Hex(`${fileKey}:${nodeId}`);
