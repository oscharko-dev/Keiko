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

function matchingExcerpt(
  message: ChatMessage,
  terms: readonly string[],
  secrets: readonly string[],
): string | undefined {
  const safe = stripUnsafeFormatChars(redact(message.content, secrets)).normalize("NFKC");
  const hits = terms.map((term) => lastTermOffset(safe, term)).filter((offset) => offset >= 0);
  if (hits.length === 0) return undefined;
  const latestHit = Math.max(...hits);
  const paragraphStart = safe.lastIndexOf("\n", latestHit) + 1;
  const start = latestHit - paragraphStart < 480 ? paragraphStart : Math.max(0, latestHit - 360);
  const excerpt = safe.slice(start, start + 480).replace(/\s+/gu, " ");
  return containsPseudoRoleMarker(excerpt) || containsAbsolutePath(excerpt) ? undefined : excerpt;
}

function lastTermOffset(source: string, term: string): number {
  // queryTerms emits only Unicode letters, so these short patterns have no regex operators.
  let last = -1;
  for (const match of source.matchAll(new RegExp(term, "giu"))) last = match.index;
  return last;
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
  const excerpt = rehydrateMessage(
    message.id,
    {
      messages: {
        read: (id) =>
          id === message.id ? matchingExcerpt(source, input.terms, input.secrets) : undefined,
      },
    },
    2_000,
  ).content;
  if (excerpt !== undefined)
    selectCandidate(state.candidates, message, excerpt, input.terms, state.order);
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
