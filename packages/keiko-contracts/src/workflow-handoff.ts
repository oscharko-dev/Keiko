// Public type contracts for the governed workflow-handoff surface (Epic #177, Issue #186).
// All string content here is already redacted upstream; nothing performs IO, crypto, clock
// reads, or randomness. Pure data + pure validators only. The schemaVersion discriminant
// follows the same evolution rule as CONNECTED_CONTEXT_SCHEMA_VERSION (ADR-0010 D2): a
// breaking change introduces a NEW literal member rather than mutating "1". Leaf-package
// rule (ADR-0019 direction 1) means no `@oscharko-dev/keiko-*` imports may appear in this
// module — including this package's own siblings; intra-package imports use relative paths.

import { isValidScopePath } from "./connected-context.js";

// ─── Schema version ───────────────────────────────────────────────────────────
export const WORKFLOW_HANDOFF_SCHEMA_VERSION = "1" as const;

// ─── Patch-scope limits ───────────────────────────────────────────────────────
// Four independently-budgeted dimensions; conflating any pair lets one dimension hide
// overshoot in another (same posture as the seven-dim exploration budget in #178).
// `checkPatchAgainstScope` enforces the three quantitative dimensions that the contracts
// layer can verify from a proposed patch alone (maxFileCount, maxPatchBytes, maxNewFiles).
// `elapsedMsMax` is the elapsed-time ceiling the caller polices against its own clock and
// surfaces through its workflow-run violation channel — the contracts package is a leaf
// (ADR-0019 direction 1) and intentionally performs no clock reads.
export interface PatchScopeLimits {
  readonly maxFileCount: number;
  readonly maxPatchBytes: number;
  readonly maxNewFiles: number;
  readonly elapsedMsMax: number;
}

export const DEFAULT_PATCH_SCOPE_LIMITS: PatchScopeLimits = {
  maxFileCount: 16,
  maxPatchBytes: 65_536,
  maxNewFiles: 4,
  elapsedMsMax: 60_000,
} as const;

// ─── Expected checks ──────────────────────────────────────────────────────────
export type ExpectedCheck = "verify" | "lint" | "typecheck" | "tests" | "manual";

export const EXPECTED_CHECKS: readonly ExpectedCheck[] = [
  "verify",
  "lint",
  "typecheck",
  "tests",
  "manual",
] as const;

// ─── Patch scope ──────────────────────────────────────────────────────────────
export interface PatchScope {
  readonly schemaVersion: typeof WORKFLOW_HANDOFF_SCHEMA_VERSION;
  readonly editablePaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
  readonly evidenceAtomIds: readonly string[];
  readonly limits: PatchScopeLimits;
  readonly expectedChecks: readonly ExpectedCheck[];
  readonly unknowns: readonly string[];
}

// ─── Workflow kind ────────────────────────────────────────────────────────────
// NOTE: this enumeration is distinct from the `WorkflowKind` exposed by `evaluations.ts`
// (which uses the values "unit-tests" | "bug-investigation" for evaluation fixtures). To
// avoid a barrel collision, this type is reachable only via the `./workflow-handoff`
// subpath export; the package index intentionally does NOT re-export it.
export type WorkflowKind = "unit-test-generation" | "bug-investigation" | "verification";

export const WORKFLOW_KINDS: readonly WorkflowKind[] = [
  "unit-test-generation",
  "bug-investigation",
  "verification",
] as const;

// ─── Handoff request envelope ─────────────────────────────────────────────────
export interface WorkflowHandoffRequest {
  readonly schemaVersion: typeof WORKFLOW_HANDOFF_SCHEMA_VERSION;
  readonly contextPackStableId: string;
  readonly workflowKind: WorkflowKind;
  readonly patchScope: PatchScope;
  readonly requestedAtMs: number;
  // Caller-computed deterministic token (SHA-256 of the canonical request seed) that the
  // workflow agent must echo back when accepting the handoff. The contracts layer does NOT
  // compute the token; downstream packages call createHash inside their hashing helper.
  readonly userApprovalToken: string;
}

