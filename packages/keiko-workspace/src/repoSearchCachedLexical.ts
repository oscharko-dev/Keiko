import { createHash } from "node:crypto";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { naturalLanguageContentTermGroups } from "./repoSearchMatchers.js";
import { repositoryRouteDeclarationMarker } from "./repoSearchRoutes.js";
import type { ScoredLine } from "./repoSearchLineSelection.js";
import {
  contentTermGroupsForSearch,
  routeQueryTermsForSearch,
  scoreContentHitsForSearch,
  type RouteQueryTerms,
  type SearchPolicy,
} from "./repoSearchPolicy.js";
import type { PreparedWorkspaceIndexEntry, WorkspaceIndexLexicalRecord } from "./workspaceIndex.js";

interface CachedHashGroup {
  readonly hashes: ReadonlySet<string>;
  readonly structuredHashes: ReadonlySet<string>;
}

interface CachedRouteQuery {
  readonly declarationMarkerHash: string;
}

export interface CachedLexicalQuery {
  readonly lineGroups: readonly CachedHashGroup[];
  readonly contentGroups: readonly CachedHashGroup[];
  readonly exactSymbolHash: string | undefined;
  readonly route: CachedRouteQuery | undefined;
}

function hashTerm(term: string): string {
  return createHash("sha256").update(term.toLowerCase()).digest("hex");
}

function hashGroups(groups: readonly (readonly string[])[]): readonly CachedHashGroup[] {
  return groups.map((group) => ({
    hashes: new Set(group.map(hashTerm)),
    structuredHashes: new Set(group.filter((term) => term.includes("/")).map(hashTerm)),
  }));
}

function lineTermGroups(query: RetrievalQuery): readonly (readonly string[])[] {
  return query.kind === "exact-symbol"
    ? [[query.text.toLowerCase()]]
    : naturalLanguageContentTermGroups(query.text, false);
}

function cachedRouteQuery(route: RouteQueryTerms | undefined): CachedRouteQuery | undefined {
  if (route === undefined) return undefined;
  return {
    declarationMarkerHash: hashTerm(repositoryRouteDeclarationMarker(route.method, route.path)),
  };
}

export function prepareCachedLexicalQuery(query: RetrievalQuery): CachedLexicalQuery | undefined {
  if (query.kind === "regex" || query.kind === "file-pattern" || query.caseSensitive) {
    return undefined;
  }
  const lineGroups = hashGroups(lineTermGroups(query));
  if (lineGroups.length === 0) return undefined;
  return {
    lineGroups,
    contentGroups: hashGroups(contentTermGroupsForSearch(query)),
    exactSymbolHash: query.kind === "exact-symbol" ? hashTerm(query.text) : undefined,
    route: cachedRouteQuery(routeQueryTermsForSearch(query)),
  };
}

function intersects(hashes: ReadonlySet<string>, expected: ReadonlySet<string>): boolean {
  for (const hash of expected) {
    if (hashes.has(hash)) return true;
  }
  return false;
}

function matchedGroupCounts(
  termHashes: readonly string[],
  groups: readonly CachedHashGroup[],
): { readonly exactHits: number; readonly structuredHits: number } {
  const hashes = new Set(termHashes);
  let exactHits = 0;
  let structuredHits = 0;
  for (const group of groups) {
    if (intersects(hashes, group.hashes)) exactHits += 1;
    if (intersects(hashes, group.structuredHashes)) structuredHits += 1;
  }
  return { exactHits, structuredHits };
}

function cachedRouteDeclarationMatches(
  record: WorkspaceIndexLexicalRecord,
  route: CachedRouteQuery | undefined,
): boolean {
  if (route === undefined) return false;
  return record.lines.some((line) => line.termHashes.includes(route.declarationMarkerHash));
}

export function cachedExactSymbolDefinitionMatches(
  record: WorkspaceIndexLexicalRecord,
  symbolHash: string | undefined,
): boolean {
  if (symbolHash === undefined) return false;
  return record.lines.some((line) => line.definitionTermHashes?.includes(symbolHash) === true);
}

export function scoreCachedLexicalContent(
  record: WorkspaceIndexLexicalRecord,
  prepared: CachedLexicalQuery,
  policy: SearchPolicy,
): number {
  if (record.truncated) return 0;
  const hits = matchedGroupCounts(record.termHashes, prepared.contentGroups);
  return scoreContentHitsForSearch(
    policy,
    prepared.contentGroups.length,
    { ...hits, substringHits: 0 },
    prepared.exactSymbolHash !== undefined && record.termHashes.includes(prepared.exactSymbolHash),
    cachedRouteDeclarationMatches(record, prepared.route),
    cachedExactSymbolDefinitionMatches(record, prepared.exactSymbolHash),
  );
}

export function cachedLexicalRecordMatches(
  record: WorkspaceIndexLexicalRecord,
  prepared: CachedLexicalQuery,
): boolean {
  return (
    !record.truncated && matchedGroupCounts(record.termHashes, prepared.lineGroups).exactHits > 0
  );
}

export function bestCachedLexicalLines(
  record: WorkspaceIndexLexicalRecord,
  prepared: CachedLexicalQuery,
): readonly ScoredLine[] {
  const scored = record.lines.flatMap((line): readonly ScoredLine[] => {
    const hits = matchedGroupCounts(line.termHashes, prepared.lineGroups).exactHits;
    return hits === 0
      ? []
      : [
          {
            line: line.startLine,
            startLine: line.startLine,
            endLine: line.endLine,
            score: hits / prepared.lineGroups.length,
          },
        ];
  });
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.startLine - b.startLine));
  const topLines = scored.slice(0, 3);
  topLines.sort((a, b) =>
    a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
  );
  return topLines;
}

export function cachedContentScores(
  entries: readonly PreparedWorkspaceIndexEntry[],
  query: RetrievalQuery,
  policy: SearchPolicy,
): ReadonlyMap<string, number> | undefined {
  const prepared = prepareCachedLexicalQuery(query);
  if (prepared === undefined) return undefined;
  const scores = new Map<string, number>();
  for (const entry of entries) {
    const lexical = !entry.stale ? entry.record?.lexical : undefined;
    if (lexical === undefined) continue;
    const score = scoreCachedLexicalContent(lexical, prepared, policy);
    if (score > 0) scores.set(entry.scopePath, score);
  }
  return scores.size === 0 ? undefined : scores;
}
