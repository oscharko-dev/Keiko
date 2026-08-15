import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_MODES,
  compareCodingWorkbenchModeAuthority,
  resolveEffectiveCodingWorkbenchMode,
} from "./coding-workbench.js";
import type { CodingWorkbenchPolicyEffect } from "./coding-workbench.js";
import {
  isWorkspaceManifestDigest,
  isWorkspaceManifestRef,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  isWorkspaceTrustBasisDigest,
} from "./workspace-contract-primitives.js";
import {
  isWorkspaceTrustStatus,
  isWorkspaceRestrictedModeActive,
  projectCommandTaskTrustState,
  strictestWorkspaceTrustPolicyEffect,
  validateWorkspaceTrustBinding,
  validateWorkspaceTrustRecord,
  workspaceTrustPolicyEffect,
  WORKSPACE_TRUST_LEVELS,
  WORKSPACE_TRUST_SCHEMA_VERSION,
  WORKSPACE_TRUST_REASONS,
  type WorkspaceTrustReason,
} from "./workspace-trust.js";
import type {
  WorkspaceTrustAssessment,
  WorkspaceTrustBinding,
  WorkspaceTrustRecord,
  WorkspaceTrustStatus,
} from "./workspace-trust.js";

function checked<Value>(value: string, guard: (input: unknown) => input is Value): Value {
  if (!guard(value)) throw new Error(`invalid fixture: ${value}`);
  return value;
}

const ROOT = checked("root-primary", isWorkspaceRootRef);
const MANIFEST = checked("manifest-primary", isWorkspaceManifestRef);
const ROOT_DIGEST = checked("a".repeat(64), isWorkspaceRootIdentityDigest);
const MANIFEST_DIGEST = checked("b".repeat(64), isWorkspaceManifestDigest);
const TRUST_BASIS = checked("c".repeat(64), isWorkspaceTrustBasisDigest);
const OTHER_ROOT = checked("root-secondary", isWorkspaceRootRef);
const OTHER_MANIFEST = checked("manifest-secondary", isWorkspaceManifestRef);
const OTHER_ROOT_DIGEST = checked("d".repeat(64), isWorkspaceRootIdentityDigest);
const OTHER_MANIFEST_DIGEST = checked("e".repeat(64), isWorkspaceManifestDigest);
const OTHER_TRUST_BASIS = checked("f".repeat(64), isWorkspaceTrustBasisDigest);

function binding(): WorkspaceTrustBinding {
  return {
    manifestRef: MANIFEST,
    manifestRevision: 4,
    manifestDigest: MANIFEST_DIGEST,
    rootRef: ROOT,
    rootIdentityDigest: ROOT_DIGEST,
    trustBasisDigest: { outcome: "known", value: TRUST_BASIS },
  };
}

function trustedRecord(): WorkspaceTrustRecord {
  return {
    kind: "workspace-trust",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    binding: binding(),
    trust: "trusted",
    decidedBy: "server",
    reason: "human-grant",
    revision: 3,
    policyVersion: "workspace-trust-v1",
  };
}

// KEIKO-0244: the suite only ever built TRUSTED records, so the restricted path — which is
// persisted and re-read from disk on every session — had no accept case at all. A validator that
// rejected every restricted record would have passed the whole suite.
function restrictedRecord(reason: WorkspaceTrustReason = "human-revocation"): WorkspaceTrustRecord {
  return { ...trustedRecord(), trust: "restricted", reason };
}

function trustedAssessment(): WorkspaceTrustAssessment {
  return { outcome: "known", value: trustedRecord() };
}

function trustedStatus(): WorkspaceTrustStatus {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId: "/registered/workspace",
    trust: "trusted",
    decidedBy: "server",
    reason: "human-grant",
    revision: 3,
  };
}

describe("restricted workspace trust records", () => {
  it("accepts a restricted record for every non-grant reason", () => {
    for (const reason of WORKSPACE_TRUST_REASONS) {
      if (reason === "human-grant" || reason === "derived-from-trusted-root") continue;
      expect(validateWorkspaceTrustRecord(restrictedRecord(reason))).toEqual({ ok: true });
    }
  });

  it("round-trips a restricted record through JSON, as the persisted store does", () => {
    const cloned: unknown = JSON.parse(JSON.stringify(restrictedRecord()));
    expect(validateWorkspaceTrustRecord(cloned)).toEqual({ ok: true });
  });

  it("still rejects a restricted record decided by a non-server actor", () => {
    expect(validateWorkspaceTrustRecord({ ...restrictedRecord(), decidedBy: "browser" }).ok).toBe(
      false,
    );
  });
});

