// Public type contracts for the connected repository context surface (Epic #177, Issue #178).
// All string content carried by these types is already redacted upstream (keiko-security policy);
// nothing here performs redaction, IO, hashing, clock reads, or randomness. Pure data + pure
// validators only. The schemaVersion discriminant follows the same evolution rule as
// EVIDENCE_SCHEMA_VERSION (ADR-0010 D2): a breaking change introduces a NEW literal member
// rather than mutating "1". Leaf-package rule (ADR-0019 direction 1) means no
// `@oscharko-dev/keiko-*` imports may appear in this module.

// ─── Schema version ───────────────────────────────────────────────────────────
export const CONNECTED_CONTEXT_SCHEMA_VERSION = "1" as const;

// ─── Selected scope ───────────────────────────────────────────────────────────
export type SelectedScopeKind = "workspace-root" | "directory" | "files";

export const SELECTED_SCOPE_KINDS: readonly SelectedScopeKind[] = [
  "workspace-root",
  "directory",
  "files",
] as const;

export interface SelectedScope {
  readonly schemaVersion: typeof CONNECTED_CONTEXT_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly workspaceRoot: string;
  readonly kind: SelectedScopeKind;
  // Empty for `workspace-root`; exactly one entry for `directory`; one or more for `files`.
  readonly relativePaths: readonly string[];
  readonly conversationId: string | undefined;
  readonly connectedAtMs: number;
}

// ─── Evidence ledger reference ────────────────────────────────────────────────
export interface EvidenceLedgerRef {
  // Pinned to the keiko-evidence manifest schema discriminant ("1"); kept as a string literal
  // rather than a re-export to preserve the leaf-package invariant.
  readonly evidenceSchemaVersion: "1";
  readonly runId: string;
  readonly atomId: string | undefined;
}

// ─── Evidence atom ────────────────────────────────────────────────────────────
export type EvidenceAtomProvenanceKind =
  | "lexical-search"
  | "file-listing"
  | "excerpt-read"
  | "structural"
  | "git-history"
  | "model-rerank";

export const EVIDENCE_ATOM_PROVENANCE_KINDS: readonly EvidenceAtomProvenanceKind[] = [
  "lexical-search",
  "file-listing",
  "excerpt-read",
  "structural",
  "git-history",
  "model-rerank",
] as const;

export interface EvidenceAtomProvenance {
  readonly kind: EvidenceAtomProvenanceKind;
  readonly tool: string;
  readonly queryFingerprint: string;
}

// `raw-internal` may never reach a browser or persisted artifact; downstream trust boundaries
// must refuse it. The contract only names the state so refusal can be typed.
export type EvidenceAtomRedactionState = "redacted" | "raw-internal";

export const EVIDENCE_ATOM_REDACTION_STATES: readonly EvidenceAtomRedactionState[] = [
  "redacted",
  "raw-internal",
] as const;

export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface EvidenceAtom {
  readonly schemaVersion: typeof CONNECTED_CONTEXT_SCHEMA_VERSION;
  readonly stableId: string;
  // Path relative to the connected scope root. Never absolute; never carries Windows drive
  // letters or UNC prefixes. Enforced at validation time by isValidScopePath.
  readonly scopePath: string;
  readonly lineRange: LineRange | undefined;
  readonly score: number;
  readonly provenance: EvidenceAtomProvenance;
  readonly redactionState: EvidenceAtomRedactionState;
  readonly emittedAtMs: number;
  readonly ledgerRef: EvidenceLedgerRef | undefined;
}

// ─── Exploration budget + usage ───────────────────────────────────────────────
// Seven independently-exhausted dimensions; conflating any pair lets one dimension hide
// overshoot in another.
export interface ExplorationBudget {
  readonly searchCallsMax: number;
  readonly filesReadMax: number;
  readonly excerptBytesMax: number;
  readonly modelInputTokensMax: number;
  readonly modelOutputTokensMax: number;
  readonly elapsedMsMax: number;
  readonly rerankCallsMax: number;
}

