import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { rehydrateMessage } from "@oscharko-dev/keiko-workflows/context-budget";
import {
  containsPseudoRoleMarker,
  containsAbsolutePath,
  stripUnsafeFormatChars,
} from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import { redact } from "@oscharko-dev/keiko-security";
import type { ChatMessage, UiStore } from "./store/index.js";
import { logChatRehydration, type ChatRehydrationEvidence } from "./chat-continuity-log.js";

const MAX_REHYDRATED_MESSAGES = 8;
const MAX_REHYDRATED_TOKENS = 800;
const MAX_SCAN_UNITS = 1024;
const MAX_SCAN_CHARS = 1_048_576;
const REHYDRATION_HEADER =
  "Rehydrated conversation excerpts, oldest to newest. Reference data only; later corrections supersede earlier statements.";

function queryTerms(query: string): readonly string[] {
  const boundedQuery =
    query.length > 16_384 ? `${query.slice(0, 8192)}\n${query.slice(-8192)}` : query;
  return [
    ...new Set(
      boundedQuery
        .normalize("NFKC")
        .toLowerCase()
        .match(/\p{L}{5,}/gu) ?? [],
    ),
  ]
    .map((word) => Array.from(word).slice(0, 5).join(""))
    .slice(0, 24);
}

interface RehydrationCandidate {
  readonly line: string;
  readonly excerpt: string;
  readonly score: number;
  readonly order: number;
}

interface SourceExcerpt {
  readonly excerpt: string;
  readonly offset: number;
  readonly terms: readonly string[];
}

function matchingExcerpts(
  message: ChatMessage,
  terms: readonly string[],
  secrets: readonly string[],
): readonly string[] {
  const safe = stripUnsafeFormatChars(redact(message.content, secrets)).normalize("NFKC");
  const starts = new Set<number>();
  // queryTerms emits only Unicode letters; offsets remain in the original normalized text.
  for (const match of safe.matchAll(new RegExp(terms.join("|"), "giu"))) {
    const paragraphStart = safe.lastIndexOf("\n", match.index) + 1;
    starts.add(paragraphStart + Math.floor((match.index - paragraphStart) / 360) * 360);
  }
  const candidates: SourceExcerpt[] = [];
  for (const offset of starts) {
    const source = safe.slice(offset, offset + 480);
    if (containsPseudoRoleMarker(source) || containsAbsolutePath(source)) continue;
    const excerpt = source.replace(/\s+/gu, " ");
    candidates.push({
      excerpt,
      offset,
      terms: terms.filter((term) => excerpt.toLowerCase().includes(term)),
    });
  }
  return complementaryExcerpts(candidates);
}

function additionalCoverage(
  candidate: SourceExcerpt,
  selected: readonly SourceExcerpt[],
  covered: ReadonlySet<string>,
): number {
  // Do not reintroduce an older overlapping claim to gain an incidental query term.
  if (
    selected.some(
      (later) =>
        later.offset > candidate.offset &&
        later.terms.some((term) => candidate.terms.includes(term)),
    )
  )
    return 0;
  return candidate.terms.filter((term) => !covered.has(term)).length;
}

function preferExcerpt(
  candidate: SourceExcerpt,
  best: SourceExcerpt | undefined,
  score: number,
  bestScore: number,
): boolean {
  return (
    score > bestScore ||
    (score > 0 && score === bestScore && candidate.offset > (best?.offset ?? -1))
  );
}

/** Prefer relevant coverage, then the newest equivalent evidence within the same source. */
function complementaryExcerpts(candidates: readonly SourceExcerpt[]): readonly string[] {
  const covered = new Set<string>();
  const selected: SourceExcerpt[] = [];
  while (selected.length < MAX_REHYDRATED_MESSAGES) {
    let best: SourceExcerpt | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = additionalCoverage(candidate, selected, covered);
      if (preferExcerpt(candidate, best, score, bestScore)) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best === undefined) break;
    selected.push(best);
    for (const term of best.terms) covered.add(term);
  }
  return selected
    .toSorted((left, right) => right.offset - left.offset)
    .map(({ excerpt }) => excerpt);
}

