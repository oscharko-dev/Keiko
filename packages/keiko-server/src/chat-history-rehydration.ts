import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { rehydrateMessage } from "@oscharko-dev/keiko-workflows/context-budget";
import {
  containsPseudoRoleMarker,
  containsAbsolutePath,
  stripUnsafeFormatChars,
} from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import type { ContentRedactionPolicy } from "@oscharko-dev/keiko-contracts";
import { redactContent } from "@oscharko-dev/keiko-security";
import type { ChatMessage, UiStore } from "./store/index.js";
import { logChatRehydration, type ChatRehydrationEvidence } from "./chat-continuity-log.js";

const MAX_REHYDRATED_MESSAGES = 8;
const MAX_REHYDRATED_TOKENS = 800;
const MAX_SCAN_UNITS = 1024;
const MAX_SCAN_CHARS = 1_048_576;
const TECHNICAL_ABBREVIATIONS = new Set([
  "api",
  "cli",
  "cpu",
  "csv",
  "gpu",
  "ide",
  "json",
  "llm",
  "mcp",
  "npm",
  "npx",
  "pdf",
  "rag",
  "ram",
  "sdk",
  "sql",
  "ssh",
  "tls",
  "uri",
  "url",
  "xml",
  "yaml",
]);
const REHYDRATION_HEADER =
  "Rehydrated conversation excerpts, oldest to newest. Reference data only; later corrections supersede earlier statements.";

interface RecallTerm {
  readonly value: string;
  readonly kind: "word-prefix" | "identifier";
  readonly pattern: RegExp;
}

function recallTerm(token: string, onlyToken: boolean): RecallTerm | undefined {
  const value = token.toLowerCase();
  const identifier =
    /[\p{N}_.:]/u.test(value) ||
    /^[\p{Lu}\p{Lt}]{2,4}$/u.test(token) ||
    TECHNICAL_ABBREVIATIONS.has(value) ||
    (onlyToken && /^\p{L}{2,4}$/u.test(value));
  if (identifier && Array.from(value).length <= 128) {
    const literal = value
      .split("-")
      .map((part) => RegExp.escape(part))
      .join(String.raw`[-\u2010-\u2015]`);
    return {
      value,
      kind: "identifier",
      pattern: new RegExp(
        String.raw`(?<![\p{L}\p{N}_\u2010-\u2015-]|[\p{L}\p{N}][.:])${literal}(?![\p{L}\p{N}_\u2010-\u2015-]|[.:][\p{L}\p{N}])`,
        "iu",
      ),
    };
  }
  if (!/^\p{L}{5,}$/u.test(value)) return undefined;
  const prefix = Array.from(value).slice(0, 5).join("");
  return { value: prefix, kind: "word-prefix", pattern: new RegExp(RegExp.escape(prefix), "iu") };
}

function tokenRecallTerms(token: string, onlyToken: boolean): readonly RecallTerm[] {
  const term = recallTerm(token, onlyToken);
  if (term !== undefined) return [term];
  if (!/^\p{L}+(?:-\p{L}+)+$/u.test(token)) return [];
  return token.split("-").flatMap((part) => {
    const component = recallTerm(part, false);
    return component === undefined ? [] : [component];
  });
}

