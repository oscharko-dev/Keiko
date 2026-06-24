// Grounded repository Q&A orchestrator (Epic #177, Issue #185). Composes the connected-context
// layers — #181 exploration planner, #179 lexical search facade, #180 structural adapters,
// #182 candidate ranker, and #183 context-pack assembler — into a single linear pipeline that
// produces a redacted `ConnectedContextPack` plus an assistant-content string. The model call
// is injected through the `GroundedAnswerer` seam so production can route through the Model
// Gateway while tests can keep deterministic answerers.
//
// Pure orchestration: the only IO this module performs is delegated through the workspace
// package's already-bounded WorkspaceFs port. Path validation is enforced by every composed
// layer at its own boundary, so this file does not re-validate scope paths.

import { createHash } from "node:crypto";
import {
  isValidScopePath,
  type CandidateFile,
  type ConnectedContextPack,
  type ContextPackDiagnostics,
  type EvidenceAtom,
  type ExplorationBudget,
  type ExplorationUsage,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
  type UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import {
  advanceRing,
  applyUsage,
  assembleContextPack,
  canContinue,
  classifyRetrievalIntent,
  complete,
  contextPackIndexKey,
  planAndGovern,
  rankCandidates,
  type ClarificationPrompt,
  type ExcerptWindow,
  type ExplorationPlan,
  type GovernorState,
  type MicroIndex,
  type RetrievalIntent,
  type RetrievalRing,
  type SearchAnchor,
} from "@oscharko-dev/keiko-workflows";
import {
  CANONICAL_MANIFEST_BASENAMES,
  DEFAULT_SEARCH_LIMITS,
  FileTooLargeError,
  RepoSearchUnsupportedFileError,
  detectWorkspaceAt,
  findFiles,
  gitHistoryAdapter,
  importGraphAdapter,
  isCanonicalMetadataFile,
  isDenied,
  readExcerpt,
  resolveWithinWorkspace,
  runStructuralAdapters,
  searchText,
  type SearchScope,
  type StructuralAdapterRegistry,
  testSourcePairingAdapter,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceInfo,
  containedRealPathInfo,
  evidenceAtomStableId,
} from "@oscharko-dev/keiko-workspace";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { normalizeGroundedAnswerPayload, type GroundedAnswerPayload } from "./grounded-answer.js";
import {
  collectConnectedDocumentEvidence,
  isConnectedDocumentPath,
  type DocumentEvidenceResult,
} from "./grounded-document-evidence.js";
import { attachContextBudgetDiagnostics } from "./grounded-context-diagnostics.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GroundedAnswerer {
  // The seam the route uses: production supplies a Model Gateway-backed answerer, while tests can
  // keep deterministic answerers.
  answer(question: string, pack: ConnectedContextPack): Promise<GroundedAnswerPayload>;
}

export interface OrchestratorInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly workspaceRoot: string;
  readonly budget?: ExplorationBudget;
}

export interface OrchestratorDeps {
  readonly answerer: GroundedAnswerer;
  readonly nowMs?: () => number;
  readonly signal?: AbortSignal | undefined;
  // Optional injected port for tests; production uses the realpath-contained node adapter.
  readonly fs?: WorkspaceFs;
  // Optional injected detector for tests so memFs fixtures don't need full WorkspaceInfo wiring.
  readonly detectWorkspace?: (root: string, fs: WorkspaceFs) => WorkspaceInfo;
  // Called after a ready plan exists and before any workspace detection or repository IO starts.
  readonly recordPlan?: (plan: ExplorationPlan) => void;
  // Ephemeral #183 context-pack cache for one connected scope/session.
  readonly microIndex?: MicroIndex;
  // Optional context profile (ADR-0055 D1, PR4-W1). When absent (legacy callers, multi-source and
  // hybrid paths in W1), the diagnostics observer is NOT invoked and the assembled pack is
  // byte-identical to today. When present, the observer attaches ContextAssemblyDiagnostics-derived
  // ContextBudget to pack.diagnostics.contextBudget? — an additive field no prompt builder reads.
  readonly contextProfile?: ContextProfile | undefined;
}

export interface OrchestratorOutput {
  readonly pack: ConnectedContextPack;
  readonly assistantContent: string;
  readonly elapsedMs: number;
  readonly plan?: ExplorationPlan;
}

// Epic #532 — retrieval-only output. The multi-source (1+N) path runs retrieval per connected
// source, then answers ONCE over the merged packs, so it needs the pack without a per-scope
// answer. `elapsedMs` here is retrieval-only wall time (no model call), distinct from
// OrchestratorOutput.elapsedMs which also includes the answer.
export interface RetrievalOnlyOutput {
  readonly pack: ConnectedContextPack;
  readonly elapsedMs: number;
  readonly plan: ExplorationPlan;
}

// Raised when the planner asks for clarification (no anchors, too-generic prompt, etc.). The
// route maps this to a 400 BAD_REQUEST via clarificationUserMessage below; the Error message
// itself keeps the stable machine-ish form for logs and tests.
export class ClarificationNeededError extends Error {
  public constructor(public readonly clarification: ClarificationPrompt) {
    super(`clarification needed: ${clarification.reason}`);
    this.name = "ClarificationNeededError";
  }
}

// Release 0.2.0 — user-facing mapping for a planner clarification. The raw reason string
// ("clarification needed: too-generic") told the user nothing actionable; the HTTP message now
// says what the planner needs and folds in the planner's own suggested questions. Static text
// plus planner-built suggestions only — no user/file content, so nothing to redact.
export function clarificationUserMessage(error: ClarificationNeededError): string {
  const { reason, suggestedQuestions } = error.clarification;
  const intro =
    reason === "scope-empty"
      ? "Die verbundene Quelle enthält nichts Durchsuchbares."
      : reason === "scope-invalid"
        ? "Die verbundene Quelle konnte nicht durchsucht werden."
        : "Keiko braucht mehr Kontext, um die verbundenen Quellen gezielt zu durchsuchen.";
  const anchorHint =
    reason === "no-anchors" || reason === "too-generic"
      ? " Nenne eine konkrete Datei, einen Identifier, eine Fehlermeldung oder eine exakte Phrase."
      : "";
  const examples = suggestedQuestions.slice(0, 2);
  const exampleText =
    examples.length > 0 ? ` Zum Beispiel: ${examples.map((q) => `"${q}"`).join(" oder ")}` : "";
  return `${intro}${anchorHint}${exampleText}`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface SearchInputs {
  readonly searchScope: SearchScope;
  readonly query: RetrievalQuery;
  readonly anchors: readonly SearchAnchor[];
  readonly retrievalIntent: RetrievalIntent;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
}

interface RingResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly uncertainty: readonly UncertaintyMarker[];
  readonly usage: ExplorationUsage;
  // Explainable-ranking diagnostics from the lexical ring's candidate ordering (M2). Only the
  // lexical ring populates this; structural/git rings leave it undefined.
  readonly diagnostics?: ContextPackDiagnostics | undefined;
}

// Maps the workspace-layer SearchDiagnostics.rankedCandidates onto the contract pack-diagnostics
// shape. Structurally identical (path/bucket/score/ecosystem/signals) but mapped explicitly so the
// workspace and contracts types stay decoupled. Returns undefined when no diagnostics are present.
function toPackDiagnostics(
  diagnostics: Awaited<ReturnType<typeof searchText>>["diagnostics"],
): ContextPackDiagnostics | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  return {
    rankedCandidates: diagnostics.rankedCandidates.map((entry) => ({
      scopePath: entry.scopePath,
      bucket: entry.bucket,
      score: entry.score,
      ecosystem: entry.ecosystem,
      signals: entry.signals.map((signal) => ({ name: signal.name, value: signal.value })),
    })),
  };
}

const TEXT_ENCODER = new TextEncoder();

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CancelledError("grounded repository request cancelled");
  }
}

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

function usageDelta(overrides: Partial<ExplorationUsage> = {}): ExplorationUsage {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
    ...overrides,
  };
}

function clampUsageToBudget(usage: ExplorationUsage, budget: ExplorationBudget): ExplorationUsage {
  return {
    searchCalls: Math.min(usage.searchCalls, budget.searchCallsMax),
    filesRead: Math.min(usage.filesRead, budget.filesReadMax),
    excerptBytes: Math.min(usage.excerptBytes, budget.excerptBytesMax),
    modelInputTokens: Math.min(usage.modelInputTokens, budget.modelInputTokensMax),
    modelOutputTokens: Math.min(usage.modelOutputTokens, budget.modelOutputTokensMax),
    elapsedMs: Math.min(usage.elapsedMs, budget.elapsedMsMax),
    rerankCalls: Math.min(usage.rerankCalls, budget.rerankCallsMax),
  };
}