// ─── Hashing input DTO (no crypto here; sibling impl hashes this) ─────────────
// Producers MUST sort the four string-array fields lexically ascending and order
// expectedChecks by EXPECTED_CHECKS index before serializing the seed. The contracts layer
// names the shape so the hash producer in #187+ has a single source of truth.
export interface UserApprovalTokenInput {
  readonly contextPackStableId: string;
  readonly workflowKind: WorkflowKind;
  readonly editablePaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
  readonly evidenceAtomIds: readonly string[];
  readonly limits: PatchScopeLimits;
  readonly expectedChecks: readonly ExpectedCheck[];
  readonly unknowns: readonly string[];
}

// ─── Patch-scope violation ────────────────────────────────────────────────────
export type PatchScopeViolationKind =
  | "outside-editable-set"
  | "exceeds-max-file-count"
  | "exceeds-max-patch-bytes"
  | "exceeds-max-new-files"
  | "no-expected-checks"
  | "invalid-patch-scope"
  | "invalid-patch-entry";

export interface PatchScopeViolation {
  readonly kind: PatchScopeViolationKind;
  readonly path: string | undefined;
  readonly observed: number | undefined;
  readonly limit: number | undefined;
  readonly message: string;
}

export type PatchScopeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly PatchScopeViolation[] };

export interface ProposedPatchEntry {
  readonly path: string;
  readonly newFile: boolean;
  readonly patchBytes: number;
}

// ─── Validation result ────────────────────────────────────────────────────────
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

// ─── Internal helpers ─────────────────────────────────────────────────────────
const APPROVAL_TOKEN_RE = /^[0-9a-f]{64}$/;
const CONTEXT_PACK_ID_RE = /^(pl-[0-9a-f]{16}|p-[0-9a-f]{64})$/;

// The schema discriminant comparisons below are statically true at the type level (the
// constant equals the literal field type), so we widen to `string` before comparing. This
// keeps the validator honest against runtime inputs that bypass the type system — e.g.,
// objects materialized from JSON.parse or cross-version manifests. Same posture as
// connected-context.ts schemaMismatch.
function schemaMismatch(actual: unknown, expected: string): boolean {
  return actual !== expected;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyTrimmed(value: string): boolean {
  return value.trim().length > 0;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function hasIntersection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const set = new Set(a);
  for (const value of b) {
    if (set.has(value)) {
      return true;
    }
  }
  return false;
}

function pushIf(reasons: string[], condition: boolean, reason: string): void {
  if (condition) {
    reasons.push(reason);
  }
}

function buildResult(reasons: readonly string[]): ValidationResult {
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readArrayField(
  source: Record<string, unknown>,
  field: keyof PatchScope,
  reasons: string[],
): readonly unknown[] | undefined {
  const value = source[field];
  if (!Array.isArray(value)) {
    reasons.push(`patchScope.${field} must be an array`);
    return undefined;
  }
  return value as readonly unknown[];
}

function isExpectedCheck(value: unknown): value is ExpectedCheck {
  return typeof value === "string" && (EXPECTED_CHECKS as readonly string[]).includes(value);
}

function isWorkflowKind(value: unknown): value is WorkflowKind {
  return typeof value === "string" && (WORKFLOW_KINDS as readonly string[]).includes(value);
}

// ─── Approval-token shape ─────────────────────────────────────────────────────
export function isApprovalTokenShape(token: string): boolean {
  return APPROVAL_TOKEN_RE.test(token);
}

// ─── PatchScope validation ────────────────────────────────────────────────────
function validateScopePathArray(
  values: readonly unknown[],
  field: "editablePaths" | "readOnlyPaths",
  reasons: string[],
): readonly string[] | undefined {
  const parsed: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !isNonEmptyTrimmed(value)) {
      reasons.push(`patchScope.${field} contains empty entry`);
      return undefined;
    }
    if (!isValidScopePath(value, { mustBeRelative: true })) {
      reasons.push(`patchScope.${field} contains invalid path`);
      return undefined;
    }
    parsed.push(value);
  }
  return parsed;
}

