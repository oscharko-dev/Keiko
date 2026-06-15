// Cross-package suppression parity (Epic #204, C3).
//
// keiko-memory-retrieval/src/suppression.ts and keiko-memory-governance/src/suppression.ts are
// DUPLICATED BY DESIGN (ADR-0019 leaf rule — neither package may depend on the other), and both file
// headers state: "a drift between the two implementations is a correctness bug". That invariant was
// enforced only by prose; this test enforces it by machine. It lives under tests/ (not in either
// package) so it is allowed to import BOTH barrels.
//
// It sweeps the FULL MemoryStatus enum x a boundary grid of validity windows, confidences, and
// thresholds and asserts the two predicates return byte-identical {suppressed, reason}. A status
// added to one switch but not the other, or any threshold/comparison change in one copy, fails here.

import { describe, expect, it } from "vitest";

import { isMemorySuppressed } from "@oscharko-dev/keiko-memory-retrieval";
import { isMemorySuppressedFromRetrieval } from "@oscharko-dev/keiko-memory-governance";
import {
  MEMORY_STATUSES,
  type MemoryId,
  type MemoryRecord,
  type MemoryStatus,
  type UserId,
} from "@oscharko-dev/keiko-contracts/memory";

const NOW = 1_700_000_000_000;

function record(
  status: MemoryStatus,
  validUntil: number | undefined,
  confidence: number,
): MemoryRecord {
  return {
    id: "mem-parity" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "user-parity" as UserId },
    type: "semantic-fact",
    body: "parity probe",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: NOW,
      confidence,
      sensitivity: "public",
    },
    validity: validUntil === undefined ? { validFrom: 0 } : { validFrom: 0, validUntil },
    status,
    pinned: false,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

// Boundary grids: thresholds and confidences straddle the 0.3 default and the <= comparison; the
// validity grid straddles nowMs (just-before / exactly / just-after).
const THRESHOLDS = [0, 0.3, 0.5, 1];
const CONFIDENCES = [0, 0.3, 0.3000001, 0.5, 0.9, 1];
const VALID_UNTILS: readonly (number | undefined)[] = [undefined, NOW - 1, NOW, NOW + 1];

describe("suppression parity (governance <-> retrieval, #204 C3)", () => {
  it("returns identical {suppressed, reason} for every status x validity x confidence x threshold", () => {
    for (const status of MEMORY_STATUSES) {
      for (const validUntil of VALID_UNTILS) {
        for (const confidence of CONFIDENCES) {
          for (const threshold of THRESHOLDS) {
            const probe = record(status, validUntil, confidence);
            const retrieval = isMemorySuppressed(probe, NOW, threshold);
            const governance = isMemorySuppressedFromRetrieval(probe, NOW, {
              staleConfidenceThreshold: threshold,
            });
            const label = `status=${status} validUntil=${String(validUntil)} confidence=${String(
              confidence,
            )} threshold=${String(threshold)}`;
            expect(governance, label).toEqual(retrieval);
          }
        }
      }
    }
  });

  it("agrees on the shared default threshold (0.3) when governance is called without options", () => {
    // Governance defaults staleConfidenceThreshold to 0.3; retrieval requires it explicitly. Both
    // must agree for every status at exactly the default boundary.
    for (const status of MEMORY_STATUSES) {
      const probe = record(status, undefined, 0.3);
      expect(isMemorySuppressedFromRetrieval(probe, NOW)).toEqual(
        isMemorySuppressed(probe, NOW, 0.3),
      );
    }
  });
});
