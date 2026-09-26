import { clampUnit } from "@oscharko-dev/keiko-contracts/runtime/numeric";
import type {
  CandidateSignal,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";

export const SEMANTIC_SEARCH_TOOL_PREFIX = "repo.semanticSearch";
export const SEMANTIC_RRF_K = 60;

export interface SemanticSearchDocument {
  readonly scopePath: string;
  readonly text: string;
}

export interface SemanticSearchMatch {
  readonly scopePath: string;
  readonly score: number;
  readonly line?: number | undefined;
}

export interface SemanticSearchInput {
  readonly query: RetrievalQuery;
  readonly documents: readonly SemanticSearchDocument[];
  readonly signal?: AbortSignal | undefined;
}

export interface SemanticSearchProvider {
  readonly name: string;
  readonly search: (input: SemanticSearchInput) => Promise<readonly SemanticSearchMatch[]>;
}

export interface SemanticSearchSession {
  readonly provider: SemanticSearchProvider;
  readonly documents: SemanticSearchDocument[];
}

export interface SemanticSearchExecutionOptions {
  readonly timeoutMs?: number | undefined;
  readonly onTimeout?: (() => void) | undefined;
}

export interface SemanticFusionSignals {
  readonly scopePath: string;
  readonly lexicalRank: number | undefined;
  readonly semanticRank: number | undefined;
  readonly lexicalContribution: number;
  readonly semanticContribution: number;
  readonly fusedScore: number;
  readonly normalizedFusedScore: number;
  readonly signals: readonly CandidateSignal[];
}

interface RankedPath {
  readonly scopePath: string;
  readonly score: number;
}

interface SemanticSearchExecution {
  readonly signal: AbortSignal;
  readonly timeout: ReturnType<typeof setTimeout> | undefined;
  readonly state: { timedOut: boolean };
}

interface SemanticAbortWait {
  readonly promise: Promise<readonly SemanticSearchMatch[]>;
  readonly removeListener: () => void;
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function contribution(rank: number | undefined): number {
  return rank === undefined ? 0 : 1 / (SEMANTIC_RRF_K + rank);
}

function comparePath(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function pathRanks(paths: readonly RankedPath[]): ReadonlyMap<string, number> {
  const sorted = [...paths].sort(
    (a, b) => b.score - a.score || comparePath(a.scopePath, b.scopePath),
  );
  return new Map(sorted.map((entry, index) => [entry.scopePath, index + 1]));
}

function isSafeProviderNameChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "0" && char <= "9") ||
    char === "_" ||
    char === "." ||
    char === ":" ||
    char === "-"
  );
}

function stripEdgeHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.codePointAt(start) === 45) start += 1;
  while (end > start && value.codePointAt(end - 1) === 45) end -= 1;
  return value.slice(start, end);
}

function safeProviderName(name: string): string {
  let cleaned = "";
  let pendingSeparator = false;
  for (const char of name.toLowerCase()) {
    if (isSafeProviderNameChar(char)) {
      if (pendingSeparator && cleaned.length > 0) cleaned += "-";
      cleaned += char;
      pendingSeparator = false;
    } else {
      pendingSeparator = true;
    }
  }
  cleaned = stripEdgeHyphens(cleaned);
  return cleaned.length === 0 ? "unnamed" : cleaned;
}

function validMatch(
  match: SemanticSearchMatch,
  documentsByPath: ReadonlyMap<string, SemanticSearchDocument>,
): boolean {
  return (
    documentsByPath.has(match.scopePath) &&
    Number.isFinite(match.score) &&
    match.score > 0 &&
    (match.line === undefined || (Number.isInteger(match.line) && match.line > 0))
  );
}

export function createSemanticSearchSession(
  provider: SemanticSearchProvider | undefined,
  query: RetrievalQuery,
): SemanticSearchSession | undefined {
  if (provider === undefined || query.kind === "regex" || query.kind === "file-pattern") {
    return undefined;
  }
  return { provider, documents: [] };
}

export function collectSemanticSearchDocument(
  session: SemanticSearchSession | undefined,
  document: SemanticSearchDocument,
): void {
  session?.documents.push(document);
}

export function semanticSearchTool(providerName: string): string {
  return `${SEMANTIC_SEARCH_TOOL_PREFIX}:${safeProviderName(providerName)}`;
}

