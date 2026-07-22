import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { describe, expect, it } from "vitest";
import {
  bestCachedLexicalLines,
  cachedContentScores,
  cachedExactSymbolDefinitionMatches,
  cachedLexicalRecordMatches,
  prepareCachedLexicalQuery,
  scoreCachedLexicalContent,
} from "./repoSearchCachedLexical.js";
import { resolveSearchPolicy } from "./repoSearchPolicy.js";
import {
  buildWorkspaceIndexLexicalRecord,
  type PreparedWorkspaceIndexEntry,
  type WorkspaceIndexLexicalRecord,
} from "./workspaceIndex.js";

function query(text: string, overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 0,
    ...overrides,
  };
}

function entry(scopePath: string, content: string, stale = false): PreparedWorkspaceIndexEntry {
  return {
    scopePath,
    absolutePath: `/workspace/${scopePath}`,
    file: { relativePath: scopePath, sizeBytes: Buffer.byteLength(content, "utf8") },
    record: {
      scopePath,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      kind: "text",
      lexical: buildWorkspaceIndexLexicalRecord(content),
    },
    stale,
  };
}

describe("repoSearchCachedLexical", () => {
  it("rejects query shapes whose semantics cannot be reproduced from privacy-safe hashes", () => {
    expect(prepareCachedLexicalQuery(query(""))).toBeUndefined();
    expect(prepareCachedLexicalQuery(query("handler", { caseSensitive: true }))).toBeUndefined();
    expect(prepareCachedLexicalQuery(query("handler", { kind: "regex" }))).toBeUndefined();
    expect(prepareCachedLexicalQuery(query("*.ts", { kind: "file-pattern" }))).toBeUndefined();
  });

  it("recognizes route declarations across a bounded multiline window", () => {
    const retrieval = query("Which file registers POST /api/messages and its handler?");
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });
    const route = buildWorkspaceIndexLexicalRecord(
      'router.post(\n  "/api/messages",\n  handleMessages,\n);',
    );
    const decoy = buildWorkspaceIndexLexicalRecord('const path = "/api/messages";');

    expect(scoreCachedLexicalContent(route, prepared, retrieval, policy)).toBeGreaterThan(
      scoreCachedLexicalContent(decoy, prepared, retrieval, policy),
    );
  });

  it("distinguishes exact-symbol definitions from references", () => {
    const retrieval = query("dispatchWork", { kind: "exact-symbol" });
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;

    expect(
      cachedExactSymbolDefinitionMatches(
        buildWorkspaceIndexLexicalRecord("export function dispatchWork(): void {}"),
        prepared.exactSymbolHash,
      ),
    ).toBe(true);
    expect(
      cachedExactSymbolDefinitionMatches(
        buildWorkspaceIndexLexicalRecord("await dispatchWork();"),
        prepared.exactSymbolHash,
      ),
    ).toBe(false);
  });

  it("returns the strongest matching lines in deterministic source order", () => {
    const retrieval = query("release handler");
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const record = buildWorkspaceIndexLexicalRecord(
      ["release handler", "unrelated", "release", "release handler", "handler"].join("\n"),
    );

    expect(bestCachedLexicalLines(record, prepared)).toEqual([
      { line: 1, startLine: 1, endLine: 1, score: 1 },
      { line: 3, startLine: 3, endLine: 3, score: 0.5 },
      { line: 4, startLine: 4, endLine: 4, score: 1 },
    ]);
    expect(cachedLexicalRecordMatches(record, prepared)).toBe(true);
  });

  it("fails closed for truncated lexical records", () => {
    const retrieval = query("release handler");
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const base = buildWorkspaceIndexLexicalRecord("release handler");
    const truncated: WorkspaceIndexLexicalRecord = { ...base, truncated: true };
    const policy = resolveSearchPolicy(false, undefined);

    expect(cachedLexicalRecordMatches(truncated, prepared)).toBe(false);
    expect(scoreCachedLexicalContent(truncated, prepared, retrieval, policy)).toBe(0);
  });

  it("uses only fresh indexed entries and returns undefined without a positive score", () => {
    const retrieval = query("release handler");
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });

    expect(
      cachedContentScores(
        [
          entry("src/fresh.ts", "export const releaseHandler = true;"),
          entry("src/stale.ts", "release handler", true),
        ],
        retrieval,
        policy,
      ),
    ).toEqual(new Map([["src/fresh.ts", expect.any(Number)]]));
    expect(
      cachedContentScores([entry("src/other.ts", "unrelated")], retrieval, policy),
    ).toBeUndefined();
  });
});