function validatePatchScopeLimits(limits: unknown, reasons: string[]): void {
  if (!isRecord(limits)) {
    reasons.push("patchScope.limits must be an object");
    return;
  }
  pushIf(
    reasons,
    !isFiniteNonNegativeInteger(limits.maxFileCount),
    "patchScope.limits.maxFileCount invalid",
  );
  pushIf(
    reasons,
    !isFiniteNonNegativeInteger(limits.maxPatchBytes),
    "patchScope.limits.maxPatchBytes invalid",
  );
  pushIf(
    reasons,
    !isFiniteNonNegativeInteger(limits.maxNewFiles),
    "patchScope.limits.maxNewFiles invalid",
  );
  pushIf(
    reasons,
    !isFiniteNonNegativeInteger(limits.elapsedMsMax),
    "patchScope.limits.elapsedMsMax invalid",
  );
}

function validateExpectedChecks(checks: readonly unknown[], reasons: string[]): void {
  if (checks.length === 0) {
    reasons.push("patchScope.expectedChecks empty");
    return;
  }
  for (const check of checks) {
    if (!isExpectedCheck(check)) {
      reasons.push("patchScope.expectedChecks contains invalid value");
      return;
    }
  }
}

function validateEvidenceAtomIds(
  ids: readonly unknown[],
  reasons: string[],
): readonly string[] | undefined {
  if (ids.length === 0) {
    reasons.push("patchScope.evidenceAtomIds empty");
    return undefined;
  }
  const parsed: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !isNonEmptyTrimmed(id)) {
      reasons.push("patchScope.evidenceAtomIds contains empty entry");
      return undefined;
    }
    parsed.push(id);
  }
  if (hasDuplicates(parsed)) {
    reasons.push("patchScope.evidenceAtomIds contains duplicates");
  }
  return parsed;
}

function validateUnknowns(unknowns: readonly unknown[], reasons: string[]): void {
  for (const entry of unknowns) {
    if (typeof entry !== "string") {
      reasons.push("patchScope.unknowns contains non-string entry");
      return;
    }
    if (!isNonEmptyTrimmed(entry)) {
      reasons.push("patchScope.unknowns contains empty entry");
      return;
    }
  }
}

interface PatchScopeArrays {
  readonly editablePaths: readonly unknown[] | undefined;
  readonly readOnlyPaths: readonly unknown[] | undefined;
  readonly evidenceAtomIds: readonly unknown[] | undefined;
  readonly expectedChecks: readonly unknown[] | undefined;
  readonly unknowns: readonly unknown[] | undefined;
}

function readPatchScopeArrays(scope: Record<string, unknown>, reasons: string[]): PatchScopeArrays {
  return {
    editablePaths: readArrayField(scope, "editablePaths", reasons),
    readOnlyPaths: readArrayField(scope, "readOnlyPaths", reasons),
    evidenceAtomIds: readArrayField(scope, "evidenceAtomIds", reasons),
    expectedChecks: readArrayField(scope, "expectedChecks", reasons),
    unknowns: readArrayField(scope, "unknowns", reasons),
  };
}

function validatePatchScopePaths(arrays: PatchScopeArrays, reasons: string[]): void {
  const editablePaths = arrays.editablePaths
    ? validateScopePathArray(arrays.editablePaths, "editablePaths", reasons)
    : undefined;
  const readOnlyPaths = arrays.readOnlyPaths
    ? validateScopePathArray(arrays.readOnlyPaths, "readOnlyPaths", reasons)
    : undefined;
  if (editablePaths) {
    pushIf(reasons, hasDuplicates(editablePaths), "patchScope.editablePaths contains duplicates");
  }
  if (readOnlyPaths) {
    pushIf(reasons, hasDuplicates(readOnlyPaths), "patchScope.readOnlyPaths contains duplicates");
  }
  if (editablePaths && readOnlyPaths) {
    pushIf(
      reasons,
      hasIntersection(editablePaths, readOnlyPaths),
      "patchScope.editablePaths overlaps readOnlyPaths",
    );
  }
}

function validatePatchScopeArrays(arrays: PatchScopeArrays, reasons: string[]): void {
  validatePatchScopePaths(arrays, reasons);
  if (arrays.evidenceAtomIds) {
    validateEvidenceAtomIds(arrays.evidenceAtomIds, reasons);
  }
  if (arrays.expectedChecks) {
    validateExpectedChecks(arrays.expectedChecks, reasons);
  }
  if (arrays.unknowns) {
    validateUnknowns(arrays.unknowns, reasons);
  }
}