export const DEFAULT_EXPLORATION_BUDGET: ExplorationBudget = {
  searchCallsMax: 16,
  filesReadMax: 32,
  excerptBytesMax: 131_072,
  modelInputTokensMax: 32_000,
  modelOutputTokensMax: 4_096,
  elapsedMsMax: 30_000,
  rerankCallsMax: 0,
} as const;

export interface ExplorationUsage {
  readonly searchCalls: number;
  readonly filesRead: number;
  readonly excerptBytes: number;
  readonly modelInputTokens: number;
  readonly modelOutputTokens: number;
  readonly elapsedMs: number;
  readonly rerankCalls: number;
}

// ─── Retrieval query ──────────────────────────────────────────────────────────
export type RetrievalQueryKind = "natural-language" | "exact-symbol" | "file-pattern" | "regex";

export const RETRIEVAL_QUERY_KINDS: readonly RetrievalQueryKind[] = [
  "natural-language",
  "exact-symbol",
  "file-pattern",
  "regex",
] as const;

export interface RetrievalQuery {
  readonly kind: RetrievalQueryKind;
  readonly text: string;
  readonly caseSensitive: boolean;
  readonly maxResults: number;
  readonly emittedAtMs: number;
}

// ─── Candidate file ───────────────────────────────────────────────────────────
export type CandidateOmissionReason =
  | "outside-scope"
  | "binary"
  | "generated"
  | "ignored"
  | "size-exceeded"
  | "near-duplicate"
  | "low-relevance"
  | "redacted-only"
  | "budget-exhausted"
  | "tool-unavailable";

export const CANDIDATE_OMISSION_REASONS: readonly CandidateOmissionReason[] = [
  "outside-scope",
  "binary",
  "generated",
  "ignored",
  "size-exceeded",
  "near-duplicate",
  "low-relevance",
  "redacted-only",
  "budget-exhausted",
  "tool-unavailable",
] as const;

export interface CandidateSignal {
  readonly name: string;
  readonly value: number;
}

export interface CandidateFile {
  readonly scopePath: string;
  readonly score: number;
  readonly signals: readonly CandidateSignal[];
  readonly omitted: CandidateOmissionReason | undefined;
}

// ─── Context excerpt ──────────────────────────────────────────────────────────
export interface ContextExcerpt {
  readonly atom: EvidenceAtom;
  readonly content: string;
  readonly contentBytes: number;
}

// ─── Connected file entry ─────────────────────────────────────────────────────
export type ConnectedFileRole = "read-only" | "editable";

export const CONNECTED_FILE_ROLES: readonly ConnectedFileRole[] = [
  "read-only",
  "editable",
] as const;

export interface ConnectedFileEntry {
  readonly scopePath: string;
  readonly role: ConnectedFileRole;
  readonly selectionReason: string;
  readonly excerpts: readonly ContextExcerpt[];
}

// ─── Uncertainty marker ───────────────────────────────────────────────────────
export type UncertaintyMarkerKind =
  | "no-evidence"
  | "stale-evidence"
  | "scope-incomplete"
  | "budget-clipped"
  | "tool-unavailable"
  | "low-confidence";

export const UNCERTAINTY_MARKER_KINDS: readonly UncertaintyMarkerKind[] = [
  "no-evidence",
  "stale-evidence",
  "scope-incomplete",
  "budget-clipped",
  "tool-unavailable",
  "low-confidence",
] as const;

export interface UncertaintyMarker {
  readonly kind: UncertaintyMarkerKind;
  readonly claim: string;
  readonly impactedAtomIds: readonly string[];
  readonly emittedAtMs: number;
}

// ─── Omitted-context entry ────────────────────────────────────────────────────
export interface OmittedContextEntry {
  readonly scopePath: string;
  readonly reason: CandidateOmissionReason;
  readonly omittedAtMs: number;
}