function budgetClipped(stopReason: string, nowMs: number): UncertaintyMarker {
  return {
    kind: "budget-clipped",
    claim: `repository exploration stopped: ${stopReason}`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function answerBudgetClipped(dimensions: readonly string[], nowMs: number): UncertaintyMarker {
  return {
    kind: "budget-clipped",
    claim: `grounded answer exceeded budget: ${dimensions.join(", ")}`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function noEvidence(nowMs: number): UncertaintyMarker {
  return {
    kind: "no-evidence",
    claim: "No repository evidence matched the connected scope for this question.",
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function toolUnavailable(claim: string, nowMs: number): UncertaintyMarker {
  return {
    kind: "tool-unavailable",
    claim,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function readBudgetStopReason(budget: ExplorationBudget): string | undefined {
  const exhausted = [
    ...(budget.filesReadMax <= 0 ? ["filesRead"] : []),
    ...(budget.excerptBytesMax <= 0 ? ["excerptBytes"] : []),
  ];
  if (exhausted.length === 0) {
    return undefined;
  }
  return `budget-exhausted on ${exhausted.join(", ")}`;
}

function omittedFromSearchCandidates(
  candidates: readonly CandidateFile[],
  nowMs: number,
): readonly OmittedContextEntry[] {
  const omitted: OmittedContextEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.omitted === undefined) {
      continue;
    }
    if (!isValidScopePath(candidate.scopePath, { mustBeRelative: true })) {
      continue;
    }
    omitted.push({
      scopePath: candidate.scopePath,
      reason: candidate.omitted,
      omittedAtMs: nowMs,
    });
  }
  return omitted;
}

function safeAdapterName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned.length === 0 ? "structural-adapter" : cleaned;
}

function adapterDiagnostics(
  result: {
    readonly unavailable: readonly string[];
    readonly errored: readonly { readonly name: string }[];
  },
  nowMs: number,
): readonly UncertaintyMarker[] {
  const markers: UncertaintyMarker[] = [];
  const seen = new Set<string>();
  for (const name of result.unavailable) {
    const safeName = safeAdapterName(name);
    if (seen.has(`unavailable:${safeName}`)) {
      continue;
    }
    seen.add(`unavailable:${safeName}`);
    markers.push(toolUnavailable(`structural adapter unavailable: ${safeName}`, nowMs));
  }
  for (const error of result.errored) {
    const safeName = safeAdapterName(error.name);
    if (seen.has(`errored:${safeName}`)) {
      continue;
    }
    seen.add(`errored:${safeName}`);
    markers.push(toolUnavailable(`structural adapter failed safely: ${safeName}`, nowMs));
  }
  return markers;
}

function dedupeUncertainty(markers: readonly UncertaintyMarker[]): readonly UncertaintyMarker[] {
  const seen = new Set<string>();
  const out: UncertaintyMarker[] = [];
  for (const marker of markers) {
    const key = `${marker.kind}:${marker.claim}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(marker);
  }
  return out;
}

function anchorKindForTerm(
  term: string,
  anchors: readonly SearchAnchor[],
): SearchAnchor["kind"] | undefined {
  return anchors.find((anchor) => anchor.term === term)?.kind;
}

function looksPathAnchor(term: string): boolean {
  return term.includes("/") || /\.[a-z0-9]+$/i.test(term);
}

function queryForStructuralAnchor(
  term: string,
  kind: SearchAnchor["kind"] | undefined,
  base: RetrievalQuery,
): RetrievalQuery {
  return {
    ...base,
    kind:
      kind === "identifier" || (!looksPathAnchor(term) && kind !== "path")
        ? "exact-symbol"
        : "natural-language",
    text: term,
  };
}

function structuralQueriesForRing(
  ring: RetrievalRing,
  inputs: SearchInputs,
): readonly RetrievalQuery[] {
  const queries: RetrievalQuery[] = [];
  const seen = new Set<string>();
  for (const term of ring.anchorTerms) {
    const anchorKind = anchorKindForTerm(term, inputs.anchors);
    if (anchorKind !== "path" && anchorKind !== "identifier" && anchorKind !== "quoted") {
      continue;
    }
    const query = queryForStructuralAnchor(term, anchorKind, inputs.query);
    const key = `${query.kind}:${query.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    queries.push(query);
  }
  return queries.length === 0 ? [inputs.query] : queries;
}

function plannedSearchCallsForRing(ring: RetrievalRing, inputs: SearchInputs): number {
  return ring.kind === "structural" ? structuralQueriesForRing(ring, inputs).length : 1;
}

function mergeAtomsByStableId(
  results: readonly RunRingStructuralResult[],
  cap: number,
): readonly EvidenceAtom[] {
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    for (const atom of result.atoms) {
      if (atoms.length >= cap) {
        return atoms;
      }
      if (seen.has(atom.stableId)) {
        continue;
      }
      seen.add(atom.stableId);
      atoms.push(atom);
    }
  }
  return atoms;
}

interface RunRingStructuralResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly unavailable: readonly string[];
  readonly errored: readonly { readonly name: string }[];
  readonly elapsedMs: number;
}

async function runRing(ring: RetrievalRing, inputs: SearchInputs): Promise<RingResult> {
  if (ring.kind === "lexical") {
    const result = await searchText(inputs.searchScope, inputs.query, ring.searchLimits, {
      fs: inputs.fs,
      nowMs: inputs.nowMs,
      searchHints: { retrievalIntent: inputs.retrievalIntent },
    });
    // Lexical scanning is transient: each candidate file is read to match lines, then discarded.
    // It does NOT consume the excerpt budget. Charging result.filesScanned against filesReadMax
    // (Epic #177 retrieval defect) let a wide scan exhaust the budget the excerpt READ phase needs
    // and starved multi-file scopes — the scan could only ever examine ~4 files. The reserved
    // search call (one per ring) plus elapsedMs already bound the scan; the files whose content
    // actually enters the pack are charged when their excerpts are read in the assembler.
    return {
      atoms: result.atoms,
      omitted: omittedFromSearchCandidates(result.candidates, inputs.nowMs()),
      uncertainty: [],
      usage: usageDelta({ elapsedMs: result.elapsedMs }),
      diagnostics: toPackDiagnostics(result.diagnostics),
    };
  }
  // Keep the planner's ring split authoritative: the structural ring should only run the
  // structural adapters, while the git-history ring should only run the repo-level history
  // adapter. Reusing the full default registry for both rings duplicates atoms and inflates
  // downstream ranking signals whenever a workspace-root query plans both rings.
  const registry: StructuralAdapterRegistry =
    ring.kind === "structural"
      ? { adapters: [testSourcePairingAdapter, importGraphAdapter] }
      : { adapters: [gitHistoryAdapter] };
  const queries =
    ring.kind === "structural" ? structuralQueriesForRing(ring, inputs) : [inputs.query];
  const results = await Promise.all(
    queries.map((query) =>
      runStructuralAdapters(registry, inputs.searchScope, query, ring.searchLimits, inputs.fs, {
        nowMs: inputs.nowMs,
      }),
    ),
  );
  const elapsedMs = results.reduce((sum, result) => sum + result.elapsedMs, 0);
  const cap = Math.min(ring.searchLimits.maxMatchesReturned, inputs.query.maxResults);
  const atoms = ring.kind === "git-history" ? [] : mergeAtomsByStableId(results, cap);
  const uncertainty = dedupeUncertainty(
    results.flatMap((result) => adapterDiagnostics(result, inputs.nowMs())),
  );
  return {
    atoms,
    omitted: [],
    uncertainty,
    usage: usageDelta({ elapsedMs }),
  };
}

interface RingRunSummary {
  readonly atoms: readonly EvidenceAtom[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly governor: GovernorState;
  readonly uncertainty: readonly UncertaintyMarker[];
  // Ranking diagnostics from the (first) lexical ring; undefined when no lexical ring ran (M2).
  readonly diagnostics?: ContextPackDiagnostics | undefined;
}

interface RingReservation {
  readonly governor: GovernorState;
  readonly marker?: UncertaintyMarker | undefined;
}

function reserveRingSearchCalls(
  governor: GovernorState,
  ring: RetrievalRing,
  inputs: SearchInputs,
): RingReservation {
  const reserved = applyUsage(
    governor,
    usageDelta({ searchCalls: plannedSearchCallsForRing(ring, inputs) }),
  );
  if (reserved.status !== "budget-exhausted") {
    return { governor: reserved };
  }
  return {
    governor: reserved,
    marker: budgetClipped(reserved.stopReason ?? "budget exhausted", inputs.nowMs()),
  };
}

async function runAllRings(
  rings: readonly RetrievalRing[],
  inputs: SearchInputs,
  initialGovernor: GovernorState,
): Promise<RingRunSummary> {
  const blockedByReadBudget = readBudgetStopReason(initialGovernor.plan.budget);
  if (blockedByReadBudget !== undefined) {
    return {
      atoms: [],
      omitted: [],
      governor: complete(initialGovernor),
      uncertainty: [budgetClipped(blockedByReadBudget, inputs.nowMs())],
    };
  }
  const atoms: EvidenceAtom[] = [];
  const omitted: OmittedContextEntry[] = [];
  const uncertainty: UncertaintyMarker[] = [];
  // Ring order is fixed by the plan, so capturing the first lexical ring's diagnostics is
  // deterministic. (There is normally exactly one lexical ring.)
  let diagnostics: ContextPackDiagnostics | undefined;
  let governor = initialGovernor;
  for (const ring of rings) {
    throwIfCancelled(inputs.signal);
    if (!canContinue(governor)) {
      break;
    }
    const reservation = reserveRingSearchCalls(governor, ring, inputs);
    governor = reservation.governor;
    if (reservation.marker !== undefined) {
      uncertainty.push(reservation.marker);
      break;
    }
    const result = await runRing(ring, inputs);
    throwIfCancelled(inputs.signal);
    // First lexical ring wins (??= never overwrites once set); ring order is plan-fixed.
    diagnostics ??= result.diagnostics;
    const afterRing = applyUsage(governor, result.usage);
    atoms.push(...result.atoms);
    omitted.push(...result.omitted);
    uncertainty.push(...result.uncertainty);
    if (afterRing.status === "budget-exhausted") {
      governor = afterRing;
      uncertainty.push(budgetClipped(afterRing.stopReason ?? "budget exhausted", inputs.nowMs()));
      break;
    }
    governor = advanceRing(afterRing);
  }
  if (governor.status === "running") {
    governor = complete(governor);
  }
  return { atoms, omitted, governor, uncertainty, diagnostics };
}

interface ExcerptInputs {
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly budget: ExplorationBudget;
  readonly initialUsage: ExplorationUsage;
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
}

interface ExcerptReadSummary {
  readonly excerpts: ReadonlyMap<string, readonly ExcerptWindow[]>;
  readonly uncertainty: readonly UncertaintyMarker[];
}

type PackCacheIdentity = readonly string[];

interface CandidateOrdering {
  readonly kept: readonly CandidateFile[];
  readonly omitted: readonly OmittedContextEntry[];
}

interface LineWindow {
  readonly startLine: number;
  readonly endLine: number;
}

const DEFAULT_EXCERPT_WINDOW: LineWindow = { startLine: 1, endLine: 200 };
const EXCERPT_CONTEXT_LINES = 2;
const MAX_EXCERPT_WINDOWS_PER_FILE = 8;
const PROJECT_METADATA_QUERY_TERMS = [
  "abhängigkeit",
  "abhängigkeiten",
  "abhaengigkeit",
  "abhaengigkeiten",
  "build",
  "cypress",
  "dependenc",
  "dependencies",
  "devdependencies",
  "framework",
  "java-script",
  "javascript",
  "jest",
  "node",
  "node.js",
  "npm",
  "package",
  "package.json",
  "package-manager",
  "paketmanager",
  "playwright",
  "pnpm",
  "react",
  "script",
  "stack",
  "tech-stack",
  "techstack",
  "test",
  "test-runner",
  "testing",
  "testumgebung",
  "type script",
  "type-script",
  "typescript",
  "version",
  "versionen",
  "vite",
  "vitest",
  "yarn",
] as const;
// Dependency lockfiles surfaced for project-metadata questions (unchanged behaviour). The manifest
// basenames themselves now come from the shared ecosystem registry (CANONICAL_MANIFEST_BASENAMES),
// which is a superset of the prior JS/TS-only list and additionally covers Maven/Gradle/Go/Rust/
// Python/.NET/etc., so "Which Java version does this project use?" injects pom.xml/build.gradle as
// deterministic score-1 metadata atoms.
const PROJECT_METADATA_LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
const PROJECT_METADATA_FILENAMES: readonly string[] = [
  ...CANONICAL_MANIFEST_BASENAMES,
  ...PROJECT_METADATA_LOCKFILES,
];
const REPOSITORY_OVERVIEW_FILENAMES = [
  "README.md",
  "readme.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/ARCHITECTURE.md",
  "docs/adr/README.md",
] as const;
const WORKSPACE_PACKAGE_DIRS = ["packages", "apps", "services", "libs"] as const;
const MAX_WORKSPACE_MANIFESTS = 24;
const SYMBOL_FILE_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mts",
  "cts",
  "mjs",
  "cjs",
  "vue",
] as const;
const SYMBOL_FILE_EXTENSION_SET: ReadonlySet<string> = new Set(SYMBOL_FILE_EXTENSIONS);
const SYMBOL_FILE_SEARCH_LIMITS = {
  maxFilesScanned: 10_000,
  maxMatchesReturned: 32,
  maxBytesPerFileScanned: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
  elapsedMsMax: DEFAULT_SEARCH_LIMITS.elapsedMsMax,
} as const;
const SYMBOL_LINE_SCAN_BYTES_MAX = 2_097_152;
// Aggregate cap on firstSymbolLine reads across ALL terms in one question, so a vague code question
// on a large customer repo can never trigger an unbounded number of full-file reads even if many
// files match the symbol globs (each read also re-stats + splits the file — see firstSymbolLine).
const MAX_SYMBOL_LINE_READS = 64;
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
]);

function basename(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index >= 0 ? scopePath.slice(index + 1) : scopePath;
}

function compareByScopePath(a: OmittedContextEntry, b: OmittedContextEntry): number {
  return a.scopePath.localeCompare(b.scopePath);
}

function isKeikoEvidenceArtifact(scopePath: string): boolean {
  return scopePath.toLowerCase().startsWith(".keiko/evidence/");
}

function isLockfilePath(scopePath: string): boolean {
  return LOCKFILE_NAMES.has(basename(scopePath).toLowerCase());
}

function dirname(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index <= 0 ? "" : scopePath.slice(0, index);
}

function joinScopePath(base: string, filename: string): string {
  return base.length === 0 ? filename : `${base}/${filename}`;
}

function projectMetadataQueryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "project-metadata",
        queryKind: query.kind,
        text: query.text,
        caseSensitive: query.caseSensitive,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function selectedFileQueryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "explicit-selected-file",
        queryKind: query.kind,
        text: query.text,
        caseSensitive: query.caseSensitive,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function normalizedQueryText(queryText: string): string {
  return queryText.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function retrievalIntentFor(input: OrchestratorInput): RetrievalIntent {
  return classifyRetrievalIntent(input.query.text, input.scope).intent;
}

function wantsProjectMetadata(input: OrchestratorInput): boolean {
  const intent = retrievalIntentFor(input);
  if (intent === "project-metadata" || intent === "repository-overview") {
    return true;
  }
  const lowered = input.query.text.toLowerCase();
  const normalized = normalizedQueryText(input.query.text);
  return PROJECT_METADATA_QUERY_TERMS.some(
    (term) => lowered.includes(term) || normalized.includes(term),
  );
}

function wantsRepositoryOverview(input: OrchestratorInput): boolean {
  return retrievalIntentFor(input) === "repository-overview";
}

function metadataRootsForScope(scope: SelectedScope): readonly string[] {
  if (scope.relativePaths.length === 0) {
    return [""];
  }
  const roots = new Set<string>();
  for (const entry of scope.relativePaths) {
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      continue;
    }
    roots.add(scope.kind === "files" ? dirname(entry) : entry);
  }
  return [...roots].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWorkspacePatterns(searchScope: SearchScope, fs: WorkspaceFs): readonly string[] {
  if (!fileExistsInSearchScope(searchScope, fs, "package.json")) {
    return [];
  }
  try {
    const abs = resolveWithinWorkspace(searchScope.workspace.root, "package.json");
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    const parsed: unknown = JSON.parse(fs.readFileUtf8(contained.path));
    if (!isRecord(parsed)) {
      return [];
    }
    const workspaces = parsed.workspaces;
    if (Array.isArray(workspaces)) {
      return workspaces.filter((entry): entry is string => typeof entry === "string");
    }
    if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
      return workspaces.packages.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    return [];
  }
  return [];
}

function normalizeWorkspacePattern(pattern: string): string | undefined {
  let normalized = pattern.trim().replace(/\\/gu, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized.startsWith("../") || normalized.includes("/../")) {
    return undefined;
  }
  return normalized;
}

function safeReadDir(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
): readonly WorkspaceDirEntry[] {
  if (!isValidScopePath(scopePath, { mustBeRelative: true })) {
    return [];
  }
  try {
    const abs = resolveWithinWorkspace(searchScope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    if (!fs.stat(contained.path).isDirectory) {
      return [];
    }
    return fs.readDir(contained.path);
  } catch {
    return [];
  }
}

// Bound on how many service subdirectories under a `dir/*` pattern are scanned, so a monorepo with
// thousands of packages cannot trigger an unbounded directory fan-out (the per-result cap in the
// caller is MAX_WORKSPACE_MANIFESTS; this caps the WORK, not just the output).
const MAX_MONOREPO_SERVICE_DIRS = 96;

// Canonical project manifests of ANY ecosystem present directly inside `dir` (one bounded readDir,
// realpath-contained, no symlink following). Replaces the prior package.json-only probe so a
// polyglot monorepo surfaces service-local pom.xml / go.mod / Cargo.toml / *.csproj, not just
// JS packages. isDenied is applied even though the registry is deny-clean (defence in depth), and
// the result is sorted for deterministic evidence ordering.
function canonicalManifestScopePathsInDir(
  dir: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
): readonly string[] {
  return safeReadDir(searchScope, fs, dir)
    .filter((entry) => !entry.isDirectory && !entry.isSymbolicLink)
    .map((entry) => joinScopePath(dir, entry.name))
    .filter((scopePath) => isCanonicalMetadataFile(scopePath) && !isDenied(scopePath))
    .sort();
}

function expandWorkspacePattern(
  pattern: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
): readonly string[] {
  const normalized = normalizeWorkspacePattern(pattern);
  if (normalized === undefined) {
    return [];
  }
  if (!normalized.includes("*")) {
    const dir = normalized.endsWith("/package.json")
      ? normalized.slice(0, -"/package.json".length)
      : normalized;
    return canonicalManifestScopePathsInDir(dir, searchScope, fs);
  }
  if (!normalized.endsWith("/*") || normalized.slice(0, -2).includes("*")) {
    return [];
  }
  const base = normalized.slice(0, -2);
  return safeReadDir(searchScope, fs, base)
    .filter((entry) => entry.isDirectory && !entry.isSymbolicLink)
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_MONOREPO_SERVICE_DIRS)
    .flatMap((name) =>
      canonicalManifestScopePathsInDir(joinScopePath(base, name), searchScope, fs),
    );
}

function workspacePackageManifestPaths(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
): readonly string[] {
  if (input.scope.kind !== "workspace-root" || input.scope.relativePaths.length !== 0) {
    return [];
  }
  const patterns = new Set<string>(readWorkspacePatterns(searchScope, fs));
  for (const dir of WORKSPACE_PACKAGE_DIRS) {
    patterns.add(`${dir}/*`);
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const pattern of [...patterns].sort()) {
    for (const scopePath of expandWorkspacePattern(pattern, searchScope, fs)) {
      if (seen.has(scopePath)) {
        continue;
      }
      seen.add(scopePath);
      paths.push(scopePath);
      if (paths.length >= MAX_WORKSPACE_MANIFESTS) {
        return paths;
      }
    }
  }
  return paths;
}

function metadataAtom(
  scope: SelectedScope,
  scopePath: string,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      provenanceTool: "repo.projectMetadata",
      queryFingerprint,
    }),
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: {
      kind: "file-listing",
      tool: "repo.projectMetadata",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function overviewAtom(
  scope: SelectedScope,
  scopePath: string,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      provenanceTool: "repo.repositoryOverview",
      queryFingerprint,
    }),
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: {
      kind: "file-listing",
      tool: "repo.repositoryOverview",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function symbolFileQuery(input: OrchestratorInput, pattern: string): RetrievalQuery {
  return {
    kind: "file-pattern",
    text: pattern,
    caseSensitive: false,
    maxResults: 32,
    emittedAtMs: input.query.emittedAtMs,
  };
}

function symbolFileAnchorTerms(plan: ExplorationPlan): readonly string[] {
  if (
    plan.retrievalIntent !== "targeted-code-search" &&
    plan.retrievalIntent !== "diagnostic-search"
  ) {
    return [];
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const anchor of plan.anchors) {
    if (anchor.kind !== "identifier" || anchor.weight < 0.85) {
      continue;
    }
    if (!/^[a-z_$][a-z0-9_$-]+$/u.test(anchor.term) || anchor.term.includes(".")) {
      continue;
    }
    if (!seen.has(anchor.term)) {
      seen.add(anchor.term);
      terms.push(anchor.term);
    }
    if (terms.length >= 3) {
      break;
    }
  }
  return terms;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function lineDefinesSymbol(line: string, term: string): boolean {
  const escaped = escapeRegex(term);
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`, "iu"),
    new RegExp(`\\b(?:export\\s+)?(?:class|interface|type|enum)\\s+${escaped}\\b`, "iu"),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`, "iu"),
  ];
  return patterns.some((pattern) => pattern.test(line));
}

function firstLineIndex(lines: readonly string[], predicate: (line: string) => boolean): number {
  return lines.findIndex(predicate);
}

function firstSymbolLine(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  term: string,
): number | undefined {
  try {
    const abs = resolveWithinWorkspace(searchScope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    const stat = fs.stat(contained.path);
    if (!stat.isFile || stat.size > SYMBOL_LINE_SCAN_BYTES_MAX) {
      return undefined;
    }
    const loweredTerm = term.toLowerCase();
    const lines = fs.readFileUtf8(contained.path).split("\n");
    const definitionIndex = firstLineIndex(lines, (line) => lineDefinesSymbol(line, term));
    const index =
      definitionIndex >= 0
        ? definitionIndex
        : firstLineIndex(lines, (line) => line.toLowerCase().includes(loweredTerm));
    return index < 0 ? undefined : index + 1;
  } catch {
    return undefined;
  }
}

function symbolLineAtom(
  scope: SelectedScope,
  scopePath: string,
  lineNumber: number,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  const lineRange = { startLine: lineNumber, endLine: lineNumber };
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange,
      provenanceKind: "lexical-search",
      provenanceTool: "repo.symbolFileDiscovery",
      queryFingerprint,
    }),
    scopePath,
    lineRange,
    score: 1,
    provenance: {
      kind: "lexical-search",
      tool: "repo.symbolFileDiscovery",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function scopePathExtension(scopePath: string): string {
  const name = scopePath.slice(scopePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

// True when `scopePath` is a `<term>.<code-extension>` definition file. The single-walk symbol glob
// `**/term.*` also matches multi-dot names like `term.test.tsx` (which the prior per-extension globs
// did not), so this restores the exact contract: keep only paths ending in `term.<ext>` for a code
// extension — the implementation file, not its co-named spec/story. Exported for direct testing.
export function isSymbolDefinitionPath(scopePath: string, term: string): boolean {
  const extension = scopePathExtension(scopePath);
  return (
    SYMBOL_FILE_EXTENSION_SET.has(extension) &&
    scopePath.toLowerCase().endsWith(`${term.toLowerCase()}.${extension}`)
  );
}

interface SymbolReadBudget {
  remaining: number;
}

// Walk the tree ONCE for `**/term.*`, keep only `term.<code-ext>` definition files, and (within the
// shared read budget) attach the definition/first-mention line. The single walk replaces the prior
// per-extension globs (up to 27 redundant full-tree walks per question, ~4.7s on a 3.5k-file repo).
async function symbolAtomsForTerm(
  term: string,
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  budget: SymbolReadBudget,
): Promise<readonly EvidenceAtom[]> {
  const result = await findFiles(
    searchScope,
    symbolFileQuery(input, `**/${term}.*`),
    SYMBOL_FILE_SEARCH_LIMITS,
    {
      fs,
      nowMs,
      searchHints: { retrievalIntent: plan.retrievalIntent },
    },
  );
  const atoms: EvidenceAtom[] = [];
  for (const atom of result.atoms) {
    if (!isSymbolDefinitionPath(atom.scopePath, term)) {
      continue;
    }
    atoms.push(atom);
    if (budget.remaining <= 0) {
      continue;
    }
    budget.remaining -= 1;
    const lineNumber = firstSymbolLine(searchScope, fs, atom.scopePath, term);
    if (lineNumber !== undefined) {
      const fp = atom.provenance.queryFingerprint;
      atoms.push(symbolLineAtom(input.scope, atom.scopePath, lineNumber, fp, nowMs));
    }
  }
  return atoms;
}

async function symbolFileAtoms(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
): Promise<readonly EvidenceAtom[]> {
  const terms = symbolFileAnchorTerms(plan);
  if (terms.length === 0) {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const budget: SymbolReadBudget = { remaining: MAX_SYMBOL_LINE_READS };
  for (const term of terms) {
    throwIfCancelled(signal);
    for (const atom of await symbolAtomsForTerm(
      term,
      input,
      plan,
      searchScope,
      fs,
      nowMs,
      budget,
    )) {
      if (!seen.has(atom.stableId)) {
        seen.add(atom.stableId);
        atoms.push(atom);
      }
    }
  }
  return atoms;
}

function selectedFileAtom(
  scope: SelectedScope,
  scopePath: string,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      provenanceTool: "repo.selectedFile",
      queryFingerprint,
    }),
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: {
      kind: "file-listing",
      tool: "repo.selectedFile",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function fileExistsInSearchScope(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
): boolean {
  try {
    const abs = resolveWithinWorkspace(searchScope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    return fs.stat(contained.path).isFile;
  } catch {
    return false;
  }
}

function selectedFileScopeAtoms(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
): readonly EvidenceAtom[] {
  if (input.scope.explicitConnection !== true || input.scope.kind !== "files") {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const queryFingerprint = selectedFileQueryFingerprint(input.query);
  for (const entry of input.scope.relativePaths) {
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      continue;
    }
    const scopePath = entry.replace(/\\/gu, "/");
    if (seen.has(scopePath)) {
      continue;
    }
    seen.add(scopePath);
    // Connected documents (supported DOCX/XLSX/PDF, or a known-unsupported document format) are not
    // code-first excerpt files; they are handled exclusively by bounded document extraction (Issue
    // #1285), so they must not also enter the line-window excerpt path here — that would double-count
    // the file and leave an empty, unreadable code excerpt alongside the document evidence/diagnostic.
    if (isConnectedDocumentPath(scopePath)) {
      continue;
    }
    if (fileExistsInSearchScope(searchScope, fs, scopePath)) {
      atoms.push(selectedFileAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  return atoms;
}

// Accept a candidate injection path once: not already seen, shape-valid, and NOT deny-listed.
// isDenied is re-checked here (not only at the downstream read gate) so a registry manifest pattern
// can never inject a deny-listed/secret path as a score-1 atom; registry patterns are also asserted
// deny-clean in ecosystems.test.ts. Mutates `seen` on acceptance.
function acceptInjectionScopePath(scopePath: string, seen: Set<string>): boolean {
  if (
    seen.has(scopePath) ||
    !isValidScopePath(scopePath, { mustBeRelative: true }) ||
    isDenied(scopePath)
  ) {
    return false;
  }
  seen.add(scopePath);
  return true;
}

// Bound on glob-manifest atoms injected per metadata root from a single directory listing (M4,
// risk #1). The exact-name loop above handles fixed basenames; this catches GLOB manifests at the
// root/scope dir (e.g. *.csproj, *.tf) that have no fixed name. Deny-checked + deduped + capped.
const MAX_ROOT_GLOB_MANIFESTS = 16;

// Bounded glob-manifest sweep of a single directory: returns the accepted (deduped, deny-clean,
// shape-valid) scope paths, capped at MAX_ROOT_GLOB_MANIFESTS. Mutates `seen` via the gate.
function rootGlobManifestPaths(
  root: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  seen: Set<string>,
): readonly string[] {
  const paths: string[] = [];
  for (const scopePath of canonicalManifestScopePathsInDir(root, searchScope, fs)) {
    if (paths.length >= MAX_ROOT_GLOB_MANIFESTS) {
      break;
    }
    if (acceptInjectionScopePath(scopePath, seen)) {
      paths.push(scopePath);
    }
  }
  return paths;
}

function projectMetadataAtoms(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
): readonly EvidenceAtom[] {
  if (!wantsProjectMetadata(input)) {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const queryFingerprint = projectMetadataQueryFingerprint(input.query);
  for (const root of metadataRootsForScope(input.scope)) {
    for (const filename of PROJECT_METADATA_FILENAMES) {
      const scopePath = joinScopePath(root, filename);
      if (
        acceptInjectionScopePath(scopePath, seen) &&
        fileExistsInSearchScope(searchScope, fs, scopePath)
      ) {
        atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
      }
    }
    // Glob-manifest sweep of the directory itself (bounded), so a root-level *.csproj / *.tf that
    // the fixed-name list cannot enumerate is still injected. Exact names already seen are deduped.
    for (const scopePath of rootGlobManifestPaths(root, searchScope, fs, seen)) {
      atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  for (const scopePath of workspacePackageManifestPaths(input, searchScope, fs)) {
    if (acceptInjectionScopePath(scopePath, seen)) {
      atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  return atoms;
}

function repositoryOverviewAtoms(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
): readonly EvidenceAtom[] {
  if (!wantsRepositoryOverview(input)) {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const queryFingerprint = projectMetadataQueryFingerprint(input.query);
  for (const root of metadataRootsForScope(input.scope)) {
    for (const filename of REPOSITORY_OVERVIEW_FILENAMES) {
      const scopePath = joinScopePath(root, filename);
      if (
        acceptInjectionScopePath(scopePath, seen) &&
        fileExistsInSearchScope(searchScope, fs, scopePath)
      ) {
        atoms.push(overviewAtom(input.scope, scopePath, queryFingerprint, nowMs));
      }
    }
  }
  return atoms;
}

async function withDeterministicContextAtoms(
  rings: RingRunSummary,
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
): Promise<RingRunSummary> {
  const deterministicAtoms = [
    ...(await symbolFileAtoms(input, plan, searchScope, fs, nowMs, signal)),
    ...projectMetadataAtoms(input, searchScope, fs, nowMs),
    ...repositoryOverviewAtoms(input, searchScope, fs, nowMs),
  ];
  return deterministicAtoms.length === 0
    ? rings
    : { ...rings, atoms: [...rings.atoms, ...deterministicAtoms] };
}

function withExplicitScopeAtoms(
  rings: RingRunSummary,
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
): RingRunSummary {
  const selectedAtoms = selectedFileScopeAtoms(input, searchScope, fs, nowMs);
  return selectedAtoms.length === 0
    ? rings
    : { ...rings, atoms: [...selectedAtoms, ...rings.atoms] };
}

function queryTerms(queryText: string, anchors: readonly SearchAnchor[]): readonly string[] {
  const terms = new Set<string>();
  const loweredQuery = queryText.toLowerCase();
  for (const token of loweredQuery.split(/[^a-z0-9._/-]+/)) {
    if (token.length > 0) {
      terms.add(token);
    }
  }
  for (const anchor of anchors) {
    const lowered = anchor.term.toLowerCase();
    if (lowered.length > 0) {
      terms.add(lowered);
    }
    for (const token of lowered.split(/[^a-z0-9._/-]+/)) {
      if (token.length > 0) {
        terms.add(token);
      }
    }
  }
  return [...terms];
}

function explicitlyTargetsRuntimeArtifact(
  scopePath: string,
  queryText: string,
  anchors: readonly SearchAnchor[],
): boolean {
  if (!isKeikoEvidenceArtifact(scopePath)) {
    return false;
  }
  const loweredQuery = queryText.toLowerCase();
  if (loweredQuery.includes(".keiko") || loweredQuery.includes("evidence artifact")) {
    return true;
  }
  return queryTerms(queryText, anchors).some((term) => scopePath.toLowerCase().includes(term));
}

function explicitlyTargetsLockfile(
  scopePath: string,
  queryText: string,
  anchors: readonly SearchAnchor[],
): boolean {
  if (!isLockfilePath(scopePath)) {
    return false;
  }
  const loweredQuery = queryText.toLowerCase();
  if (
    loweredQuery.includes("lockfile") ||
    loweredQuery.includes("package manager") ||
    loweredQuery.includes("packagemanager") ||
    loweredQuery.includes("dependency version") ||
    loweredQuery.includes("dependency versions") ||
    loweredQuery.includes("resolved version") ||
    loweredQuery.includes("resolved versions")
  ) {
    return true;
  }
  const path = scopePath.toLowerCase();
  const name = basename(scopePath).toLowerCase();
  return queryTerms(queryText, anchors).some((term) => path.includes(term) || name === term);
}

function refineCandidateOrdering(
  kept: readonly CandidateFile[],
  omitted: readonly OmittedContextEntry[],
  queryText: string,
  anchors: readonly SearchAnchor[],
  nowMs: number,
): CandidateOrdering {
  const preferred: CandidateFile[] = [];
  const lockfiles: CandidateFile[] = [];
  const runtimeArtifacts: CandidateFile[] = [];

  for (const candidate of kept) {
    const scopePath = candidate.scopePath;
    if (
      isKeikoEvidenceArtifact(scopePath) &&
      !explicitlyTargetsRuntimeArtifact(scopePath, queryText, anchors)
    ) {
      runtimeArtifacts.push(candidate);
      continue;
    }
    if (isLockfilePath(scopePath) && !explicitlyTargetsLockfile(scopePath, queryText, anchors)) {
      lockfiles.push(candidate);
      continue;
    }
    preferred.push(candidate);
  }

  if (preferred.length === 0) {
    return { kept, omitted };
  }

  const nextOmitted = [...omitted];
  for (const candidate of runtimeArtifacts) {
    nextOmitted.push({
      scopePath: candidate.scopePath,
      reason: "low-relevance",
      omittedAtMs: nowMs,
    });
  }
  nextOmitted.sort(compareByScopePath);
  return {
    kept: [...preferred, ...lockfiles],
    omitted: nextOmitted,
  };
}

function groupEvidenceAtomsByPath(
  atoms: readonly EvidenceAtom[],
): ReadonlyMap<string, readonly EvidenceAtom[]> {
  const grouped = new Map<string, EvidenceAtom[]>();
  for (const atom of atoms) {
    const existing = grouped.get(atom.scopePath);
    if (existing === undefined) {
      grouped.set(atom.scopePath, [atom]);
    } else {
      existing.push(atom);
    }
  }
  return grouped;
}

function lineWindowForAtom(atom: EvidenceAtom): LineWindow {
  const range = atom.lineRange;
  if (range === undefined) {
    return DEFAULT_EXCERPT_WINDOW;
  }
  return {
    startLine: Math.max(1, range.startLine - EXCERPT_CONTEXT_LINES),
    endLine: range.endLine + EXCERPT_CONTEXT_LINES,
  };
}

function mergeLineWindows(windows: readonly LineWindow[]): readonly LineWindow[] {
  const sorted = [...windows].sort((a, b) =>
    a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
  );
  const merged: LineWindow[] = [];
  for (const window of sorted) {
    const previous = merged[merged.length - 1];
    if (previous === undefined || window.startLine > previous.endLine + 1) {
      merged.push(window);
      continue;
    }
    merged[merged.length - 1] = {
      startLine: previous.startLine,
      endLine: Math.max(previous.endLine, window.endLine),
    };
  }
  return merged;
}

function windowContainsAtom(window: LineWindow, atom: EvidenceAtom): boolean {
  const range = atom.lineRange;
  return (
    range === undefined || (window.startLine <= range.startLine && window.endLine >= range.endLine)
  );
}

function strongestAtomScoreForWindow(
  window: LineWindow,
  atomsForPath: readonly EvidenceAtom[],
): number {
  let score = 0;
  for (const atom of atomsForPath) {
    if (windowContainsAtom(window, atom) && atom.score > score) {
      score = atom.score;
    }
  }
  return score;
}

interface ExcerptWindowSelection {
  readonly windows: readonly LineWindow[];
  readonly omittedWindowCount: number;
}

function excerptLineWindows(
  atomsForPath: readonly EvidenceAtom[] | undefined,
): ExcerptWindowSelection {
  if (atomsForPath === undefined || atomsForPath.length === 0) {
    return { windows: [DEFAULT_EXCERPT_WINDOW], omittedWindowCount: 0 };
  }
  const merged = mergeLineWindows(atomsForPath.map(lineWindowForAtom));
  const selected = [...merged]
    .sort((a, b) => {
      const scoreDelta =
        strongestAtomScoreForWindow(b, atomsForPath) - strongestAtomScoreForWindow(a, atomsForPath);
      return scoreDelta === 0 ? a.startLine - b.startLine : scoreDelta;
    })
    .slice(0, MAX_EXCERPT_WINDOWS_PER_FILE)
    .sort((a, b) =>
      a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
    );
  return {
    windows: selected,
    omittedWindowCount: Math.max(0, merged.length - selected.length),
  };
}

function exhaustedDimensions(remainingFiles: number, remainingBytes: number): string {
  return [
    ...(remainingFiles <= 0 ? ["filesRead"] : []),
    ...(remainingBytes <= 0 ? ["excerptBytes"] : []),
  ].join(", ");
}

interface ReadPathExcerptWindowsResult {
  readonly windows: readonly ExcerptWindow[];
  readonly bytesConsumed: number;
  readonly omittedWindowCount: number;
}

async function readPathExcerptWindows(
  scopePath: string,
  inputs: ExcerptInputs,
  remainingBytes: number,
): Promise<ReadPathExcerptWindowsResult> {
  const windows: ExcerptWindow[] = [];
  let bytesConsumed = 0;
  const selection = excerptLineWindows(inputs.atomsByPath.get(scopePath));
  for (const window of selection.windows) {
    throwIfCancelled(inputs.signal);
    const availableBytes = remainingBytes - bytesConsumed;
    if (availableBytes <= 0) {
      break;
    }
    const maxBytes = Math.min(8192, availableBytes);
    const result = await readExcerpt(
      inputs.searchScope,
      { scopePath, startLine: window.startLine, endLine: window.endLine, maxBytes },
      { fs: inputs.fs },
    );
    throwIfCancelled(inputs.signal);
    windows.push({ ...window, content: result.content });
    bytesConsumed += utf8ByteLength(result.content);
  }
  return { windows, bytesConsumed, omittedWindowCount: selection.omittedWindowCount };
}

async function readKeptExcerpts(
  keptPaths: readonly string[],
  inputs: ExcerptInputs,
): Promise<ExcerptReadSummary> {
  const excerpts = new Map<string, readonly ExcerptWindow[]>();
  const uncertainty: UncertaintyMarker[] = [];
  let remainingFiles = Math.max(0, inputs.budget.filesReadMax - inputs.initialUsage.filesRead);
  let remainingBytes = Math.max(
    0,
    inputs.budget.excerptBytesMax - inputs.initialUsage.excerptBytes,
  );
  for (const scopePath of keptPaths) {
    throwIfCancelled(inputs.signal);
    if (remainingFiles <= 0 || remainingBytes <= 0) {
      const dimensions = exhaustedDimensions(remainingFiles, remainingBytes);
      uncertainty.push(budgetClipped(`budget-exhausted on ${dimensions}`, inputs.nowMs()));
      break;
    }
    try {
      const result = await readPathExcerptWindows(scopePath, inputs, remainingBytes);
      const { windows } = result;
      if (windows.length > 0) {
        excerpts.set(scopePath, windows);
        if (result.omittedWindowCount > 0) {
          uncertainty.push({
            kind: "scope-incomplete",
            claim: `excerpt window limit omitted ${String(result.omittedWindowCount)} additional matching range(s) in ${scopePath}`,
            impactedAtomIds: [],
            emittedAtMs: inputs.nowMs(),
          });
        }
        remainingFiles -= 1;
        remainingBytes -= result.bytesConsumed;
      }
    } catch (error) {
      // A single unreadable file (unsupported/binary, or larger than the excerpt read cap) must
      // degrade to a skipped excerpt, never crash the whole grounded answer. Other kept files and
      // the rest of the pipeline continue; the file simply contributes no excerpt content.
      if (error instanceof RepoSearchUnsupportedFileError || error instanceof FileTooLargeError) {
        continue;
      }
      throw error;
    }
  }
  return { excerpts, uncertainty };
}

function buildSearchScope(scope: SelectedScope, workspace: WorkspaceInfo): SearchScope {
  return {
    workspace,
    scopeId: scope.scopeId,
    relativePaths: scope.relativePaths,
  };
}

function fileStateCacheIdentity(
  keptPaths: readonly string[],
  searchScope: SearchScope,
  fs: WorkspaceFs,
): PackCacheIdentity | undefined {
  const identity: string[] = [];
  try {
    for (const scopePath of keptPaths) {
      const target = containedRealPathInfo(
        fs,
        searchScope.workspace.root,
        resolveWithinWorkspace(searchScope.workspace.root, scopePath),
      );
      const stat = fs.stat(target.path);
      if (!stat.isFile || stat.mtimeMs === undefined) {
        return undefined;
      }
      identity.push(
        `${scopePath}:${target.realRelative}:${stat.size.toString()}:${stat.mtimeMs.toString()}`,
      );
    }
  } catch {
    return undefined;
  }
  return identity.sort();
}

interface ReadyPlanResult {
  readonly plan: ExplorationPlan;
  readonly governor: GovernorState;
}

function createReadyGovernedPlan(input: OrchestratorInput, nowMs: () => number): ReadyPlanResult {
  const planned = planAndGovern(
    input.budget === undefined
      ? { scope: input.scope, query: input.query }
      : { scope: input.scope, query: input.query, budget: input.budget },
    { nowMs },
  );
  const { plan } = planned;
  if (plan.state !== "ready") {
    if (plan.clarification !== undefined) {
      throw new ClarificationNeededError(plan.clarification);
    }
    throw new ClarificationNeededError({
      reason: "scope-invalid",
      suggestedQuestions: ["Reselect files or a directory before asking."],
      minimumAnchorCount: 0,
    });
  }
  if (planned.governor === undefined) {
    throw new Error("ready exploration plan did not produce a budget governor");
  }
  return { plan, governor: planned.governor };
}

interface AssembleGroundedPackInputs {
  readonly input: OrchestratorInput;
  readonly deps: OrchestratorDeps;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
}

interface EmptyGroundedPackInputs {
  readonly input: OrchestratorInput;
  readonly deps: OrchestratorDeps;
  readonly plan: ExplorationPlan;
  readonly governor: GovernorState;
  readonly nowMs: () => number;
  readonly stopReason: string;
}

interface GroundedPackCacheLookupInputs {
  readonly input: OrchestratorInput;
  readonly deps: OrchestratorDeps;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
  readonly ordered: CandidateOrdering;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly initialUsage: ExplorationUsage;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

type AssembleOptionsForGroundedPack =
  | { readonly nowMs: () => number }
  | { readonly nowMs: () => number; readonly microIndex: MicroIndex };

interface PreparedPackAssembly {
  readonly atoms: readonly EvidenceAtom[];
  readonly initialUsage: ExplorationUsage;
  readonly ordered: CandidateOrdering;
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly evidenceUncertainty: readonly UncertaintyMarker[];
  readonly keptPaths: readonly string[];
}

interface FinalContextPackInputs {
  readonly input: OrchestratorInput;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
  readonly prepared: PreparedPackAssembly;
  readonly excerptReads: ExcerptReadSummary;
  readonly documentEvidence: DocumentEvidenceResult;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

// Document paths are disjoint from code excerpt paths (documents are excluded from the code-first
// selected-file atoms), so a plain copy-merge never overwrites a code excerpt.
function mergeExcerptSources(
  base: ReadonlyMap<string, readonly ExcerptWindow[]>,
  documents: ReadonlyMap<string, readonly ExcerptWindow[]>,
): ReadonlyMap<string, readonly ExcerptWindow[]> {
  if (documents.size === 0) {
    return base;
  }
  const merged = new Map<string, readonly ExcerptWindow[]>(base);
  for (const [scopePath, windows] of documents) {
    merged.set(scopePath, windows);
  }
  return merged;
}

async function assembleEmptyGroundedPack({
  input,
  deps,
  plan,
  governor,
  nowMs,
  stopReason,
}: EmptyGroundedPackInputs): Promise<ConnectedContextPack> {
  const assembleOptions =
    deps.microIndex === undefined ? { nowMs } : { nowMs, microIndex: deps.microIndex };
  const assemble = await assembleContextPack(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms: [],
      ranked: [],
      omittedFromRanking: [],
      excerpts: new Map(),
      initialUsage: clampUsageToBudget(governor.usage, plan.budget),
      initialUncertainty: [budgetClipped(stopReason, nowMs())],
    },
    assembleOptions,
  );
  return assemble.pack;
}

function cachedGroundedPack({
  input,
  deps,
  plan,
  rings,
  ordered,
  cacheIdentity,
  initialUsage,
  assembleOptions,
}: GroundedPackCacheLookupInputs): ConnectedContextPack | undefined {
  if (deps.microIndex === undefined || cacheIdentity === undefined) {
    return undefined;
  }
  const key = contextPackIndexKey(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms: rings.atoms,
      ranked: ordered.kept,
      omittedFromRanking: [...rings.omitted, ...ordered.omitted],
      excerpts: new Map(),
      cacheIdentity,
      initialUsage,
      diagnostics: rings.diagnostics,
    },
    assembleOptions,
  );
  return deps.microIndex.get(key);
}

function preparePackAssembly(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  rings: RingRunSummary,
  nowMs: () => number,
): PreparedPackAssembly {
  const atoms = rings.atoms;
  const initialUsage = clampUsageToBudget(rings.governor.usage, plan.budget);
  // M4: pass the classified retrieval intent so ranking can apply intent-conditioned signals
  // (canonical-metadata, structural-edge). Non-boosted intents (e.g. clarification) and the
  // no-context default are byte-identical — see weightsForIntent / isIntentBoosted.
  const ranking = rankCandidates(
    { atoms, anchors: plan.anchors, context: { retrievalIntent: plan.retrievalIntent } },
    { nowMs },
  );
  const ordered = refineCandidateOrdering(
    ranking.kept,
    ranking.omitted,
    input.query.text,
    plan.anchors,
    nowMs(),
  );
  return {
    atoms,
    initialUsage,
    ordered,
    atomsByPath: groupEvidenceAtomsByPath(atoms),
    evidenceUncertainty:
      atoms.length === 0 || ordered.kept.length === 0 ? [noEvidence(nowMs())] : [],
    keptPaths: ordered.kept.map((c) => c.scopePath),
  };
}

async function assemblePackFromReads({
  input,
  plan,
  rings,
  prepared,
  excerptReads,
  documentEvidence,
  cacheIdentity,
  assembleOptions,
}: FinalContextPackInputs): Promise<ConnectedContextPack> {
  const excerpts = mergeExcerptSources(excerptReads.excerpts, documentEvidence.excerpts);
  const needsNoEvidenceMarker =
    excerpts.size === 0 &&
    !prepared.evidenceUncertainty.some((marker) => marker.kind === "no-evidence");
  // Connected documents are owned exclusively by the bounded document-extraction path: they either
  // surface as document evidence or as a precise document diagnostic. The code-first lexical scan
  // also sees them as binary candidates, so strip any document-path omission it produced to avoid a
  // path that is both a selected file and an omitted entry (which the pack validator rejects).
  const codeOmitted = [...rings.omitted, ...prepared.ordered.omitted].filter(
    (entry) => !isConnectedDocumentPath(entry.scopePath),
  );
  const assemble = await assembleContextPack(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms: [...prepared.atoms, ...documentEvidence.atoms],
      ranked: [...prepared.ordered.kept, ...documentEvidence.candidates],
      omittedFromRanking: [...codeOmitted, ...documentEvidence.omitted],
      excerpts,
      // Document evidence is request-local and not part of the file-state cache key, so a pack that
      // carries any document evidence — extracted atoms OR skipped-document omissions — must not be
      // written into the micro-index under a code-only file-state key (it would orphan an entry the
      // read-bypass gate never serves). Mirror the bypass condition in prepareGroundedAssembly.
      cacheIdentity:
        documentEvidence.atoms.length > 0 || documentEvidence.omitted.length > 0
          ? undefined
          : cacheIdentity,
      initialUsage: prepared.initialUsage,
      diagnostics: rings.diagnostics,
      initialUncertainty: [
        ...rings.uncertainty,
        ...excerptReads.uncertainty,
        ...prepared.evidenceUncertainty,
        ...documentEvidence.uncertainty,
        ...(needsNoEvidenceMarker ? [noEvidence(assembleOptions.nowMs())] : []),
      ],
    },
    assembleOptions,
  );
  return assemble.pack;
}

async function augmentRingsWithDeterministicAtoms({
  input,
  deps,
  plan,
  rings,
  searchScope,
  fs,
  nowMs,
}: AssembleGroundedPackInputs): Promise<RingRunSummary> {
  const scopedRings = withExplicitScopeAtoms(rings, input, searchScope, fs, nowMs);
  return withDeterministicContextAtoms(
    scopedRings,
    input,
    plan,
    searchScope,
    fs,
    nowMs,
    deps.signal,
  );
}

interface GroundedAssemblyContext {
  readonly documentEvidence: DocumentEvidenceResult;
  readonly cached: ConnectedContextPack | undefined;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

async function prepareGroundedAssembly(
  args: AssembleGroundedPackInputs,
  augmentedRings: RingRunSummary,
  prepared: PreparedPackAssembly,
): Promise<GroundedAssemblyContext> {
  const { input, deps, plan, searchScope, fs, nowMs } = args;
  // Bounded small-document extraction for explicit `files` scopes (Issue #1285). Returns empty
  // evidence for every other scope kind, leaving the code-first path byte-identical.
  const documentEvidence = await collectConnectedDocumentEvidence({
    scope: input.scope,
    query: input.query,
    searchScope,
    fs,
    nowMs,
    signal: deps.signal,
  });
  const hasDocumentEvidence =
    documentEvidence.atoms.length > 0 || documentEvidence.omitted.length > 0;
  const cacheIdentity =
    deps.microIndex === undefined || hasDocumentEvidence
      ? undefined
      : fileStateCacheIdentity(prepared.keptPaths, searchScope, fs);
  const assembleOptions =
    deps.microIndex === undefined || hasDocumentEvidence
      ? { nowMs }
      : { nowMs, microIndex: deps.microIndex };
  // The micro-index cache key does not model request-local document evidence, so a scope that
  // carried documents this run must not be served from (or written to) the shared cache.
  const cached = hasDocumentEvidence
    ? undefined
    : cachedGroundedPack({
        input,
        deps,
        plan,
        rings: augmentedRings,
        ordered: prepared.ordered,
        cacheIdentity,
        initialUsage: prepared.initialUsage,
        assembleOptions,
      });
  return { documentEvidence, cached, cacheIdentity, assembleOptions };
}

// PR4-W1 (ADR-0055 D1): conditional diagnostics observer. When a ContextProfile is threaded
// through OrchestratorDeps, the fully assembled pack is enriched with an additive
// `diagnostics.contextBudget?`. The observer is pure and touches no field a prompt builder reads,
// so the wire output stays byte-identical (AC5). When the profile is absent, the pack is returned
// exactly as assembled — the unchanged-guarantee for legacy callers and existing tests.
function withGroundedContextDiagnostics(
  pack: ConnectedContextPack,
  deps: OrchestratorDeps,
): ConnectedContextPack {
  if (deps.contextProfile === undefined) {
    return pack;
  }
  return attachContextBudgetDiagnostics(pack, deps.contextProfile);
}

async function assembleGroundedPack(
  args: AssembleGroundedPackInputs,
): Promise<ConnectedContextPack> {
  const { input, deps, plan, searchScope, fs, nowMs } = args;
  const augmentedRings = await augmentRingsWithDeterministicAtoms(args);
  const prepared = preparePackAssembly(input, plan, augmentedRings, nowMs);
  const ctx = await prepareGroundedAssembly(args, augmentedRings, prepared);
  if (ctx.cached !== undefined) {
    return withGroundedContextDiagnostics(ctx.cached, deps);
  }
  const excerptReads = await readKeptExcerpts(prepared.keptPaths, {
    searchScope,
    fs,
    budget: plan.budget,
    initialUsage: prepared.initialUsage,
    atomsByPath: prepared.atomsByPath,
    nowMs,
    signal: deps.signal,
  });
  const pack = await assemblePackFromReads({
    input,
    plan,
    rings: augmentedRings,
    prepared,
    excerptReads,
    documentEvidence: ctx.documentEvidence,
    cacheIdentity: ctx.cacheIdentity,
    assembleOptions: ctx.assembleOptions,
  });
  return withGroundedContextDiagnostics(pack, deps);
}

// ─── Public entry ─────────────────────────────────────────────────────────────

// Epic #532 — retrieval-only pipeline: the ready-governed plan, workspace detection, ring run,
// and pack assembly (the original steps 1–4) WITHOUT the model answer. `deps.answerer` is part of
// the shared deps type but is intentionally not invoked here; the multi-source path answers once
// over the merged packs rather than per source.
export async function retrieveConnectedContextPack(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<RetrievalOnlyOutput> {
  const fs = deps.fs ?? nodeWorkspaceFs;
  const detect = deps.detectWorkspace ?? detectWorkspaceAt;
  const nowMs = deps.nowMs ?? Date.now;
  const start = nowMs();
  throwIfCancelled(deps.signal);

  const { plan, governor } = createReadyGovernedPlan(input, nowMs);
  deps.recordPlan?.(plan);
  throwIfCancelled(deps.signal);

  const blockedByReadBudget = readBudgetStopReason(plan.budget);
  if (blockedByReadBudget !== undefined) {
    const pack = await assembleEmptyGroundedPack({
      input,
      deps,
      plan,
      governor,
      nowMs,
      stopReason: blockedByReadBudget,
    });
    throwIfCancelled(deps.signal);
    return { pack, elapsedMs: Math.max(0, nowMs() - start), plan };
  }

  const workspace = detect(input.workspaceRoot, fs);
  const searchScope = buildSearchScope(input.scope, workspace);
  const rings = await runAllRings(
    plan.rings,
    {
      searchScope,
      query: input.query,
      anchors: plan.anchors,
      retrievalIntent: plan.retrievalIntent,
      fs,
      nowMs,
      signal: deps.signal,
    },
    governor,
  );
  throwIfCancelled(deps.signal);
  const pack = await assembleGroundedPack({ input, deps, plan, rings, searchScope, fs, nowMs });
  throwIfCancelled(deps.signal);
  return { pack, elapsedMs: Math.max(0, nowMs() - start), plan };
}

export async function runGroundedExploration(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<OrchestratorOutput> {
  // AC5 (#532): the single-source path measures its OWN total wall time (retrieval + answer) so the
  // observable elapsedMs is byte-identical to before this split. The retrieval-only elapsed returned
  // by retrieveConnectedContextPack is deliberately discarded here.
  const nowMs = deps.nowMs ?? Date.now;
  const start = nowMs();
  const { pack, plan } = await retrieveConnectedContextPack(input, deps);
  const answer = normalizeGroundedAnswerPayload(await deps.answerer.answer(input.query.text, pack));
  const elapsedMs = Math.max(0, nowMs() - start);
  const exhaustedAnswerDimensions = [
    ...(answer.usage.promptTokens > pack.budget.modelInputTokensMax ? ["modelInputTokens"] : []),
    ...(answer.usage.completionTokens > pack.budget.modelOutputTokensMax
      ? ["modelOutputTokens"]
      : []),
    ...(elapsedMs > pack.budget.elapsedMsMax ? ["elapsedMs"] : []),
  ];
  const groundedPack: ConnectedContextPack = {
    ...pack,
    usage: {
      ...pack.usage,
      modelInputTokens: Math.min(answer.usage.promptTokens, pack.budget.modelInputTokensMax),
      modelOutputTokens: Math.min(answer.usage.completionTokens, pack.budget.modelOutputTokensMax),
      elapsedMs: Math.min(Math.max(pack.usage.elapsedMs, elapsedMs), pack.budget.elapsedMsMax),
    },
    uncertainty:
      exhaustedAnswerDimensions.length === 0
        ? pack.uncertainty
        : [...pack.uncertainty, answerBudgetClipped(exhaustedAnswerDimensions, nowMs())],
  };
  return { pack: groundedPack, assistantContent: answer.content, elapsedMs, plan };
}

// Re-export DEFAULT_SEARCH_LIMITS for parity with #179 callers that import limits via the
// orchestrator. Keeps `grounded-qa.ts` from needing a second workspace import path.
export { DEFAULT_SEARCH_LIMITS };
