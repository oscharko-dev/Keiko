// Editor-driven test-generation WIRE contract (Issue #1202, Epic #1189, ADR-0042 D7).
// These are the request/response shapes the `POST /api/editor/test-generation` BFF route consumes and
// emits. The route is the governed seam between the browser-tier `@oscharko-dev/keiko-editor`
// "Generate Tests" action (which renders a reviewable diff only) and the server-owned, gated
// unit-test-generation workflow (`@oscharko-dev/keiko-workflows`) enriched with governed coding
// context (#1211, `purpose: "test-generation"`).
//
// Wave-2 surface, shipped switched off (ADR-0042 D7). Editor-driven test generation, execution, and
// verification execute untrusted, model-generated code through an assured pre-filter and are therefore
// deferred behind a default-off feature flag that may be enabled only once a deny-by-default network
// egress boundary is enforced and proven by an automated test (`tools.ts` `network: "inherit"`;
// `limits.ts` `enforced: false`; "Keiko is not a sandbox"). The route therefore exposes two gates:
//   - `disabled` — the feature flag is off (the v1 default). No retrieval, no model, no execution.
//   - `deferred` — the feature is enabled but the assured-execution (egress) boundary is not enforced,
//     so no model-generated code is produced or executed; governed discovery still runs for provenance.
//   - `generated` — a reviewable candidate patch was produced (reachable only once the egress boundary
//     is enforced); in v1 every funnel gate is `not-run` and a candidate can only ever be `unverified`.
//   - `failed` — a content-free, actionable failure; the editor stays usable.
//
// Content boundary: the REQUEST carries the in-editor buffer text (the document overlay) — the user's
// own buffer travelling over the loopback BFF, exactly like the language-service (#1198) and completion
// (#1199) requests; it is never logged. The RESPONSE is content-free apart from the reviewable patch
// edits (`newText`), which are the candidate test code the user explicitly reviews and applies into
// their own workspace: no raw prompt, no raw model reasoning, no retrieved excerpt, no secret. Status,
// reason, funnel, assurance, provenance, and the coding-context citations are counts, hashes, enum
// literals, and content-free pointers only (EU AI Act Reg. (EU) 2024/1689 Art. 12 record-keeping).
//
// Leaf-package rules (ADR-0019): pure types and frozen const tables plus throw-free validators only.
// No filesystem, no clock, no crypto, no randomness, and no imports of other `@oscharko-dev/keiko-*`
// packages. Geometry, the document-overlay shape, and the coding-context selectors/citations are reused
// from the sibling editor contracts so the test-generation tier shares one stable provenance model with
// the completion and inline-completion gateways.

import {
  isLanguageDocumentOverlay,
  isLanguagePosition,
  type LanguageDocumentOverlay,
  type LanguageRange,
} from "./language-service.js";
import type { EditorCompletionContextSelectors } from "./editor-completion.js";
import type { CodingContextWirePack } from "./coding-context.js";

// Schema version for the test-generation envelope. Bump as a new string member when the shape changes
// incompatibly; consumers pin against the literal to detect skew.
export const EDITOR_TEST_GENERATION_SCHEMA_VERSION = "1" as const;

// The minimum number of stable executions a generated test must survive in the assured pre-filter
// before it may be surfaced as apply-ready (Review Addendum — Meta "Automated Unit Test Improvement",
// FSE 2024). Reported in the funnel so a consumer can audit the wave-2 enablement target even while the
// pre-filter is `not-run`.
export const EDITOR_TEST_GENERATION_STABILITY_RUNS = 5 as const;

// ─── Target ────────────────────────────────────────────────────────────────────────────────────────
// The five governed test-generation target modes, mirroring the browser-side EditorTestGenerationContext
// owned by @oscharko-dev/keiko-editor (this package never imports the editor package — wrong tier).
export type EditorTestGenerationTargetKind =
  | "file"
  | "selection"
  | "symbol"
  | "changed-file-set"
  | "frontend-component";

export const EDITOR_TEST_GENERATION_TARGET_KINDS: readonly EditorTestGenerationTargetKind[] = [
  "file",
  "selection",
  "symbol",
  "changed-file-set",
  "frontend-component",
] as const;

// A content-free symbol reference: an identifier and its coordinate span, never the symbol's body text.
export interface EditorTestGenerationWireSymbol {
  readonly name: string;
  readonly container?: string;
  readonly range: LanguageRange;
}