// ─── Connected context pack ───────────────────────────────────────────────────
export interface ConnectedContextPack {
  readonly schemaVersion: typeof CONNECTED_CONTEXT_SCHEMA_VERSION;
  readonly stableId: string;
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly budget: ExplorationBudget;
  readonly usage: ExplorationUsage;
  readonly files: readonly ConnectedFileEntry[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly uncertainty: readonly UncertaintyMarker[];
  readonly emittedAtMs: number;
  readonly ledgerRef: EvidenceLedgerRef | undefined;
}

// ─── UI-safe pack summary ─────────────────────────────────────────────────────
// Excludes raw content so it can render in browser surfaces without re-redaction.
export interface ConnectedContextPackSummary {
  readonly schemaVersion: typeof CONNECTED_CONTEXT_SCHEMA_VERSION;
  readonly stableId: string;
  readonly scopeId: string;
  readonly scopeKind: SelectedScopeKind;
  readonly conversationId: string | undefined;
  readonly queryKind: RetrievalQueryKind;
  readonly fileCount: number;
  readonly readOnlyFileCount: number;
  readonly editableFileCount: number;
  readonly omittedCount: number;
  readonly uncertaintyCount: number;
  readonly usage: ExplorationUsage;
  readonly budget: ExplorationBudget;
  readonly emittedAtMs: number;
}

// ─── Conversation attachment linkage ──────────────────────────────────────────
export interface ConversationAttachmentContextLink {
  readonly attachmentId: string;
  readonly contextPackStableId: string;
  readonly scopeId: string;
  readonly linkedAtMs: number;
}

// ─── Stable-ID input shapes (no computation here) ─────────────────────────────
// Input DTOs that downstream packages will hash deterministically. The contracts package
// names the shapes so the hash producer in #179+ has a single source of truth.
export interface EvidenceAtomStableIdInput {
  readonly scopeId: string;
  readonly scopePath: string;
  readonly lineRange: LineRange | undefined;
  readonly provenanceKind: EvidenceAtomProvenanceKind;
  readonly provenanceTool: string;
  readonly queryFingerprint: string;
}

export interface ConnectedContextPackStableIdInput {
  readonly scopeId: string;
  readonly queryKind: RetrievalQueryKind;
  readonly queryText: string;
  readonly atomStableIds: readonly string[];
}

// ─── Validation helpers ───────────────────────────────────────────────────────
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

export interface IsValidScopePathOptions {
  // Only `true` is supported today; `false` returns `false` (defensive contract boundary).
  readonly mustBeRelative: boolean;
}

// Module-scope regex (avoid per-call allocation; safe — no backtracking risk).
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

// The schema discriminant comparisons below are statically true at the type level (the
// constant equals the literal field type), so we widen to `string` before comparing. This
// keeps the validator honest against runtime inputs that bypass the type system — e.g.,
// objects materialized from JSON.parse or cross-version manifests.
function schemaMismatch(actual: string, expected: string): boolean {
  return actual !== expected;
}

function isFiniteNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isFinitePositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonEmptyTrimmed(value: string): boolean {
  return value.trim().length > 0;
}

function hasInvalidPathPrefix(path: string): boolean {
  if (path.startsWith("/")) {
    return true;
  }
  if (path.startsWith("\\\\")) {
    return true;
  }
  return WINDOWS_DRIVE_RE.test(path);
}

function hasInvalidSegments(path: string): boolean {
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return true;
    }
    if (segment === "." || segment === "..") {
      return true;
    }
  }
  return false;
}