describe("canonical workspace trust", () => {
  it("accepts only server-owned, manifest/root/basis-bound trust", () => {
    expect(WORKSPACE_TRUST_LEVELS).toEqual(["trusted", "restricted"]);
    expect(validateWorkspaceTrustBinding(binding())).toEqual({ ok: true });
    expect(validateWorkspaceTrustRecord(trustedRecord())).toEqual({ ok: true });
    expect(validateWorkspaceTrustRecord({ ...trustedRecord(), decidedBy: "browser" }).ok).toBe(
      false,
    );
    expect(
      validateWorkspaceTrustRecord({
        ...trustedRecord(),
        binding: { ...binding(), manifestDigest: "stale" },
      }).ok,
    ).toBe(false);
    // A trusted record needs a DETERMINED basis. `unknown` and `unavailable` mean the basis could
    // not be read and must never carry trust; `absent` means it was looked for and definitively is
    // not there, which for the package-script capability is a root with no scripts to execute
    // (ADR-0147 D9, #2613). Conflating absent with unavailable made every non-npm root permanently
    // unable to leave Restricted Mode.
    for (const outcome of ["unknown", "unavailable"] as const) {
      expect(
        validateWorkspaceTrustRecord({
          ...trustedRecord(),
          binding: { ...binding(), trustBasisDigest: { outcome } },
        }).ok,
      ).toBe(false);
    }
    expect(
      validateWorkspaceTrustRecord({
        ...trustedRecord(),
        binding: { ...binding(), trustBasisDigest: { outcome: "absent" } },
      }).ok,
    ).toBe(true);
    expect(
      validateWorkspaceTrustRecord({
        ...trustedRecord(),
        reason: "derived-from-trusted-root",
      }).ok,
    ).toBe(true);
    expect(
      validateWorkspaceTrustRecord({ ...trustedRecord(), trust: "trusted", reason: "policy" }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceTrustRecord({
        ...trustedRecord(),
        trust: "restricted",
        reason: "human-grant",
      }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceTrustRecord({
        ...trustedRecord(),
        trust: "restricted",
        reason: "derived-from-trusted-root",
      }).ok,
    ).toBe(false);
  });

  it("projects only a current exact trusted record to legacy trusted semantics", () => {
    expect(projectCommandTaskTrustState(trustedAssessment(), binding())).toBe("trusted");
    expect(
      projectCommandTaskTrustState(
        { outcome: "known", value: { ...trustedRecord(), trust: "restricted", reason: "policy" } },
        binding(),
      ),
    ).toBe("approval-required");
    for (const outcome of ["unknown", "unavailable", "absent"] as const) {
      expect(projectCommandTaskTrustState({ outcome }, binding())).toBe("approval-required");
    }
    expect(
      projectCommandTaskTrustState(trustedAssessment(), {
        ...binding(),
        trustBasisDigest: {
          outcome: "known",
          value: checked("d".repeat(64), isWorkspaceTrustBasisDigest),
        },
      }),
    ).toBe("approval-required");

    // ADR-0155: every dimension that describes the trusted root still invalidates the grant.
    const staleBindings: readonly WorkspaceTrustBinding[] = [
      { ...binding(), manifestRef: OTHER_MANIFEST },
      { ...binding(), rootRef: OTHER_ROOT },
      { ...binding(), rootIdentityDigest: OTHER_ROOT_DIGEST },
      { ...binding(), trustBasisDigest: { outcome: "known", value: OTHER_TRUST_BASIS } },
      { ...binding(), trustBasisDigest: { outcome: "unknown" } },
      { ...binding(), trustBasisDigest: { outcome: "unavailable" } },
      { ...binding(), trustBasisDigest: { outcome: "absent" } },
    ];
    for (const stale of staleBindings) {
      expect(projectCommandTaskTrustState(trustedAssessment(), stale)).toBe("approval-required");
    }

    // ADR-0155: the workspace-level manifest revision and digest are recorded as provenance but no
    // longer decide validity — they change on focus and reorder, which carry no authority, and
    // including them revoked every grant on an ordinary Explorer click.
    const viewOnlyBindings: readonly WorkspaceTrustBinding[] = [
      { ...binding(), manifestRevision: binding().manifestRevision + 1 },
      { ...binding(), manifestDigest: OTHER_MANIFEST_DIGEST },
      {
        ...binding(),
        manifestRevision: binding().manifestRevision + 9,
        manifestDigest: OTHER_MANIFEST_DIGEST,
      },
    ];
    for (const viewOnly of viewOnlyBindings) {
      expect(projectCommandTaskTrustState(trustedAssessment(), viewOnly)).toBe("trusted");
    }
  });

  it("maps every trust fact and operation class fail closed", () => {
    for (const outcome of ["unknown", "unavailable", "absent"] as const) {
      const assessment: WorkspaceTrustAssessment = { outcome };
      expect(workspaceTrustPolicyEffect(assessment, binding(), "read")).toBe("allowed");
      expect(workspaceTrustPolicyEffect(assessment, binding(), "mutate")).toBe("approval-required");
      expect(workspaceTrustPolicyEffect(assessment, binding(), "execute")).toBe("denied");
    }
    for (const operation of ["read", "mutate", "execute"] as const) {
      expect(workspaceTrustPolicyEffect(trustedAssessment(), binding(), operation)).toBe("allowed");
    }
  });

  it("keeps Restricted Mode independent from the three-mode clamp", () => {
    for (const requested of CODING_WORKBENCH_MODES) {
      for (const ceiling of CODING_WORKBENCH_MODES) {
        const effective = resolveEffectiveCodingWorkbenchMode(requested, ceiling);
        expect(compareCodingWorkbenchModeAuthority(effective, requested)).toBeLessThanOrEqual(0);
        expect(compareCodingWorkbenchModeAuthority(effective, ceiling)).toBeLessThanOrEqual(0);
      }
    }
    expect(isWorkspaceRestrictedModeActive(trustedAssessment(), binding())).toBe(false);
    expect(isWorkspaceRestrictedModeActive({ outcome: "unknown" }, binding())).toBe(true);
  });

  it("can only tighten the strictest-wins fold, with execution denied when restricted", () => {
    const strictness: Readonly<Record<CodingWorkbenchPolicyEffect, number>> = {
      allowed: 0,
      "approval-required": 1,
      denied: 2,
    };
    for (const effect of Object.keys(strictness) as CodingWorkbenchPolicyEffect[]) {
      for (const operation of ["read", "mutate", "execute"] as const) {
        const result = strictestWorkspaceTrustPolicyEffect(
          effect,
          { outcome: "unknown" },
          binding(),
          operation,
        );
        expect(strictness[result]).toBeGreaterThanOrEqual(strictness[effect]);
      }
    }
    expect(
      strictestWorkspaceTrustPolicyEffect("allowed", { outcome: "unknown" }, binding(), "execute"),
    ).toBe("denied");
    expect(
      strictestWorkspaceTrustPolicyEffect("denied", trustedAssessment(), binding(), "read"),
    ).toBe("denied");
  });

  it("keeps validators total for hostile state", () => {
    const hostile = Object.defineProperty({}, "binding", {
      get(): never {
        throw new Error("hostile binding");
      },
    });
    expect(() => validateWorkspaceTrustRecord(hostile)).not.toThrow();
    expect(validateWorkspaceTrustRecord(hostile).ok).toBe(false);
  });

  it("accepts only exact, server-owned redacted browser status", () => {
    expect(isWorkspaceTrustStatus(trustedStatus())).toBe(true);
    expect(isWorkspaceTrustStatus({ ...trustedStatus(), decidedBy: "browser" })).toBe(false);
    expect(
      isWorkspaceTrustStatus({ ...trustedStatus(), trust: "restricted", reason: "human-grant" }),
    ).toBe(false);
    expect(
      isWorkspaceTrustStatus({ ...trustedStatus(), reason: "derived-from-trusted-root" }),
    ).toBe(true);
    expect(isWorkspaceTrustStatus({ ...trustedStatus(), manifestDigest: "secret" })).toBe(false);
    expect(isWorkspaceTrustStatus({ ...trustedStatus(), projectId: "bad\u0000root" })).toBe(false);
    expect(
      isWorkspaceTrustStatus({
        ...trustedStatus(),
        trust: "restricted",
        reason: "manifest-changed",
        revision: 4,
      }),
    ).toBe(true);
  });
});