// Discriminated wire target. Each variant carries the document overlay(s) — the user's reviewable
// buffer, exactly like the completion/inline requests — plus the content-free coordinates that scope
// generation (a selection range, a symbol reference, or a component name).
export type EditorTestGenerationWireTarget =
  | { readonly kind: "file"; readonly document: LanguageDocumentOverlay }
  | {
      readonly kind: "selection";
      readonly document: LanguageDocumentOverlay;
      readonly range: LanguageRange;
    }
  | {
      readonly kind: "symbol";
      readonly document: LanguageDocumentOverlay;
      readonly symbol: EditorTestGenerationWireSymbol;
    }
  | { readonly kind: "changed-file-set"; readonly documents: readonly LanguageDocumentOverlay[] }
  | {
      readonly kind: "frontend-component";
      readonly document: LanguageDocumentOverlay;
      readonly componentName: string;
      readonly range?: LanguageRange;
    };

export interface EditorTestGenerationWireRequest {
  readonly schemaVersion: typeof EDITOR_TEST_GENERATION_SCHEMA_VERSION;
  readonly root: string;
  readonly target: EditorTestGenerationWireTarget;
  // Advisory budget (bytes) the host suggests for assembled coding context; the route clamps it to the
  // server-owned `test-generation` purpose budget. A non-negative integer.
  readonly contextBudgetBytes: number;
  // Optional coding-context selectors forwarded to the governed retrieval service (#1211); reused
  // verbatim from the completion gateway. For the `test-generation` purpose embedding-cost providers
  // (Local Knowledge, memory) are eligible when a capsule/connector is selected and policy-allowed.
  readonly context?: EditorCompletionContextSelectors;
}

// ─── Outcome ───────────────────────────────────────────────────────────────────────────────────────
export type EditorTestGenerationStatus = "disabled" | "deferred" | "generated" | "failed";

export const EDITOR_TEST_GENERATION_STATUSES: readonly EditorTestGenerationStatus[] = [
  "disabled",
  "deferred",
  "generated",
  "failed",
] as const;

// The assurance level of a surfaced candidate. v1 only ever produces `unverified` candidates (the
// assured pre-filter is `not-run`); `assured` is reachable only in wave 2 once the assured pre-filter
// executes behind the enforced egress boundary (ADR-0042 D7).
export type EditorTestGenerationAssurance = "unverified" | "assured";

export const EDITOR_TEST_GENERATION_ASSURANCES: readonly EditorTestGenerationAssurance[] = [
  "unverified",
  "assured",
] as const;

// One gate of the assured pre-filter funnel.
export type EditorTestGenerationGateState = "passed" | "failed" | "not-run";

export const EDITOR_TEST_GENERATION_GATE_STATES: readonly EditorTestGenerationGateState[] = [
  "passed",
  "failed",
  "not-run",
] as const;

// The assured pre-filter funnel (Review Addenda): a candidate must build → pass → be stable across
// `stabilityRunsRequired` (>= 5) executions → increase coverage → kill injected mutants (oracle
// strength) and carry a meaningful assertion (anti-tautology) before it is surfaced as apply-ready.
// Content-free counts plus per-gate state. In v1 `executionEnabled` is false and every gate is
// `not-run`, because the pre-filter EXECUTES untrusted model-generated code, which is deferred behind
// the enforced egress boundary; the funnel is reported so the wave-2 enablement target is auditable.
export interface EditorTestGenerationFunnel {
  readonly executionEnabled: boolean;
  readonly candidatesGenerated: number;
  readonly candidatesSurfaced: number;
  readonly stabilityRunsRequired: number;
  readonly build: EditorTestGenerationGateState;
  readonly pass: EditorTestGenerationGateState;
  readonly stability: EditorTestGenerationGateState;
  readonly coverage: EditorTestGenerationGateState;
  readonly mutation: EditorTestGenerationGateState;
  readonly antiTautology: EditorTestGenerationGateState;
  // Content-free oracle/coverage evidence, populated only when the assured pre-filter actually
  // executes (wave 2, behind the enforced egress boundary). Counts/deltas only — never test source.
  // The coverage deltas are the strict increase in covered lines/branches for the target vs the
  // pre-patch baseline; the mutation counts are killed/total injected mutants (oracle strength).
  readonly coverageLineDelta?: number | undefined;
  readonly coverageBranchDelta?: number | undefined;
  readonly mutantsKilled?: number | undefined;
  readonly mutantsTotal?: number | undefined;
}