export function isValidScopePath(path: string, options: IsValidScopePathOptions): boolean {
  if (!options.mustBeRelative) {
    return false;
  }
  if (path.length === 0) {
    return false;
  }
  if (path.includes("\0")) {
    return false;
  }
  // Backslashes are not valid path separators in POSIX workspace-relative paths; reject
  // them before segment analysis so Windows-style traversals cannot slip through.
  if (path.includes("\\")) {
    return false;
  }
  if (hasInvalidPathPrefix(path)) {
    return false;
  }
  return !hasInvalidSegments(path);
}

export function isValidLineRange(range: LineRange): boolean {
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine)) {
    return false;
  }
  if (range.startLine < 1) {
    return false;
  }
  return range.endLine >= range.startLine;
}

export function isWithinBudget(usage: ExplorationUsage, budget: ExplorationBudget): boolean {
  const dims: readonly (readonly [number, number])[] = [
    [usage.searchCalls, budget.searchCallsMax],
    [usage.filesRead, budget.filesReadMax],
    [usage.excerptBytes, budget.excerptBytesMax],
    [usage.modelInputTokens, budget.modelInputTokensMax],
    [usage.modelOutputTokens, budget.modelOutputTokensMax],
    [usage.elapsedMs, budget.elapsedMsMax],
    [usage.rerankCalls, budget.rerankCallsMax],
  ];
  for (const dim of dims) {
    const used = dim[0];
    const cap = dim[1];
    if (!Number.isFinite(used) || used < 0) {
      return false;
    }
    if (used > cap) {
      return false;
    }
  }
  return true;
}

function pushIf(reasons: string[], condition: boolean, reason: string): void {
  if (condition) {
    reasons.push(reason);
  }
}