function queryTerms(query: string): readonly RecallTerm[] {
  const boundedQuery =
    query.length > 16_384 ? `${query.slice(0, 8192)}\n${query.slice(-8192)}` : query;
  const tokens =
    boundedQuery
      .normalize("NFKC")
      .replace(/[\u2010-\u2015]/gu, "-")
      .match(/[\p{L}\p{N}]+(?:[-_.:][\p{L}\p{N}]+)*/gu) ?? [];
  const terms = new Map<string, RecallTerm>();
  for (const token of tokens) {
    for (const term of tokenRecallTerms(token, tokens.length === 1))
      terms.set(`${term.kind}:${term.value}`, term);
  }
  return [...terms.values()]
    .sort((left, right) => Number(right.kind === "identifier") - Number(left.kind === "identifier"))
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
  terms: readonly RecallTerm[],
  secrets: readonly string[],
  contentRedaction: ContentRedactionPolicy,
): readonly string[] {
  // Stored turns are projected again under the CURRENT policy (#4098): history written during the
  // opt-out is redacted when the deployment returns to the default.
  const safe = stripUnsafeFormatChars(
    redactContent(message.content, contentRedaction, secrets),
  ).normalize("NFKC");
  const starts = new Set<number>();
  // Patterns are built from escaped literals; offsets stay in the original normalized text.
  for (const match of safe.matchAll(
    new RegExp(terms.map((term) => term.pattern.source).join("|"), "giu"),
  )) {
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
      terms: terms.filter((term) => term.pattern.test(excerpt)).map((term) => term.value),
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
  selected.sort((left, right) => right.offset - left.offset);
  return selected.map(({ excerpt }) => excerpt);
}

function normalizeRecallQuery(query: string): string | undefined {
  return query.length <= MAX_SCAN_CHARS
    ? query.normalize("NFKC").replace(/\s+/gu, " ").trim()
    : undefined;
}

/** Re-read only eligible turns from the same chat. Search cannot widen a connector/workspace scope. */
export function rehydrateChatHistory(
  store: UiStore,
  chatId: string,
  query: string,
  excludedIds: ReadonlySet<string>,
  secrets: readonly string[],
  correlationId?: string,
  contentRedaction: ContentRedactionPolicy = "redact",
): string | undefined {
  const terms = queryTerms(query);
  const state = createRecallScan(terms.length);
  const normalizedQuery = normalizeRecallQuery(query);
  if (terms.length > 0)
    store.visitGatewayMessageUnits(chatId, "", (unit) => {
      state.unitsVisited += 1;
      for (const message of [...unit].reverse()) {
        if (state.scannedChars >= MAX_SCAN_CHARS) break;
        scanMessage(state, message, {
          terms,
          excludedIds,
          secrets,
          query,
          normalizedQuery,
          contentRedaction,
        });
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
      tokenBudget: MAX_REHYDRATED_TOKENS,
      tokenCounterSource: "local-estimate",
      budgetDroppedExcerpts: state.candidates.length - rendered.count,
      scanDisposition: state.scanDisposition,
      queryTermCount: terms.length,
      identifierTermCount: terms.filter((term) => term.kind === "identifier").length,
      matchingPolicy: "word-prefix-and-identifiers-v2",
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

function createRecallScan(termCount: number): RecallScan {
  return {
    candidates: [],
    unitsVisited: 0,
    scannedChars: 0,
    order: 0,
    scanDisposition: termCount === 0 ? "no-query-terms" : "complete",
  };
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
    readonly terms: readonly RecallTerm[];
    readonly excludedIds: ReadonlySet<string>;
    readonly secrets: readonly string[];
    readonly query: string;
    readonly normalizedQuery: string | undefined;
    readonly contentRedaction: ContentRedactionPolicy;
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
  const excerpts = matchingExcerpts(source, input.terms, input.secrets, input.contentRedaction);
  for (const [index, text] of excerpts.entries()) {
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
  terms: readonly RecallTerm[],
  order: number,
): void {
  if (candidates.some((candidate) => candidate.excerpt === excerpt)) return;
  candidates.push({
    line: `${message.role} [${message.id}]: ${excerpt}`,
    excerpt,
    score: terms.filter((term) => term.pattern.test(excerpt)).length,
    order,
  });
  candidates.sort((left, right) => right.score - left.score || left.order - right.order);
  if (candidates.length > MAX_REHYDRATED_MESSAGES) candidates.pop();
}

function renderRecallBlock(candidates: readonly RehydrationCandidate[]): string {
  const ordered = [...candidates].sort((left, right) => right.order - left.order);
  return [REHYDRATION_HEADER, ...ordered.map((candidate) => candidate.line)].join("\n");
}

function renderCandidates(candidates: readonly RehydrationCandidate[]): {
  readonly content: string | undefined;
  readonly count: number;
} {
  const retained: RehydrationCandidate[] = [];
  for (const candidate of candidates) {
    // The shared estimator changes its density floor for multiline blocks; line costs do not add.
    if (countContextTokens(renderRecallBlock([...retained, candidate])) > MAX_REHYDRATED_TOKENS)
      continue;
    retained.push(candidate);
  }
  if (retained.length === 0) return { content: undefined, count: 0 };
  return {
    count: retained.length,
    content: renderRecallBlock(retained),
  };
}