function startSemanticSearchExecution(
  signal: AbortSignal | undefined,
  options: SemanticSearchExecutionOptions,
): SemanticSearchExecution {
  const controller = new AbortController();
  const effectiveSignal =
    signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  const state = { timedOut: false };
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => {
            state.timedOut = true;
            options.onTimeout?.();
            controller.abort();
          },
          Math.min(Math.ceil(options.timeoutMs), 2_147_483_647),
        );
  timeout?.unref();
  return { signal: effectiveSignal, timeout, state };
}

function waitForSemanticAbort(signal: AbortSignal): SemanticAbortWait {
  let removeListener = (): void => undefined;
  const promise = new Promise<readonly SemanticSearchMatch[]>((resolve) => {
    const onAbort = (): void => {
      resolve([]);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    if (signal.aborted) onAbort();
  });
  return { promise, removeListener };
}

function normalizeSemanticMatches(
  matches: readonly SemanticSearchMatch[],
  documents: readonly SemanticSearchDocument[],
): readonly SemanticSearchMatch[] {
  const documentsByPath = new Map(documents.map((document) => [document.scopePath, document]));
  return matches
    .filter((match) => validMatch(match, documentsByPath))
    .map((match) => ({ ...match, score: clampUnit(match.score) }))
    .sort(
      (a, b) =>
        b.score - a.score || comparePath(a.scopePath, b.scopePath) || (a.line ?? 0) - (b.line ?? 0),
    );
}

function canRunSemanticSearch(
  session: SemanticSearchSession | undefined,
  signal: AbortSignal | undefined,
): session is SemanticSearchSession {
  return session !== undefined && session.documents.length > 0 && signal?.aborted !== true;
}

function timeoutElapsedBeforeStart(options: SemanticSearchExecutionOptions): boolean {
  if (options.timeoutMs === undefined || options.timeoutMs > 0) {
    return false;
  }
  options.onTimeout?.();
  return true;
}

function semanticExecutionStopped(execution: SemanticSearchExecution): boolean {
  return execution.state.timedOut || execution.signal.aborted;
}

function finishSemanticSearchExecution(
  execution: SemanticSearchExecution,
  abortWait: SemanticAbortWait,
): void {
  if (execution.timeout !== undefined) clearTimeout(execution.timeout);
  abortWait.removeListener();
}

export async function runSemanticSearchSession(
  session: SemanticSearchSession | undefined,
  query: RetrievalQuery,
  signal: AbortSignal | undefined,
  options: SemanticSearchExecutionOptions = {},
): Promise<readonly SemanticSearchMatch[]> {
  if (!canRunSemanticSearch(session, signal)) {
    return [];
  }
  if (timeoutElapsedBeforeStart(options)) {
    return [];
  }
  const execution = startSemanticSearchExecution(signal, options);
  const abortWait = waitForSemanticAbort(execution.signal);
  try {
    const provider = session.provider
      .search({ query, documents: session.documents, signal: execution.signal })
      .catch(() => []);
    const matches = await Promise.race([provider, abortWait.promise]);
    if (semanticExecutionStopped(execution)) return [];
    return normalizeSemanticMatches(matches, session.documents);
  } catch {
    return [];
  } finally {
    finishSemanticSearchExecution(execution, abortWait);
  }
}

export function fuseLexicalAndSemanticRanks(
  lexical: readonly RankedPath[],
  semantic: readonly RankedPath[],
): readonly SemanticFusionSignals[] {
  const lexicalRanks = pathRanks(lexical);
  const semanticRanks = pathRanks(semantic);
  const paths = new Set([...lexicalRanks.keys(), ...semanticRanks.keys()]);
  const maxContribution = 2 / (SEMANTIC_RRF_K + 1);
  return [...paths]
    .map((scopePath) => {
      const lexicalRank = lexicalRanks.get(scopePath);
      const semanticRank = semanticRanks.get(scopePath);
      const lexicalContribution = contribution(lexicalRank);
      const semanticContribution = contribution(semanticRank);
      const fusedScore = quantize(lexicalContribution + semanticContribution);
      return {
        scopePath,
        lexicalRank,
        semanticRank,
        lexicalContribution: quantize(lexicalContribution),
        semanticContribution: quantize(semanticContribution),
        fusedScore,
        normalizedFusedScore: quantize(fusedScore / maxContribution),
        signals: [
          { name: "rrf:lexical", value: quantize(lexicalContribution) },
          { name: "rrf:semantic", value: quantize(semanticContribution) },
          { name: "rrf:fused", value: fusedScore },
        ],
      };
    })
    .sort(
      (a, b) =>
        b.fusedScore - a.fusedScore ||
        b.semanticContribution - a.semanticContribution ||
        comparePath(a.scopePath, b.scopePath),
    );
}
