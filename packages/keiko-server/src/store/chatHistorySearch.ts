import type { DatabaseSync } from "node:sqlite";
import type {
  GatewayHistorySearchResult,
  GatewayHistorySearchTerm,
  GatewayHistoryVisitor,
} from "./types.js";
import { gatewaySearchAdmissionSql, visitGatewaySearchCandidates } from "./messages.js";

const CANDIDATES_PER_INDEX = 64;
const MATCH_KINDS: ReadonlySet<string> = new Set(["word-prefix", "identifier"]);
type IndexName = "chat_history_words" | "chat_history_fragments";
interface SearchHit {
  readonly rowid: number;
  readonly timestamp: number;
}

function validateTerms(terms: readonly GatewayHistorySearchTerm[]): void {
  if (terms.length > 24) throw new TypeError("Too many history search terms.");
  for (const term of terms) {
    if (term.value.length > 256 || !/^[\p{L}\p{N}]+(?:[-_.:][\p{L}\p{N}]+)*$/u.test(term.value))
      throw new TypeError("Invalid history search term.");
    if (!MATCH_KINDS.has(term.kind)) throw new TypeError("Invalid history search match kind.");
  }
}

function expression(terms: readonly GatewayHistorySearchTerm[], fragments: boolean): string {
  return terms
    .filter((term) => !fragments || Array.from(term.value).length >= 3)
    .map((term) => `"${term.value}"${!fragments && term.kind === "word-prefix" ? "*" : ""}`)
    .join(" OR ");
}

function hits(
  db: DatabaseSync,
  chatId: string,
  name: IndexName,
  query: string,
): readonly SearchHit[] {
  if (query.length === 0) return [];
  // The index name is a closed server-owned constant; all source and chat values are parameters.
  return db
    .prepare(
      `SELECT m.rowid AS rowid, m.timestamp FROM ${name}
    JOIN chat_messages m ON m.rowid = ${name}.rowid
    WHERE ${name} MATCH ? AND m.chat_id = ? AND m.role IN ('user', 'assistant')
      AND ${gatewaySearchAdmissionSql()}
    ORDER BY ${name}.rank, m.timestamp DESC, m.rowid DESC LIMIT ?`,
    )
    .all(query, chatId, CANDIDATES_PER_INDEX + 1) as unknown as SearchHit[];
}

function mergeHits(groups: readonly (readonly SearchHit[])[]): readonly number[] {
  const selected = new Map<number, SearchHit & { readonly priority: number }>();
  for (const group of groups) {
    for (const [priority, hit] of group.slice(0, CANDIDATES_PER_INDEX).entries()) {
      const previous = selected.get(hit.rowid);
      if (previous === undefined || priority < previous.priority)
        selected.set(hit.rowid, { ...hit, priority });
    }
  }
  return [...selected.values()]
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        right.timestamp - left.timestamp ||
        right.rowid - left.rowid,
    )
    .map((hit) => hit.rowid);
}

export function searchGatewayMessageUnits(
  db: DatabaseSync,
  chatId: string,
  terms: readonly GatewayHistorySearchTerm[],
  visit: GatewayHistoryVisitor,
): GatewayHistorySearchResult {
  validateTerms(terms);
  const groups = [
    hits(db, chatId, "chat_history_words", expression(terms, false)),
    hits(db, chatId, "chat_history_fragments", expression(terms, true)),
  ];
  const rowids = mergeHits(groups);
  return {
    candidateRows: rowids.length,
    indexLimitReached: groups.some((group) => group.length > CANDIDATES_PER_INDEX),
    ...visitGatewaySearchCandidates(db, chatId, rowids, visit),
  };
}
