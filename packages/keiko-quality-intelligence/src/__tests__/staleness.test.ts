// Unit tests for compareStaleness (Epic #735, Issue #742).
// Pure function — no IO.

import { describe, expect, it } from "vitest";
import { compareStaleness } from "../domain/staleness.js";
import type { CompareStalenessArgs } from "../domain/staleness.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fp(
  envelopeId: string,
  hash: string,
): { envelopeId: string; integrityHashSha256Hex: string } {
  return { envelopeId, integrityHashSha256Hex: hash };
}

function ref(envelopeId: string, atomId: string): { envelopeId: string; atomId: string } {
  return { envelopeId, atomId };
}

function atomFp(
  atomId: string,
  envelopeId: string,
  canonicalHashSha256Hex: string,
): {
  atomId: string;
  envelopeId: string;
  canonicalHashSha256Hex: string;
} {
  return { atomId, envelopeId, canonicalHashSha256Hex };
}

function cand(
  id: string,
  ...atomIds: string[]
): { id: string; derivedFromAtomIds: readonly string[] } {
  return { id, derivedFromAtomIds: atomIds };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("compareStaleness — fresh (same hash)", () => {
  it("returns all candidates fresh when nothing changed", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-1", "aaa"), fp("env-2", "bbb")],
      evidenceRefs: [ref("env-1", "atom-1"), ref("env-2", "atom-2")],
      candidates: [cand("tc-1", "atom-1"), cand("tc-2", "atom-2")],
      currentFingerprints: [fp("env-1", "aaa"), fp("env-2", "bbb")],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toEqual(["tc-1", "tc-2"]);
    expect(result.changedStale).toHaveLength(0);
    expect(result.orphanedStale).toHaveLength(0);
  });
});

describe("compareStaleness — source-changed", () => {
  it("marks only the affected candidate as changedStale when one source hash changes", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-1", "aaa"), fp("env-2", "bbb")],
      evidenceRefs: [ref("env-1", "atom-1"), ref("env-2", "atom-2")],
      candidates: [cand("tc-1", "atom-1"), cand("tc-2", "atom-2")],
      currentFingerprints: [fp("env-1", "NEW"), fp("env-2", "bbb")],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toEqual(["tc-2"]);
    expect(result.changedStale).toHaveLength(1);
    expect(result.changedStale[0]?.candidateId).toBe("tc-1");
    expect(result.changedStale[0]?.reason).toBe("source-changed");
    expect(result.changedStale[0]?.envelopeId).toBe("env-1");
    expect(result.orphanedStale).toHaveLength(0);
  });

  it("marks only the changed requirement candidate stale when atom-level fingerprints are available", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("qi-src-req-old", "req-hash-old")],
      oldAtomFingerprints: [
        atomFp("atom-req-1", "qi-src-req-old", "hash-req-1"),
        atomFp("atom-req-2", "qi-src-req-old", "hash-req-2"),
      ],
      evidenceRefs: [ref("qi-src-req-old", "atom-req-1"), ref("qi-src-req-old", "atom-req-2")],
      candidates: [cand("tc-1", "atom-req-1"), cand("tc-2", "atom-req-2")],
      currentFingerprints: [fp("qi-src-req-old", "req-hash-new")],
      currentAtomFingerprints: [
        atomFp("atom-req-1", "qi-src-req-old", "hash-req-1"),
        atomFp("atom-req-2b", "qi-src-req-old", "hash-req-2b"),
      ],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toEqual(["tc-1"]);
    expect(result.changedStale).toEqual([
      { candidateId: "tc-2", reason: "source-changed", envelopeId: "qi-src-req-old" },
    ]);
    expect(result.orphanedStale).toHaveLength(0);
  });

  it("marks a workspace candidate stale when the same atom id keeps its path but changes content", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-workspace", "workspace-a")],
      oldAtomFingerprints: [atomFp("atom-file-1", "env-workspace", "old-file-hash")],
      evidenceRefs: [ref("env-workspace", "atom-file-1")],
      candidates: [cand("tc-file", "atom-file-1")],
      currentFingerprints: [fp("env-workspace", "workspace-a")],
      currentAtomFingerprints: [atomFp("atom-file-1", "env-workspace", "new-file-hash")],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toHaveLength(0);
    expect(result.changedStale).toEqual([
      { candidateId: "tc-file", reason: "source-changed", envelopeId: "env-workspace" },
    ]);
  });
});

describe("compareStaleness — source-removed", () => {
  it("marks candidates orphanedStale when their source envelope disappears from current", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-1", "aaa"), fp("env-2", "bbb")],
      evidenceRefs: [ref("env-1", "atom-1"), ref("env-2", "atom-2")],
      candidates: [cand("tc-1", "atom-1"), cand("tc-2", "atom-2")],
      // env-2 no longer present in current fingerprints
      currentFingerprints: [fp("env-1", "aaa")],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toEqual(["tc-1"]);
    expect(result.changedStale).toHaveLength(0);
    expect(result.orphanedStale).toHaveLength(1);
    expect(result.orphanedStale[0]?.candidateId).toBe("tc-2");
    expect(result.orphanedStale[0]?.reason).toBe("source-removed");
  });
});

