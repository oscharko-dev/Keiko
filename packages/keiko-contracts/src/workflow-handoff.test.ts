// Unit tests for workflow-handoff.ts. Each negative test mutates exactly one field of a
// known-good fixture so failures point precisely at the broken invariant. Fixture factories
// mirror the #178 connected-context.test.ts style.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PATCH_SCOPE_LIMITS,
  EXPECTED_CHECKS,
  WORKFLOW_HANDOFF_SCHEMA_VERSION,
  WORKFLOW_KINDS,
  checkPatchAgainstScope,
  isApprovalTokenShape,
  validatePatchScope,
  validateWorkflowHandoffRequest,
} from "./workflow-handoff.js";
import type {
  ExpectedCheck,
  PatchScope,
  PatchScopeLimits,
  PatchScopeViolation,
  ProposedPatchEntry,
  UserApprovalTokenInput,
  ValidationResult,
  WorkflowHandoffRequest,
  WorkflowKind,
} from "./workflow-handoff.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const VALID_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const VALID_PACK_LEAF_ID = "pl-0123456789abcdef" as const;
const VALID_PACK_FULL_ID =
  "p-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

function happyPatchScope(): PatchScope {
  return {
    schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
    editablePaths: ["src/index.ts"],
    readOnlyPaths: [],
    evidenceAtomIds: ["atom-1"],
    limits: DEFAULT_PATCH_SCOPE_LIMITS,
    expectedChecks: ["verify"],
    unknowns: [],
  };
}

function happyHandoffRequest(): WorkflowHandoffRequest {
  return {
    schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
    contextPackStableId: VALID_PACK_LEAF_ID,
    workflowKind: "unit-test-generation",
    patchScope: happyPatchScope(),
    requestedAtMs: 1_000,
    userApprovalToken: VALID_TOKEN,
  };
}

function expectInvalidWithReason(result: ValidationResult, fragment: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.reasons.some((reason) => reason.includes(fragment))).toBe(true);
}

function findViolation(
  violations: readonly PatchScopeViolation[],
  kind: PatchScopeViolation["kind"],
): PatchScopeViolation | undefined {
  return violations.find((violation) => violation.kind === kind);
}

// ─── Schema discriminant ──────────────────────────────────────────────────────
describe("WORKFLOW_HANDOFF_SCHEMA_VERSION", () => {
  it("is the literal '1'", () => {
    expect(WORKFLOW_HANDOFF_SCHEMA_VERSION).toBe("1");
  });

  it("can be assigned to typeof WORKFLOW_HANDOFF_SCHEMA_VERSION", () => {
    const scope: PatchScope = happyPatchScope();
    expect(scope.schemaVersion).toBe(WORKFLOW_HANDOFF_SCHEMA_VERSION);
  });
});