// One reviewable change in a candidate patch. `newText` is content-bearing reviewable code (the
// candidate test the user explicitly applies), exactly like completion `insertText`.
export type EditorTestGenerationWireChangeKind = "added" | "modified" | "deleted";

export interface EditorTestGenerationWireEdit {
  readonly range: LanguageRange;
  readonly newText: string;
}

export interface EditorTestGenerationWireFileChange {
  readonly path: string;
  readonly changeKind: EditorTestGenerationWireChangeKind;
  readonly edits: readonly EditorTestGenerationWireEdit[];
}

export interface EditorTestGenerationWirePatch {
  readonly patchId: string;
  readonly files: readonly EditorTestGenerationWireFileChange[];
}

// Content-free model-output provenance for a generated candidate (mirrors EditorModelProvenance).
export interface EditorTestGenerationWireProvenance {
  readonly modelId: string;
  readonly gatewayPolicyVersion: string;
  readonly promptHash: string;
  readonly producedAt: number;
}

export interface EditorTestGenerationWireResponse {
  readonly schemaVersion: typeof EDITOR_TEST_GENERATION_SCHEMA_VERSION;
  readonly status: EditorTestGenerationStatus;
  // A stable, content-free, human-readable explanation. Present for disabled/deferred/failed.
  readonly reason?: string;
  // The assurance level of a surfaced candidate; present only when `status === "generated"`.
  readonly assurance?: EditorTestGenerationAssurance;
  // The assured pre-filter funnel, always reported (Review Addenda: "the funnel is reported in the run
  // status"). In v1 every gate is `not-run`.
  readonly funnel: EditorTestGenerationFunnel;
  // Content-free coding-context citations governed discovery assembled (#1211); present once the
  // feature is enabled (`deferred`/`generated`). Never excerpt text.
  readonly context?: CodingContextWirePack;
  // The reviewable candidate patch — present only when `status === "generated"` (wave 2).
  readonly patch?: EditorTestGenerationWirePatch;
  readonly provenance?: EditorTestGenerationWireProvenance;
  // The candidate's reviewable unified diff (Issue #1204), present only when `status === "generated"`.
  // This is the SAME reviewable code as the patch `newText`, in unified-diff form: it is the opaque
  // payload the editor round-trips to `POST /api/editor/patch-apply` when the user applies the candidate
  // (ADR-0042 D2: the browser never parses it; the server re-validates and applies it). No new content
  // class is exposed — a create diff is the candidate test, a modify diff's context is the user's own
  // open buffer.
  readonly applyableDiff?: string;
}

// Builds the v1 funnel: no execution, every gate `not-run`, no candidates. The single authority for the
// "switched-off" funnel so the route and its tests cannot drift.
export function notRunTestGenerationFunnel(): EditorTestGenerationFunnel {
  return {
    executionEnabled: false,
    candidatesGenerated: 0,
    candidatesSurfaced: 0,
    stabilityRunsRequired: EDITOR_TEST_GENERATION_STABILITY_RUNS,
    build: "not-run",
    pass: "not-run",
    stability: "not-run",
    coverage: "not-run",
    mutation: "not-run",
    antiTautology: "not-run",
  };
}

// ─── Pure validation (trust-boundary edge: the BFF validates a client-supplied request) ─────────────
// Result envelope follows the package convention: a discriminated `{ ok: true; value } | { ok: false;
// errors }` so branches stay throw-free and the error strings are deterministic.

export interface EditorTestGenerationParseOk {
  readonly ok: true;
  readonly value: EditorTestGenerationWireRequest;
}
export interface EditorTestGenerationParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type EditorTestGenerationParse = EditorTestGenerationParseOk | EditorTestGenerationParseFail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// A LanguageRange is `{ start, end }` of two LanguagePositions. Defined locally because the
// language-service module exposes only the position guard; this keeps the test-generation contract a
// leaf with no new shared dependency.
function isWireRange(value: unknown): value is LanguageRange {
  return isRecord(value) && isLanguagePosition(value.start) && isLanguagePosition(value.end);
}

function isWireSymbol(value: unknown): value is EditorTestGenerationWireSymbol {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    (value.container === undefined || typeof value.container === "string") &&
    isWireRange(value.range)
  );
}

function isOverlayArray(value: unknown): value is readonly LanguageDocumentOverlay[] {
  return Array.isArray(value) && value.length > 0 && value.every(isLanguageDocumentOverlay);
}