describe("compareStaleness — new source in current (no false positives)", () => {
  it("does not create false positives when current has MORE envelopes than old", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-1", "aaa")],
      evidenceRefs: [ref("env-1", "atom-1")],
      candidates: [cand("tc-1", "atom-1")],
      // env-2 is new — not relevant to tc-1
      currentFingerprints: [fp("env-1", "aaa"), fp("env-2", "ccc")],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toEqual(["tc-1"]);
    expect(result.changedStale).toHaveLength(0);
    expect(result.orphanedStale).toHaveLength(0);
  });

  it("does not stale an unchanged requirement candidate when a different statement is added", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("qi-src-req-old", "req-hash-old")],
      oldAtomFingerprints: [atomFp("atom-req-1", "qi-src-req-old", "hash-req-1")],
      evidenceRefs: [ref("qi-src-req-old", "atom-req-1")],
      candidates: [cand("tc-1", "atom-req-1")],
      currentFingerprints: [fp("qi-src-req-old", "req-hash-new")],
      currentAtomFingerprints: [
        atomFp("atom-req-1", "qi-src-req-old", "hash-req-1"),
        atomFp("atom-req-2", "qi-src-req-old", "hash-req-2"),
      ],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toEqual(["tc-1"]);
    expect(result.changedStale).toHaveLength(0);
    expect(result.orphanedStale).toHaveLength(0);
  });
});

describe("compareStaleness — empty currentFingerprints", () => {
  it("marks all candidates as orphanedStale when currentFingerprints is empty", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-1", "aaa"), fp("env-2", "bbb")],
      evidenceRefs: [ref("env-1", "atom-1"), ref("env-2", "atom-2")],
      candidates: [cand("tc-1", "atom-1"), cand("tc-2", "atom-2")],
      currentFingerprints: [],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toHaveLength(0);
    expect(result.changedStale).toHaveLength(0);
    expect(result.orphanedStale).toHaveLength(2);
    expect(result.orphanedStale.map((r) => r.candidateId)).toEqual(["tc-1", "tc-2"]);
  });
});

describe("compareStaleness — candidate deriving from two envelopes", () => {
  it("marks candidate stale when any of its source envelopes change", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-1", "aaa"), fp("env-2", "bbb")],
      evidenceRefs: [ref("env-1", "atom-1"), ref("env-2", "atom-2")],
      // tc-multi derives from BOTH atom-1 and atom-2
      candidates: [cand("tc-multi", "atom-1", "atom-2")],
      currentFingerprints: [fp("env-1", "aaa"), fp("env-2", "CHANGED")],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toHaveLength(0);
    expect(result.changedStale).toHaveLength(1);
    expect(result.changedStale[0]?.candidateId).toBe("tc-multi");
    expect(result.changedStale[0]?.reason).toBe("source-changed");
  });
});

describe("compareStaleness — removed takes precedence over changed", () => {
  it("reports source-removed when envelope is both changed (in old) and absent in current", () => {
    // env-1 exists in old but not in current; env-2 has changed hash.
    // For tc-both: env-1 removed, env-2 changed — removed should dominate per evidenceRefs order.
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-1", "aaa"), fp("env-2", "bbb")],
      // env-1 is first in evidenceRefs — removed takes precedence
      evidenceRefs: [ref("env-1", "atom-1"), ref("env-2", "atom-2")],
      candidates: [cand("tc-both", "atom-1", "atom-2")],
      currentFingerprints: [fp("env-2", "CHANGED")],
    };
    const result = compareStaleness(args);
    expect(result.orphanedStale).toHaveLength(1);
    expect(result.orphanedStale[0]?.reason).toBe("source-removed");
    expect(result.orphanedStale[0]?.envelopeId).toBe("env-1");
    expect(result.changedStale).toHaveLength(0);
  });
});

describe("compareStaleness — unknown atom", () => {
  it("marks candidate stale when it derives from an atom with no known envelope", () => {
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-1", "aaa")],
      evidenceRefs: [ref("env-1", "atom-1")],
      // tc-unknown derives from atom-999 which has no evidenceRef mapping
      candidates: [cand("tc-unknown", "atom-999")],
      currentFingerprints: [fp("env-1", "aaa")],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toHaveLength(0);
    expect(result.changedStale.length + result.orphanedStale.length).toBeGreaterThanOrEqual(1);
    const stale = [...result.changedStale, ...result.orphanedStale];
    expect(stale.some((r) => r.candidateId === "tc-unknown")).toBe(true);
  });
});

describe("compareStaleness — deterministic order", () => {
  it("preserves candidate input order in the fresh list", () => {
    const ids = ["tc-c", "tc-a", "tc-b"];
    const args: CompareStalenessArgs = {
      oldFingerprints: [fp("env-1", "aaa")],
      evidenceRefs: [ref("env-1", "atom-1")],
      candidates: ids.map((id) => cand(id, "atom-1")),
      currentFingerprints: [fp("env-1", "aaa")],
    };
    const result = compareStaleness(args);
    expect(result.fresh).toEqual(ids);
  });
});