// ─── Default limits ───────────────────────────────────────────────────────────
describe("DEFAULT_PATCH_SCOPE_LIMITS", () => {
  it("has four positive integer dimensions", () => {
    const dims: readonly number[] = [
      DEFAULT_PATCH_SCOPE_LIMITS.maxFileCount,
      DEFAULT_PATCH_SCOPE_LIMITS.maxPatchBytes,
      DEFAULT_PATCH_SCOPE_LIMITS.maxNewFiles,
      DEFAULT_PATCH_SCOPE_LIMITS.elapsedMsMax,
    ];
    expect(dims).toHaveLength(4);
    for (const value of dims) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("maxFileCount strictly exceeds maxNewFiles (new files are a subset)", () => {
    expect(DEFAULT_PATCH_SCOPE_LIMITS.maxFileCount).toBeGreaterThan(
      DEFAULT_PATCH_SCOPE_LIMITS.maxNewFiles,
    );
  });

  it("maxPatchBytes is 64 KiB", () => {
    expect(DEFAULT_PATCH_SCOPE_LIMITS.maxPatchBytes).toBe(65_536);
  });
});

// ─── EXPECTED_CHECKS table ────────────────────────────────────────────────────
describe("EXPECTED_CHECKS", () => {
  it("has five members in declared order", () => {
    expect(EXPECTED_CHECKS).toEqual(["verify", "lint", "typecheck", "tests", "manual"]);
  });

  it("each member is a valid ExpectedCheck", () => {
    for (const check of EXPECTED_CHECKS) {
      const pinned: ExpectedCheck = check;
      expect(EXPECTED_CHECKS.includes(pinned)).toBe(true);
    }
  });
});

// ─── WORKFLOW_KINDS table ─────────────────────────────────────────────────────
describe("WORKFLOW_KINDS", () => {
  it("has three members in declared order", () => {
    expect(WORKFLOW_KINDS).toEqual(["unit-test-generation", "bug-investigation", "verification"]);
  });

  it("each member is a valid WorkflowKind", () => {
    for (const kind of WORKFLOW_KINDS) {
      const pinned: WorkflowKind = kind;
      expect(WORKFLOW_KINDS.includes(pinned)).toBe(true);
    }
  });
});

// ─── isApprovalTokenShape ─────────────────────────────────────────────────────
describe("isApprovalTokenShape", () => {
  it("accepts a 64-character lowercase hex string", () => {
    expect(isApprovalTokenShape(VALID_TOKEN)).toBe(true);
  });

  it("rejects an uppercase hex string", () => {
    expect(isApprovalTokenShape(VALID_TOKEN.toUpperCase())).toBe(false);
  });

  it("rejects a 63-character string", () => {
    expect(isApprovalTokenShape(VALID_TOKEN.slice(0, 63))).toBe(false);
  });

  it("rejects a 65-character string", () => {
    expect(isApprovalTokenShape(`${VALID_TOKEN}a`)).toBe(false);
  });

  it("rejects a string with a non-hex character", () => {
    expect(isApprovalTokenShape(`${VALID_TOKEN.slice(0, 63)}z`)).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isApprovalTokenShape("")).toBe(false);
  });
});

// ─── validatePatchScope ───────────────────────────────────────────────────────
describe("validatePatchScope", () => {
  it("accepts the happy fixture", () => {
    expect(validatePatchScope(happyPatchScope())).toEqual({ ok: true });
  });

  it("rejects mismatched schemaVersion", () => {
    const scope = { ...happyPatchScope(), schemaVersion: "2" } as unknown as PatchScope;
    expectInvalidWithReason(validatePatchScope(scope), "schemaVersion");
  });

  it("accepts a scope with no editable or read-only paths", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: [],
      readOnlyPaths: [],
    };
    expect(validatePatchScope(scope)).toEqual({ ok: true });
  });

  it("rejects duplicate editablePaths", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["src/a.ts", "src/a.ts"],
    };
    expectInvalidWithReason(validatePatchScope(scope), "editablePaths contains duplicates");
  });

  it("rejects duplicate readOnlyPaths", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      readOnlyPaths: ["src/r.ts", "src/r.ts"],
    };
    expectInvalidWithReason(validatePatchScope(scope), "readOnlyPaths contains duplicates");
  });

  it("rejects editable + read-only overlap", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["src/shared.ts"],
      readOnlyPaths: ["src/shared.ts"],
    };
    expectInvalidWithReason(validatePatchScope(scope), "overlaps readOnlyPaths");
  });

  it("rejects an invalid editable path", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["../escape.ts"],
    };
    expectInvalidWithReason(validatePatchScope(scope), "editablePaths contains invalid path");
  });

  it("rejects an invalid read-only path", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      readOnlyPaths: ["/abs/path.ts"],
    };
    expectInvalidWithReason(validatePatchScope(scope), "readOnlyPaths contains invalid path");
  });

  it("rejects an empty editable-path entry", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: [""],
    };
    expectInvalidWithReason(validatePatchScope(scope), "editablePaths contains empty entry");
  });

  it("rejects duplicate evidenceAtomIds", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      evidenceAtomIds: ["atom-1", "atom-1"],
    };
    expectInvalidWithReason(validatePatchScope(scope), "evidenceAtomIds contains duplicates");
  });

  it("rejects empty evidenceAtomIds", () => {
    const scope: PatchScope = { ...happyPatchScope(), evidenceAtomIds: [] };
    expectInvalidWithReason(validatePatchScope(scope), "evidenceAtomIds empty");
  });

  it("rejects an empty evidenceAtomId entry", () => {
    const scope: PatchScope = { ...happyPatchScope(), evidenceAtomIds: ["   "] };
    expectInvalidWithReason(validatePatchScope(scope), "evidenceAtomIds contains empty entry");
  });

  it("rejects empty expectedChecks", () => {
    const scope: PatchScope = { ...happyPatchScope(), expectedChecks: [] };
    expectInvalidWithReason(validatePatchScope(scope), "expectedChecks empty");
  });

  it("rejects an invalid expectedCheck value", () => {
    const scope = {
      ...happyPatchScope(),
      expectedChecks: ["fuzz"],
    } as unknown as PatchScope;
    expectInvalidWithReason(validatePatchScope(scope), "expectedChecks contains invalid value");
  });

  it("rejects a negative maxFileCount", () => {
    const limits: PatchScopeLimits = { ...DEFAULT_PATCH_SCOPE_LIMITS, maxFileCount: -1 };
    expectInvalidWithReason(
      validatePatchScope({ ...happyPatchScope(), limits }),
      "limits.maxFileCount invalid",
    );
  });

  it("rejects a non-integer maxPatchBytes", () => {
    const limits: PatchScopeLimits = { ...DEFAULT_PATCH_SCOPE_LIMITS, maxPatchBytes: 1.5 };
    expectInvalidWithReason(
      validatePatchScope({ ...happyPatchScope(), limits }),
      "limits.maxPatchBytes invalid",
    );
  });

  it("rejects a NaN elapsedMsMax", () => {
    const limits: PatchScopeLimits = {
      ...DEFAULT_PATCH_SCOPE_LIMITS,
      elapsedMsMax: Number.NaN,
    };
    expectInvalidWithReason(
      validatePatchScope({ ...happyPatchScope(), limits }),
      "limits.elapsedMsMax invalid",
    );
  });

  it("rejects an Infinity maxNewFiles", () => {
    const limits: PatchScopeLimits = {
      ...DEFAULT_PATCH_SCOPE_LIMITS,
      maxNewFiles: Number.POSITIVE_INFINITY,
    };
    expectInvalidWithReason(
      validatePatchScope({ ...happyPatchScope(), limits }),
      "limits.maxNewFiles invalid",
    );
  });

  it("rejects a non-string unknown entry", () => {
    const scope = {
      ...happyPatchScope(),
      unknowns: [42],
    } as unknown as PatchScope;
    expectInvalidWithReason(validatePatchScope(scope), "unknowns contains non-string entry");
  });

  it("accepts non-empty unknowns of strings", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      unknowns: ["does the helper return null on empty input?"],
    };
    expect(validatePatchScope(scope)).toEqual({ ok: true });
  });
});