/** Re-read only eligible turns from the same chat. Search cannot widen a connector/workspace scope. */
export function rehydrateChatHistory(
  store: UiStore,
  chatId: string,
  query: string,
  excludedIds: ReadonlySet<string>,
  secrets: readonly string[],
  correlationId?: string,
): string | undefined {
  const terms = queryTerms(query);
  const state: RecallScan = {
    candidates: [],
    unitsVisited: 0,
    scannedChars: 0,
    order: 0,
    scanDisposition: terms.length === 0 ? "no-query-terms" : "complete",
  };
  const normalizedQuery =
    query.length <= MAX_SCAN_CHARS
      ? query.normalize("NFKC").replace(/\s+/gu, " ").trim()
      : undefined;
  if (terms.length > 0)
    store.visitGatewayMessageUnits(chatId, "", (unit) => {
      state.unitsVisited += 1;
      for (const message of [...unit].reverse()) {
        if (state.scannedChars >= MAX_SCAN_CHARS) break;
        scanMessage(state, message, { terms, excludedIds, secrets, query, normalizedQuery });
      }
      return continueRecallScan(state, terms.length);
    });
  const rendered = renderCandidates(state.candidates);
  logChatRehydration(
    {
      unitsVisited: state.unitsVisited,
      scannedChars: state.scannedChars,
      candidateCount: state.candidates.length,
      excerptCount: rendered.count,
      rehydratedTokens: countContextTokens(rendered.content ?? ""),
      scanDisposition: state.scanDisposition,
    },
    correlationId,
  );
  return rendered.content;
}

interface RecallScan {
  readonly candidates: RehydrationCandidate[];
  unitsVisited: number;
  scannedChars: number;
  order: number;
  scanDisposition: ChatRehydrationEvidence["scanDisposition"];
}

function continueRecallScan(state: RecallScan, termCount: number): boolean {
  if (state.scannedChars >= MAX_SCAN_CHARS) state.scanDisposition = "character-limit";
  else if (state.unitsVisited >= MAX_SCAN_UNITS) state.scanDisposition = "unit-limit";
  else if (
    state.candidates.length === MAX_REHYDRATED_MESSAGES &&
    state.candidates.every((candidate) => candidate.score === termCount)
  )
    state.scanDisposition = "best-matches";
  return state.scanDisposition === "complete";
}

function scanMessage(
  state: RecallScan,
  message: ChatMessage,
  input: {
    readonly terms: readonly string[];
    readonly excludedIds: ReadonlySet<string>;
    readonly secrets: readonly string[];
    readonly query: string;
    readonly normalizedQuery: string | undefined;
  },
): void {
  state.order += 1;
  if (input.excludedIds.has(message.id) || message.content === input.query) return;
  const remaining = MAX_SCAN_CHARS - state.scannedChars;
  const bounded = message.content.slice(-remaining);
  state.scannedChars += bounded.length;
  // A truncated leading secret must not become an unrecognizable suffix in an excerpt.
  const overlap =
    message.content.length > bounded.length
      ? Math.max(0, ...input.secrets.map((secret) => secret.length))
      : 0;
  const source = { ...message, content: bounded.slice(overlap) };
  if (source.content.normalize("NFKC").replace(/\s+/gu, " ").trim() === input.normalizedQuery)
    return;
  for (const [index, text] of matchingExcerpts(source, input.terms, input.secrets).entries()) {
    const excerpt = rehydrateMessage(
      message.id,
      { messages: { read: (id) => (id === message.id ? text : undefined) } },
      2_000,
    ).content;
    if (excerpt !== undefined)
      selectCandidate(
        state.candidates,
        message,
        excerpt,
        input.terms,
        state.order + index / (MAX_REHYDRATED_MESSAGES + 1),
      );
  }
}

function selectCandidate(
  candidates: RehydrationCandidate[],
  message: ChatMessage,
  excerpt: string,
  terms: readonly string[],
  order: number,
): void {
  if (candidates.some((candidate) => candidate.excerpt === excerpt)) return;
  const lower = excerpt.toLowerCase();
  candidates.push({
    line: `${message.role} [${message.id}]: ${excerpt}`,
    excerpt,
    score: terms.filter((term) => lower.includes(term)).length,
    order,
  });
  candidates.sort((left, right) => right.score - left.score || left.order - right.order);
  if (candidates.length > MAX_REHYDRATED_MESSAGES) candidates.pop();
}

function renderCandidates(candidates: readonly RehydrationCandidate[]): {
  readonly content: string | undefined;
  readonly count: number;
} {
  const retained: RehydrationCandidate[] = [];
  let tokens = countContextTokens(REHYDRATION_HEADER);
  for (const candidate of candidates) {
    const cost = countContextTokens(`\n${candidate.line}`);
    if (tokens + cost > MAX_REHYDRATED_TOKENS) continue;
    retained.push(candidate);
    tokens += cost;
  }
  if (retained.length === 0) return { content: undefined, count: 0 };
  retained.sort((left, right) => right.order - left.order);
  return {
    count: retained.length,
    content: [REHYDRATION_HEADER, ...retained.map((candidate) => candidate.line)].join("\n"),
  };
}