function buildResult(reasons: readonly string[]): ValidationResult {
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function validateScopeKindPaths(scope: SelectedScope, reasons: string[]): void {
  const paths = scope.relativePaths;
  if (scope.kind === "workspace-root" && paths.length !== 0) {
    reasons.push("scope.relativePaths must be empty for workspace-root");
  }
  if (scope.kind === "directory" && paths.length !== 1) {
    reasons.push("scope.relativePaths must have exactly one entry for directory");
  }
  if (scope.kind === "files" && paths.length < 1) {
    reasons.push("scope.relativePaths must be non-empty for files");
  }
  for (const candidate of paths) {
    if (!isValidScopePath(candidate, { mustBeRelative: true })) {
      reasons.push("scope.relativePaths contains an invalid path");
      return;
    }
  }
}

export function validateSelectedScope(scope: SelectedScope): ValidationResult {
  const reasons: string[] = [];
  pushIf(
    reasons,
    schemaMismatch(scope.schemaVersion, CONNECTED_CONTEXT_SCHEMA_VERSION),
    "scope.schemaVersion mismatch",
  );
  pushIf(reasons, !isNonEmptyTrimmed(scope.scopeId), "scope.scopeId empty");
  pushIf(reasons, scope.workspaceRoot.length === 0, "scope.workspaceRoot empty");
  pushIf(reasons, !SELECTED_SCOPE_KINDS.includes(scope.kind), "scope.kind invalid");
  if (SELECTED_SCOPE_KINDS.includes(scope.kind)) {
    validateScopeKindPaths(scope, reasons);
  }
  pushIf(reasons, !isFiniteNonNegativeInteger(scope.connectedAtMs), "scope.connectedAtMs invalid");
  if (scope.conversationId !== undefined) {
    pushIf(reasons, !isNonEmptyTrimmed(scope.conversationId), "scope.conversationId empty");
  }
  return buildResult(reasons);
}

function validateLedgerRef(ref: EvidenceLedgerRef, reasons: string[], prefix: string): void {
  if (schemaMismatch(ref.evidenceSchemaVersion, "1")) {
    reasons.push(`${prefix}.ledgerRef.evidenceSchemaVersion mismatch`);
  }
  if (!isNonEmptyTrimmed(ref.runId)) {
    reasons.push(`${prefix}.ledgerRef.runId empty`);
  }
  if (ref.atomId?.trim().length === 0) {
    reasons.push(`${prefix}.ledgerRef.atomId empty`);
  }
}

function isScoreInUnitInterval(score: number): boolean {
  return Number.isFinite(score) && score >= 0 && score <= 1;
}

export function validateEvidenceAtom(atom: EvidenceAtom): ValidationResult {
  const reasons: string[] = [];
  pushIf(
    reasons,
    schemaMismatch(atom.schemaVersion, CONNECTED_CONTEXT_SCHEMA_VERSION),
    "atom.schemaVersion mismatch",
  );
  pushIf(reasons, !isNonEmptyTrimmed(atom.stableId), "atom.stableId empty");
  pushIf(
    reasons,
    !isValidScopePath(atom.scopePath, { mustBeRelative: true }),
    "atom.scopePath invalid",
  );
  if (atom.lineRange !== undefined) {
    pushIf(reasons, !isValidLineRange(atom.lineRange), "atom.lineRange invalid");
  }
  pushIf(reasons, !isScoreInUnitInterval(atom.score), "atom.score out of range");
  pushIf(
    reasons,
    !EVIDENCE_ATOM_PROVENANCE_KINDS.includes(atom.provenance.kind),
    "atom.provenance.kind invalid",
  );
  pushIf(reasons, !isNonEmptyTrimmed(atom.provenance.tool), "atom.provenance.tool empty");
  pushIf(
    reasons,
    !isNonEmptyTrimmed(atom.provenance.queryFingerprint),
    "atom.provenance.queryFingerprint empty",
  );
  pushIf(
    reasons,
    !EVIDENCE_ATOM_REDACTION_STATES.includes(atom.redactionState),
    "atom.redactionState invalid",
  );
  pushIf(reasons, !isFiniteNonNegativeInteger(atom.emittedAtMs), "atom.emittedAtMs invalid");
  if (atom.ledgerRef !== undefined) {
    validateLedgerRef(atom.ledgerRef, reasons, "atom");
  }
  return buildResult(reasons);
}

export function validateRetrievalQuery(query: RetrievalQuery): ValidationResult {
  const reasons: string[] = [];
  pushIf(reasons, !RETRIEVAL_QUERY_KINDS.includes(query.kind), "query.kind invalid");
  pushIf(reasons, query.text.length === 0, "query.text empty");
  pushIf(reasons, !isFinitePositiveInteger(query.maxResults), "query.maxResults invalid");
  pushIf(reasons, !isFiniteNonNegativeInteger(query.emittedAtMs), "query.emittedAtMs invalid");
  return buildResult(reasons);
}

// UTF-8 byte length via WHATWG TextEncoder (Web standard; available on globalThis in Node 22).
// Using this instead of Buffer keeps the contracts package free of Node-only APIs.
const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

function validatePackFiles(files: readonly ConnectedFileEntry[], reasons: string[]): void {
  for (const entry of files) {
    if (!CONNECTED_FILE_ROLES.includes(entry.role)) {
      reasons.push("pack.files entry has invalid role");
    }
    if (!isValidScopePath(entry.scopePath, { mustBeRelative: true })) {
      reasons.push("pack.files entry has invalid scopePath");
    }
    if (!isNonEmptyTrimmed(entry.selectionReason)) {
      reasons.push("pack.files entry has empty selectionReason");
    }
    for (const excerpt of entry.excerpts) {
      const atomResult = validateEvidenceAtom(excerpt.atom);
      if (!atomResult.ok) {
        for (const reason of atomResult.reasons) {
          reasons.push(`pack.files excerpt ${reason}`);
        }
      }
      if (excerpt.contentBytes !== utf8ByteLength(excerpt.content)) {
        reasons.push("pack.files excerpt contentBytes mismatch");
      }
    }
  }
}

function validatePackOmitted(entries: readonly OmittedContextEntry[], reasons: string[]): void {
  for (const [i, entry] of entries.entries()) {
    if (!CANDIDATE_OMISSION_REASONS.includes(entry.reason)) {
      reasons.push("pack.omitted has invalid reason");
    }
    if (!isValidScopePath(entry.scopePath, { mustBeRelative: true })) {
      reasons.push(`omitted[${i.toString()}].scopePath invalid`);
    }
    if (!isFiniteNonNegativeInteger(entry.omittedAtMs)) {
      reasons.push("pack.omitted has invalid omittedAtMs");
    }
  }
}

function validatePackUncertainty(entries: readonly UncertaintyMarker[], reasons: string[]): void {
  for (const entry of entries) {
    if (!UNCERTAINTY_MARKER_KINDS.includes(entry.kind)) {
      reasons.push("pack.uncertainty has invalid kind");
    }
    if (!isFiniteNonNegativeInteger(entry.emittedAtMs)) {
      reasons.push("pack.uncertainty has invalid emittedAtMs");
    }
  }
}

function checkBudgetDimension(
  used: number,
  cap: number,
  dimension: string,
  reasons: string[],
): void {
  if (!isFiniteNonNegativeInteger(cap)) {
    reasons.push(`budget.${dimension}Max not a finite non-negative integer`);
    return;
  }
  if (!Number.isFinite(used) || used < 0) {
    reasons.push(`pack.usage.${dimension} invalid`);
    return;
  }
  if (used > cap) {
    reasons.push(`pack.usage.${dimension} exceeds budget`);
  }
}

function validatePackBudget(pack: ConnectedContextPack, reasons: string[]): void {
  checkBudgetDimension(pack.usage.searchCalls, pack.budget.searchCallsMax, "searchCalls", reasons);
  checkBudgetDimension(pack.usage.filesRead, pack.budget.filesReadMax, "filesRead", reasons);
  checkBudgetDimension(
    pack.usage.excerptBytes,
    pack.budget.excerptBytesMax,
    "excerptBytes",
    reasons,
  );
  checkBudgetDimension(
    pack.usage.modelInputTokens,
    pack.budget.modelInputTokensMax,
    "modelInputTokens",
    reasons,
  );
  checkBudgetDimension(
    pack.usage.modelOutputTokens,
    pack.budget.modelOutputTokensMax,
    "modelOutputTokens",
    reasons,
  );
  checkBudgetDimension(pack.usage.elapsedMs, pack.budget.elapsedMsMax, "elapsedMs", reasons);
  checkBudgetDimension(pack.usage.rerankCalls, pack.budget.rerankCallsMax, "rerankCalls", reasons);
}

export function validateConnectedContextPack(pack: ConnectedContextPack): ValidationResult {
  const reasons: string[] = [];
  pushIf(
    reasons,
    schemaMismatch(pack.schemaVersion, CONNECTED_CONTEXT_SCHEMA_VERSION),
    "pack.schemaVersion mismatch",
  );
  pushIf(reasons, !isNonEmptyTrimmed(pack.stableId), "pack.stableId empty");
  const scopeResult = validateSelectedScope(pack.scope);
  if (!scopeResult.ok) {
    for (const reason of scopeResult.reasons) {
      reasons.push(`pack.${reason}`);
    }
  }
  const queryResult = validateRetrievalQuery(pack.query);
  if (!queryResult.ok) {
    for (const reason of queryResult.reasons) {
      reasons.push(`pack.${reason}`);
    }
  }
  validatePackBudget(pack, reasons);
  validatePackFiles(pack.files, reasons);
  validatePackOmitted(pack.omitted, reasons);
  validatePackUncertainty(pack.uncertainty, reasons);
  pushIf(reasons, !isFiniteNonNegativeInteger(pack.emittedAtMs), "pack.emittedAtMs invalid");
  if (pack.ledgerRef !== undefined) {
    validateLedgerRef(pack.ledgerRef, reasons, "pack");
  }
  return buildResult(reasons);
}