// ─── validateWorkflowHandoffRequest ───────────────────────────────────────────
describe("validateWorkflowHandoffRequest", () => {
  it("accepts the happy fixture (leaf-style pack id)", () => {
    expect(validateWorkflowHandoffRequest(happyHandoffRequest())).toEqual({ ok: true });
  });

  it("accepts a full-style pack id", () => {
    const request: WorkflowHandoffRequest = {
      ...happyHandoffRequest(),
      contextPackStableId: VALID_PACK_FULL_ID,
    };
    expect(validateWorkflowHandoffRequest(request)).toEqual({ ok: true });
  });

  it("rejects mismatched schemaVersion", () => {
    const request = {
      ...happyHandoffRequest(),
      schemaVersion: "2",
    } as unknown as WorkflowHandoffRequest;
    expectInvalidWithReason(validateWorkflowHandoffRequest(request), "schemaVersion");
  });

  it("rejects an empty contextPackStableId", () => {
    const request: WorkflowHandoffRequest = {
      ...happyHandoffRequest(),
      contextPackStableId: "",
    };
    expectInvalidWithReason(validateWorkflowHandoffRequest(request), "contextPackStableId empty");
  });

  it("rejects a malformed contextPackStableId (no prefix)", () => {
    const request: WorkflowHandoffRequest = {
      ...happyHandoffRequest(),
      contextPackStableId: "not-a-pack",
    };
    expectInvalidWithReason(
      validateWorkflowHandoffRequest(request),
      "contextPackStableId malformed",
    );
  });

  it("rejects a leaf-style id with wrong hex length", () => {
    const request: WorkflowHandoffRequest = {
      ...happyHandoffRequest(),
      contextPackStableId: "pl-deadbeef",
    };
    expectInvalidWithReason(
      validateWorkflowHandoffRequest(request),
      "contextPackStableId malformed",
    );
  });

  it("rejects an unknown workflowKind", () => {
    const request = {
      ...happyHandoffRequest(),
      workflowKind: "refactor",
    } as unknown as WorkflowHandoffRequest;
    expectInvalidWithReason(validateWorkflowHandoffRequest(request), "workflowKind invalid");
  });

  it("rejects a negative requestedAtMs", () => {
    const request: WorkflowHandoffRequest = {
      ...happyHandoffRequest(),
      requestedAtMs: -1,
    };
    expectInvalidWithReason(validateWorkflowHandoffRequest(request), "requestedAtMs invalid");
  });

  it("rejects a fractional requestedAtMs", () => {
    const request: WorkflowHandoffRequest = {
      ...happyHandoffRequest(),
      requestedAtMs: 1.5,
    };
    expectInvalidWithReason(validateWorkflowHandoffRequest(request), "requestedAtMs invalid");
  });

  it("rejects an uppercase approval token", () => {
    const request: WorkflowHandoffRequest = {
      ...happyHandoffRequest(),
      userApprovalToken: VALID_TOKEN.toUpperCase(),
    };
    expectInvalidWithReason(validateWorkflowHandoffRequest(request), "userApprovalToken malformed");
  });

  it("rejects an approval token of wrong length", () => {
    const request: WorkflowHandoffRequest = {
      ...happyHandoffRequest(),
      userApprovalToken: VALID_TOKEN.slice(0, 32),
    };
    expectInvalidWithReason(validateWorkflowHandoffRequest(request), "userApprovalToken malformed");
  });

  it("cascades nested patchScope reasons under request.* prefix", () => {
    const request: WorkflowHandoffRequest = {
      ...happyHandoffRequest(),
      patchScope: { ...happyPatchScope(), expectedChecks: [] },
    };
    expectInvalidWithReason(
      validateWorkflowHandoffRequest(request),
      "request.patchScope.expectedChecks empty",
    );
  });
});