// Collects the optional, content-bearing context selectors (identical invariants to the completion
// gateway). Unknown-typed fields are rejected so a malformed selector cannot silently widen retrieval;
// an absent `context` is valid.
function collectContextErrors(context: unknown, errors: string[]): void {
  if (context === undefined) {
    return;
  }
  if (!isRecord(context)) {
    errors.push("context must be an object when provided");
    return;
  }
  for (const field of ["queryText", "symbol", "capsuleId", "capsuleSetId"] as const) {
    if (context[field] !== undefined && typeof context[field] !== "string") {
      errors.push(`context.${field} must be a string when provided`);
    }
  }
  if (context.changedFiles !== undefined && !isStringArray(context.changedFiles)) {
    errors.push("context.changedFiles must be an array of strings when provided");
  }
  if (context.capsuleId !== undefined && context.capsuleSetId !== undefined) {
    errors.push("context must not set both capsuleId and capsuleSetId");
  }
}

// Collects the shape errors for a single-document target (file/selection/symbol/frontend-component).
function collectScopedTargetErrors(
  kind: string,
  target: Record<string, unknown>,
  errors: string[],
): void {
  if (!isLanguageDocumentOverlay(target.document)) {
    errors.push("target.document must be { path, languageId, text }");
  }
  if (kind === "selection" && !isWireRange(target.range)) {
    errors.push("target.range must be { start, end } for a selection target");
  }
  if (kind === "symbol" && !isWireSymbol(target.symbol)) {
    errors.push("target.symbol must be { name, range } for a symbol target");
  }
  if (kind === "frontend-component" && !isNonEmptyString(target.componentName)) {
    errors.push("target.componentName must be a non-empty string for a frontend-component target");
  }
}

// Collects the target-shape errors for one wire target, dispatching on `kind`.
function collectTargetErrors(target: unknown, errors: string[]): void {
  if (!isRecord(target)) {
    errors.push("target must be an object");
    return;
  }
  const kind = target.kind;
  if (
    typeof kind !== "string" ||
    !(EDITOR_TEST_GENERATION_TARGET_KINDS as readonly string[]).includes(kind)
  ) {
    errors.push(`target.kind must be one of: ${EDITOR_TEST_GENERATION_TARGET_KINDS.join(", ")}`);
    return;
  }
  if (kind === "changed-file-set") {
    if (!isOverlayArray(target.documents)) {
      errors.push("target.documents must be a non-empty array of { path, languageId, text }");
    }
    return;
  }
  collectScopedTargetErrors(kind, target, errors);
}

function collectRequestErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== EDITOR_TEST_GENERATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${EDITOR_TEST_GENERATION_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.root)) {
    errors.push("root must be a non-empty string");
  }
  collectTargetErrors(value.target, errors);
  if (!isNonNegativeInteger(value.contextBudgetBytes)) {
    errors.push("contextBudgetBytes must be a non-negative integer");
  }
  collectContextErrors(value.context, errors);
  return errors;
}

function buildContextSelectors(context: Record<string, unknown>): EditorCompletionContextSelectors {
  return {
    ...(typeof context.queryText === "string" ? { queryText: context.queryText } : {}),
    ...(typeof context.symbol === "string" ? { symbol: context.symbol } : {}),
    ...(isStringArray(context.changedFiles) ? { changedFiles: context.changedFiles } : {}),
    ...(typeof context.capsuleId === "string" ? { capsuleId: context.capsuleId } : {}),
    ...(typeof context.capsuleSetId === "string" ? { capsuleSetId: context.capsuleSetId } : {}),
  };
}

// Validates an `unknown` payload into an EditorTestGenerationWireRequest, reporting one error per failed
// invariant. The BFF uses this to reject a malformed request with 400 INVALID_REQUEST. The narrowed
// `target` is taken verbatim after validation so the discriminated variants stay intact.
export function parseEditorTestGenerationRequest(value: unknown): EditorTestGenerationParse {
  if (!isRecord(value)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors = collectRequestErrors(value);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const context = isRecord(value.context) ? buildContextSelectors(value.context) : undefined;
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_TEST_GENERATION_SCHEMA_VERSION,
      root: value.root as string,
      target: value.target as EditorTestGenerationWireTarget,
      contextBudgetBytes: value.contextBudgetBytes as number,
      ...(context !== undefined && Object.keys(context).length > 0 ? { context } : {}),
    },
  };
}