export function validatePatchScope(scope: unknown): ValidationResult {
  const reasons: string[] = [];
  if (!isRecord(scope)) {
    return { ok: false, reasons: ["patchScope must be an object"] };
  }
  pushIf(
    reasons,
    schemaMismatch(scope.schemaVersion, WORKFLOW_HANDOFF_SCHEMA_VERSION),
    "patchScope.schemaVersion mismatch",
  );
  validatePatchScopeArrays(readPatchScopeArrays(scope, reasons), reasons);
  validatePatchScopeLimits(scope.limits, reasons);
  return buildResult(reasons);
}

// ─── WorkflowHandoffRequest validation ────────────────────────────────────────
export function validateWorkflowHandoffRequest(request: unknown): ValidationResult {
  const reasons: string[] = [];
  if (!isRecord(request)) {
    return { ok: false, reasons: ["request must be an object"] };
  }
  pushIf(
    reasons,
    schemaMismatch(request.schemaVersion, WORKFLOW_HANDOFF_SCHEMA_VERSION),
    "request.schemaVersion mismatch",
  );
  if (
    typeof request.contextPackStableId !== "string" ||
    !isNonEmptyTrimmed(request.contextPackStableId)
  ) {
    reasons.push("request.contextPackStableId empty");
  } else if (!CONTEXT_PACK_ID_RE.test(request.contextPackStableId)) {
    reasons.push("request.contextPackStableId malformed");
  }
  pushIf(reasons, !isWorkflowKind(request.workflowKind), "request.workflowKind invalid");
  pushIf(
    reasons,
    !isFiniteNonNegativeInteger(request.requestedAtMs),
    "request.requestedAtMs invalid",
  );
  pushIf(
    reasons,
    typeof request.userApprovalToken !== "string" ||
      !isApprovalTokenShape(request.userApprovalToken),
    "request.userApprovalToken malformed",
  );
  const scopeResult = validatePatchScope(request.patchScope);
  if (!scopeResult.ok) {
    for (const reason of scopeResult.reasons) {
      reasons.push(`request.${reason}`);
    }
  }
  return buildResult(reasons);
}

// ─── checkPatchAgainstScope ───────────────────────────────────────────────────
function violationOutsideSet(path: string): PatchScopeViolation {
  return {
    kind: "outside-editable-set",
    path,
    observed: undefined,
    limit: undefined,
    message: `path "${path}" is not in patchScope.editablePaths`,
  };
}

function violationBound(
  kind: Exclude<
    PatchScopeViolationKind,
    "outside-editable-set" | "no-expected-checks" | "invalid-patch-scope" | "invalid-patch-entry"
  >,
  observed: number,
  limit: number,
  field: string,
): PatchScopeViolation {
  return {
    kind,
    path: undefined,
    observed,
    limit,
    message: `${field}: observed ${observed.toString()} exceeds limit ${limit.toString()}`,
  };
}

function violationNoChecks(): PatchScopeViolation {
  return {
    kind: "no-expected-checks",
    path: undefined,
    observed: undefined,
    limit: undefined,
    message: "patchScope.expectedChecks is empty",
  };
}

function violationInvalidScope(reason: string): PatchScopeViolation {
  return {
    kind: "invalid-patch-scope",
    path: undefined,
    observed: undefined,
    limit: undefined,
    message: `patchScope invalid: ${reason}`,
  };
}

function violationInvalidEntry(path: string | undefined, reason: string): PatchScopeViolation {
  return {
    kind: "invalid-patch-entry",
    path,
    observed: undefined,
    limit: undefined,
    message:
      path === undefined ? `patch entry invalid: ${reason}` : `path "${path}" invalid: ${reason}`,
  };
}

function readProposedPath(
  entry: Record<string, unknown>,
  violations: PatchScopeViolation[],
): string | undefined {
  const path = typeof entry.path === "string" ? entry.path : undefined;
  const valid =
    path !== undefined &&
    isNonEmptyTrimmed(path) &&
    isValidScopePath(path, { mustBeRelative: true });
  if (!valid) {
    violations.push(violationInvalidEntry(path, "path must be a valid relative scope path"));
    return undefined;
  }
  return path;
}

