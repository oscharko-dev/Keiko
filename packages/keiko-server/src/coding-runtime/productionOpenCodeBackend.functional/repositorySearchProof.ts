// Scripted MODEL boundary for the real-binary lane: the search result and the subsequent bounded
// read are the original runtime's own `grep` and `read` tools (#3897), so the result still traverses
// the shipped runtime, its permission hook and the production workspace boundary; only the model's
// choice of what to read next is derived here, from the result and never from a fixture path.
import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

import { nativeToolResultText, nativeWorkingDirectory } from "./nativeToolTranscript.js";

export const H1_PROOF_SEARCH_CALL_ID = "h1-real-binary-search";

export interface RepositorySearchConsumptionProof {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly hitCount: number;
  readonly pathDigest: string;
  readonly snippetDigest: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly readTargetDerivedFromResult: true;
}

interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

interface SearchResult {
  readonly declared: number;
  readonly hits: readonly SearchHit[];
}

// The pinned 2.1.4 `grep` result: `Found <n> matches`, then per file its path and a colon, then
// `  Line <n>: <text>` for every match in it (observed against the staged executable).
const FOUND_HEADER = /^Found (\d+) matches?$/u;
const HIT_LINE = /^ {2}Line (\d+): (.*)$/u;

function parseSearchResult(text: string): SearchResult {
  const [header = "", ...rest] = text.split("\n");
  const declared = FOUND_HEADER.exec(header)?.[1];
  if (declared === undefined) throw new TypeError("H1 proof requires a completed search result");
  const hits: SearchHit[] = [];
  let path: string | undefined;
  for (const line of rest) {
    const match = HIT_LINE.exec(line);
    if (match !== null && path !== undefined) {
      hits.push({ path, line: Number(match[1]), text: match[2] ?? "" });
    } else if (line.endsWith(":") && !line.startsWith(" ")) {
      path = line.slice(0, -1);
    }
  }
  return { declared: Number(declared), hits };
}

function firstUsefulHit(result: SearchResult, needle: string, root: string): SearchHit {
  const hit = result.hits[0];
  if (
    hit === undefined ||
    result.declared !== result.hits.length ||
    !hit.text.includes(needle) ||
    !Number.isSafeInteger(hit.line) ||
    hit.line < 1
  ) {
    throw new TypeError("H1 proof requires a useful bounded result with raw line coordinates");
  }
  const path = relative(root, hit.path);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) {
    throw new TypeError("H1 proof requires a workspace-contained result");
  }
  return { ...hit, path };
}

export function repositorySearchReadHandoff(
  transcript: string,
  needle: string,
  observe: ((proof: RepositorySearchConsumptionProof) => void) | undefined,
): Record<string, unknown> {
  const result = parseSearchResult(nativeToolResultText(transcript, H1_PROOF_SEARCH_CALL_ID));
  const hit = firstUsefulHit(result, needle, nativeWorkingDirectory(transcript));
  observe?.({
    schemaVersion: 1,
    toolCallId: H1_PROOF_SEARCH_CALL_ID,
    hitCount: result.hits.length,
    pathDigest: createHash("sha256").update(hit.path).digest("hex"),
    snippetDigest: createHash("sha256").update(hit.text).digest("hex"),
    startLine: hit.line,
    endLine: hit.line,
    readTargetDerivedFromResult: true,
  });
  return { path: hit.path, offset: hit.line, limit: 1 };
}