// ─── checkPatchAgainstScope ───────────────────────────────────────────────────
describe("checkPatchAgainstScope", () => {
  it("accepts an empty proposed list", () => {
    expect(checkPatchAgainstScope(happyPatchScope(), [])).toEqual({ ok: true });
  });

  it("accepts a single in-scope proposal", () => {
    const proposed: readonly ProposedPatchEntry[] = [
      { path: "src/index.ts", newFile: false, patchBytes: 100 },
    ];
    expect(checkPatchAgainstScope(happyPatchScope(), proposed)).toEqual({ ok: true });
  });

  it("flags a path outside the editable set with the path attached", () => {
    const proposed: readonly ProposedPatchEntry[] = [
      { path: "src/other.ts", newFile: false, patchBytes: 10 },
    ];
    const result = checkPatchAgainstScope(happyPatchScope(), proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const violation = findViolation(result.violations, "outside-editable-set");
    expect(violation).toBeDefined();
    expect(violation?.path).toBe("src/other.ts");
  });

  it("flags exceeds-max-file-count with observed + limit", () => {
    const tightScope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["a", "b", "c"],
      limits: { ...DEFAULT_PATCH_SCOPE_LIMITS, maxFileCount: 2 },
    };
    const proposed: readonly ProposedPatchEntry[] = [
      { path: "a", newFile: false, patchBytes: 1 },
      { path: "b", newFile: false, patchBytes: 1 },
      { path: "c", newFile: false, patchBytes: 1 },
    ];
    const result = checkPatchAgainstScope(tightScope, proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const violation = findViolation(result.violations, "exceeds-max-file-count");
    expect(violation?.observed).toBe(3);
    expect(violation?.limit).toBe(2);
  });

  it("flags exceeds-max-patch-bytes when the sum exceeds the limit", () => {
    const tightScope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["a", "b"],
      limits: { ...DEFAULT_PATCH_SCOPE_LIMITS, maxPatchBytes: 100 },
    };
    const proposed: readonly ProposedPatchEntry[] = [
      { path: "a", newFile: false, patchBytes: 60 },
      { path: "b", newFile: false, patchBytes: 60 },
    ];
    const result = checkPatchAgainstScope(tightScope, proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const violation = findViolation(result.violations, "exceeds-max-patch-bytes");
    expect(violation?.observed).toBe(120);
    expect(violation?.limit).toBe(100);
  });

  it("flags exceeds-max-new-files when newFile count exceeds the limit", () => {
    const tightScope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["a", "b", "c"],
      limits: { ...DEFAULT_PATCH_SCOPE_LIMITS, maxNewFiles: 1 },
    };
    const proposed: readonly ProposedPatchEntry[] = [
      { path: "a", newFile: true, patchBytes: 1 },
      { path: "b", newFile: true, patchBytes: 1 },
      { path: "c", newFile: false, patchBytes: 1 },
    ];
    const result = checkPatchAgainstScope(tightScope, proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const violation = findViolation(result.violations, "exceeds-max-new-files");
    expect(violation?.observed).toBe(2);
    expect(violation?.limit).toBe(1);
  });

  it("flags no-expected-checks when scope.expectedChecks is empty", () => {
    const scope: PatchScope = { ...happyPatchScope(), expectedChecks: [] };
    const result = checkPatchAgainstScope(scope, []);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(findViolation(result.violations, "no-expected-checks")).toBeDefined();
  });

  it("accumulates multiple violations from one call", () => {
    const tightScope: PatchScope = {
      schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
      editablePaths: ["a"],
      readOnlyPaths: [],
      evidenceAtomIds: ["atom-1"],
      limits: {
        maxFileCount: 1,
        maxPatchBytes: 10,
        maxNewFiles: 0,
        elapsedMsMax: 60_000,
      },
      expectedChecks: [],
      unknowns: [],
    };
    const proposed: readonly ProposedPatchEntry[] = [
      { path: "a", newFile: true, patchBytes: 5 },
      { path: "outside", newFile: true, patchBytes: 50 },
    ];
    const result = checkPatchAgainstScope(tightScope, proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const kinds = new Set(result.violations.map((violation) => violation.kind));
    expect(kinds.has("outside-editable-set")).toBe(true);
    expect(kinds.has("exceeds-max-file-count")).toBe(true);
    expect(kinds.has("exceeds-max-patch-bytes")).toBe(true);
    expect(kinds.has("exceeds-max-new-files")).toBe(true);
    expect(kinds.has("no-expected-checks")).toBe(true);
  });

  // ── invalid-patch-entry (C1 fail-closed) ──────────────────────────────────

  it("flags an entry with NaN patchBytes as invalid-patch-entry", () => {
    const proposed = [
      { path: "src/index.ts", newFile: false, patchBytes: Number.NaN },
    ] as unknown as readonly ProposedPatchEntry[];
    const result = checkPatchAgainstScope(happyPatchScope(), proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(findViolation(result.violations, "invalid-patch-entry")).toBeDefined();
  });

  it("flags an entry with Infinity patchBytes as invalid-patch-entry", () => {
    const proposed = [
      { path: "src/index.ts", newFile: false, patchBytes: Number.POSITIVE_INFINITY },
    ] as unknown as readonly ProposedPatchEntry[];
    const result = checkPatchAgainstScope(happyPatchScope(), proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(findViolation(result.violations, "invalid-patch-entry")).toBeDefined();
  });

  it("flags an entry with negative patchBytes as invalid-patch-entry", () => {
    const proposed = [
      { path: "src/index.ts", newFile: false, patchBytes: -1 },
    ] as unknown as readonly ProposedPatchEntry[];
    const result = checkPatchAgainstScope(happyPatchScope(), proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(findViolation(result.violations, "invalid-patch-entry")).toBeDefined();
  });

  it("flags an entry with non-number patchBytes as invalid-patch-entry", () => {
    const proposed = [
      { path: "src/index.ts", newFile: false, patchBytes: "big" as unknown as number },
    ] as unknown as readonly ProposedPatchEntry[];
    const result = checkPatchAgainstScope(happyPatchScope(), proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(findViolation(result.violations, "invalid-patch-entry")).toBeDefined();
  });

  it("flags an entry with non-boolean newFile as invalid-patch-entry", () => {
    const proposed = [
      { path: "src/index.ts", newFile: 1 as unknown as boolean, patchBytes: 10 },
    ] as unknown as readonly ProposedPatchEntry[];
    const result = checkPatchAgainstScope(happyPatchScope(), proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(findViolation(result.violations, "invalid-patch-entry")).toBeDefined();
  });

  it("does not bypass the scope check when one NaN entry is paired with a valid under-limit entry", () => {
    // NaN is dropped from accumulation; valid entry stays. The NaN itself produces
    // invalid-patch-entry, so the result must still be !ok regardless of the limit.
    const scope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["src/index.ts", "src/other.ts"],
      limits: { ...DEFAULT_PATCH_SCOPE_LIMITS, maxPatchBytes: 1_000 },
    };
    const proposed = [
      { path: "src/index.ts", newFile: false, patchBytes: Number.NaN },
      { path: "src/other.ts", newFile: false, patchBytes: 50 },
    ] as unknown as readonly ProposedPatchEntry[];
    const result = checkPatchAgainstScope(scope, proposed);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(findViolation(result.violations, "invalid-patch-entry")).toBeDefined();
  });

  // ── exact-boundary tests (M2 mutation gap) ────────────────────────────────

  it("accepts proposed.length === limits.maxFileCount as ok", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["a", "b"],
      limits: { ...DEFAULT_PATCH_SCOPE_LIMITS, maxFileCount: 2 },
    };
    const proposed: readonly ProposedPatchEntry[] = [
      { path: "a", newFile: false, patchBytes: 1 },
      { path: "b", newFile: false, patchBytes: 1 },
    ];
    expect(checkPatchAgainstScope(scope, proposed)).toEqual({ ok: true });
  });

  it("accepts totalBytes === limits.maxPatchBytes as ok", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["a", "b"],
      limits: { ...DEFAULT_PATCH_SCOPE_LIMITS, maxPatchBytes: 100 },
    };
    const proposed: readonly ProposedPatchEntry[] = [
      { path: "a", newFile: false, patchBytes: 50 },
      { path: "b", newFile: false, patchBytes: 50 },
    ];
    expect(checkPatchAgainstScope(scope, proposed)).toEqual({ ok: true });
  });

  it("accepts newFiles === limits.maxNewFiles as ok", () => {
    const scope: PatchScope = {
      ...happyPatchScope(),
      editablePaths: ["a", "b"],
      limits: { ...DEFAULT_PATCH_SCOPE_LIMITS, maxNewFiles: 2 },
    };
    const proposed: readonly ProposedPatchEntry[] = [
      { path: "a", newFile: true, patchBytes: 10 },
      { path: "b", newFile: true, patchBytes: 10 },
    ];
    expect(checkPatchAgainstScope(scope, proposed)).toEqual({ ok: true });
  });
});

// ─── UserApprovalTokenInput type pin ──────────────────────────────────────────
describe("UserApprovalTokenInput", () => {
  it("can be assigned from the request fields plus expectedChecks", () => {
    const request = happyHandoffRequest();
    const hashable: UserApprovalTokenInput = {
      contextPackStableId: request.contextPackStableId,
      workflowKind: request.workflowKind,
      editablePaths: request.patchScope.editablePaths,
      readOnlyPaths: request.patchScope.readOnlyPaths,
      evidenceAtomIds: request.patchScope.evidenceAtomIds,
      limits: request.patchScope.limits,
      expectedChecks: request.patchScope.expectedChecks,
    };
    expect(hashable.workflowKind).toBe("unit-test-generation");
    expect(hashable.limits.maxFileCount).toBe(DEFAULT_PATCH_SCOPE_LIMITS.maxFileCount);
  });
});
