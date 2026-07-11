import { describe, expect, it, vi } from "vitest";

import type { EvidenceStore, ManagedLspEvidence } from "@oscharko-dev/keiko-contracts";
import { createManagedLspEvidenceProjector } from "./managedLspEvidenceProjector.js";

function evidence(): ManagedLspEvidence {
  return {
    schemaVersion: "1",
    kind: "activationChange",
    action: "activate",
    outcome: "accepted",
    actorClass: "localHuman",
    language: "python",
    priorState: "disabled",
    effectiveState: "available",
    reasonCode: "AVAILABLE",
    revision: 1,
    timestampMs: 1_725_000_000_000,
    policyResult: "allowed",
  };
}

function fakeStore(put: EvidenceStore["put"]): EvidenceStore {
  return { put, list: () => [], get: () => undefined, delete: () => undefined };
}

describe("managed LSP evidence projection", () => {
  it("writes a bounded content-free ledger under an opaque workspace fingerprint", () => {
    let runId = "";
    let json = "";
    const projector = createManagedLspEvidenceProjector(
      fakeStore((id, value) => {
        runId = id;
        json = value;
        return "evidence.json";
      }),
      undefined,
    );

    const result = projector("a".repeat(64), [evidence()]);

    expect(result).toBe("projected");
    expect(runId).toBe(`managed-lsp-${"a".repeat(64)}`);
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: "1",
      kind: "managedLspActivationLedger",
      records: [{ action: "activate", outcome: "accepted" }],
    });
    expect(json).not.toContain("/Users/");
  });

  it("degrades to the already-committed canonical journal when projection fails", () => {
    const failure = vi.fn();
    const projector = createManagedLspEvidenceProjector(
      fakeStore(() => {
        throw new Error("SENTINEL_SECRET_PROJECTOR_FAILURE");
      }),
      failure,
    );

    expect(projector("b".repeat(64), [evidence()])).toBe("canonicalOnly");
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
