import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ManagedLspActivationEvidence,
  ManagedLspLifecycleEvidence,
} from "./managed-lsp-evidence.js";
import {
  MANAGED_LSP_EVIDENCE_ACTOR_CLASSES,
  MANAGED_LSP_EVIDENCE_ACTIONS,
  MANAGED_LSP_EVIDENCE_OUTCOMES,
  MANAGED_LSP_EVIDENCE_SCHEMA_VERSION,
  parseManagedLspEvidence,
} from "./managed-lsp-evidence.js";

type ArbitraryStringKeys<T> = {
  [Key in keyof T]-?: string extends T[Key] ? Key : never;
}[keyof T];

function evidence(kind: "activationChange" | "lifecycle"): Record<string, unknown> {
  return {
    schemaVersion: MANAGED_LSP_EVIDENCE_SCHEMA_VERSION,
    kind,
    action: kind === "lifecycle" ? "lifecycle" : "activate",
    outcome: "accepted",
    actorClass: "localHuman",
    language: "python",
    priorState: "available",
    effectiveState: "active",
    reasonCode: "ACTIVE",
    revision: 7,
    timestampMs: 1_725_000_000_000,
    policyResult: "allowed",
  };
}

describe("managed LSP content-free evidence", () => {
  it("has no field whose type accepts an arbitrary string", () => {
    expectTypeOf<ArbitraryStringKeys<ManagedLspActivationEvidence>>().toEqualTypeOf<never>();
    expectTypeOf<ArbitraryStringKeys<ManagedLspLifecycleEvidence>>().toEqualTypeOf<never>();
  });

  it("pins the frozen closed actor vocabulary", () => {
    expect(MANAGED_LSP_EVIDENCE_SCHEMA_VERSION).toBe("1");
    expect(MANAGED_LSP_EVIDENCE_ACTOR_CLASSES).toStrictEqual([
      "localHuman",
      "operator",
      "policyEngine",
      "system",
    ]);
    expect(Object.isFrozen(MANAGED_LSP_EVIDENCE_ACTOR_CLASSES)).toBe(true);
    expect(MANAGED_LSP_EVIDENCE_ACTIONS).toStrictEqual([
      "activate",
      "deactivate",
      "configure",
      "reset",
      "rollback",
      "restart",
      "lifecycle",
    ]);
    expect(MANAGED_LSP_EVIDENCE_OUTCOMES).toStrictEqual([
      "accepted",
      "denied",
      "noOp",
      "failed",
      "conflict",
    ]);
  });

  it.each(["activationChange", "lifecycle"] as const)("accepts %s evidence", (kind) => {
    expect(parseManagedLspEvidence(evidence(kind))).toStrictEqual({
      ok: true,
      value: evidence(kind),
    });
  });

  it.each(["path", "environment", "sourceText", "stderr", "commandLine", "credentials"])(
    "cannot represent raw %s content",
    (field) => {
      expect(
        parseManagedLspEvidence({ ...evidence("lifecycle"), [field]: "SENTINEL_SECRET" }).ok,
      ).toBe(false);
    },
  );

  it.each([
    null,
    { ...evidence("lifecycle"), actorClass: "admin" },
    { ...evidence("lifecycle"), reasonCode: "raw failure: /Users/alice" },
    { ...evidence("lifecycle"), schemaVersion: "2" },
    { ...evidence("lifecycle"), revision: -1 },
    { ...evidence("lifecycle"), action: "activate" },
    { ...evidence("activationChange"), action: "lifecycle" },
  ])("rejects malformed, open-ended, or schema-skewed evidence", (input) => {
    expect(parseManagedLspEvidence(input).ok).toBe(false);
  });

  it("never throws on hostile evidence", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile ownKeys");
        },
      },
    );
    expect(() => parseManagedLspEvidence(hostile)).not.toThrow();
    expect(parseManagedLspEvidence(hostile).ok).toBe(false);
  });
});