function readProposedPatchBytes(
  entry: Record<string, unknown>,
  path: string | undefined,
  violations: PatchScopeViolation[],
): number | undefined {
  const patchBytes = entry.patchBytes;
  if (typeof patchBytes !== "number" || !Number.isFinite(patchBytes) || patchBytes < 0) {
    violations.push(violationInvalidEntry(path, "patchBytes must be a finite non-negative number"));
    return undefined;
  }
  return patchBytes;
}

function readProposedNewFile(
  entry: Record<string, unknown>,
  path: string | undefined,
  violations: PatchScopeViolation[],
): boolean | undefined {
  const newFile = entry.newFile;
  if (typeof newFile !== "boolean") {
    violations.push(violationInvalidEntry(path, "newFile must be a boolean"));
    return undefined;
  }
  return newFile;
}

function normalizeProposedEntry(
  entry: unknown,
  violations: PatchScopeViolation[],
): ProposedPatchEntry | undefined {
  if (!isRecord(entry)) {
    violations.push(violationInvalidEntry(undefined, "entry must be an object"));
    return undefined;
  }
  const path = readProposedPath(entry, violations);
  const patchBytes = readProposedPatchBytes(entry, path, violations);
  const newFile = readProposedNewFile(entry, path, violations);
  if (path === undefined || patchBytes === undefined || newFile === undefined) {
    return undefined;
  }
  return { path, patchBytes, newFile };
}

function collectProposedEntries(
  proposed: readonly unknown[],
  violations: PatchScopeViolation[],
): readonly ProposedPatchEntry[] {
  const valid: ProposedPatchEntry[] = [];
  for (const entry of proposed) {
    const normalized = normalizeProposedEntry(entry, violations);
    if (normalized) {
      valid.push(normalized);
    }
  }
  return valid;
}

function collectOutsideSet(
  scope: PatchScope,
  proposed: readonly ProposedPatchEntry[],
  violations: PatchScopeViolation[],
): void {
  const editable = new Set(scope.editablePaths);
  for (const entry of proposed) {
    if (!editable.has(entry.path)) {
      violations.push(violationOutsideSet(entry.path));
    }
  }
}

function collectAggregateBounds(
  scope: PatchScope,
  proposed: readonly ProposedPatchEntry[],
  violations: PatchScopeViolation[],
): void {
  if (proposed.length > scope.limits.maxFileCount) {
    violations.push(
      violationBound(
        "exceeds-max-file-count",
        proposed.length,
        scope.limits.maxFileCount,
        "fileCount",
      ),
    );
  }
  let totalBytes = 0;
  let newFiles = 0;
  for (const entry of proposed) {
    totalBytes += entry.patchBytes;
    if (entry.newFile) {
      newFiles += 1;
    }
  }
  if (totalBytes > scope.limits.maxPatchBytes) {
    violations.push(
      violationBound(
        "exceeds-max-patch-bytes",
        totalBytes,
        scope.limits.maxPatchBytes,
        "patchBytes",
      ),
    );
  }
  if (newFiles > scope.limits.maxNewFiles) {
    violations.push(
      violationBound("exceeds-max-new-files", newFiles, scope.limits.maxNewFiles, "newFiles"),
    );
  }
}

export function checkPatchAgainstScope(
  scope: PatchScope,
  proposed: readonly ProposedPatchEntry[],
): PatchScopeCheck {
  const violations: PatchScopeViolation[] = [];
  const scopeResult = validatePatchScope(scope);
  let hasBlockingScopeViolation = false;
  if (!scopeResult.ok) {
    for (const reason of scopeResult.reasons) {
      if (reason === "patchScope.expectedChecks empty") {
        violations.push(violationNoChecks());
      } else {
        hasBlockingScopeViolation = true;
        violations.push(violationInvalidScope(reason));
      }
    }
  }
  if (hasBlockingScopeViolation) {
    return { ok: false, violations };
  }
  if (!Array.isArray(proposed)) {
    violations.push(violationInvalidEntry(undefined, "proposed patch list must be an array"));
    return { ok: false, violations };
  }
  const validProposed = collectProposedEntries(proposed, violations);
  collectOutsideSet(scope, validProposed, violations);
  collectAggregateBounds(scope, validProposed, violations);
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
