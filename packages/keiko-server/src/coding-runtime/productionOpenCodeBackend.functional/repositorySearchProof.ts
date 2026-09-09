// Scripted MODEL boundary for the real-binary lane: the search result and subsequent bounded read
// still traverse the shipped runtime, protocol, binder and production workspace handlers.
import { createHash } from "node:crypto";

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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchOutput(transcript: string): Record<string, unknown> {
  const messages: unknown = JSON.parse(transcript);
  if (!Array.isArray(messages)) throw new TypeError("H1 proof requires gateway messages");
  const reply: unknown = messages.find(
    (message: unknown) =>
      record(message) && message.role === "tool" && message.toolCallId === H1_PROOF_SEARCH_CALL_ID,
  );
  if (!record(reply) || typeof reply.content !== "string") {
    throw new TypeError("H1 proof requires the correlated runtime search result");
  }
  const output: unknown = JSON.parse(reply.content);
  if (
    !record(output) ||
    output.status !== "completed" ||
    !record(output.search) ||
    output.search.ok !== true ||
    output.search.kind !== "search"
  ) {
    throw new TypeError("H1 proof requires a completed search result");
  }
  return output.search;
}

function firstUsefulHit(
  search: Record<string, unknown>,
  needle: string,
): {
  readonly path: string;
  readonly snippet: string;
  readonly startLine: number;
  readonly endLine: number;
} {
  const hit: unknown = Array.isArray(search.hits) ? search.hits[0] : undefined;
  if (
    !record(hit) ||
    typeof hit.path !== "string" ||
    typeof hit.snippet !== "string" ||
    !hit.snippet.includes(needle) ||
    !Number.isSafeInteger(hit.startLine) ||
    !Number.isSafeInteger(hit.endLine) ||
    Number(hit.startLine) < 1 ||
    Number(hit.endLine) < Number(hit.startLine)
  ) {
    throw new TypeError("H1 proof requires a useful bounded result with raw line coordinates");
  }
  return {
    path: hit.path,
    snippet: hit.snippet,
    startLine: Number(hit.startLine),
    endLine: Number(hit.endLine),
  };
}

export function repositorySearchReadHandoff(
  transcript: string,
  needle: string,
  observe: ((proof: RepositorySearchConsumptionProof) => void) | undefined,
): Record<string, unknown> {
  const search = searchOutput(transcript);
  const hit = firstUsefulHit(search, needle);
  observe?.({
    schemaVersion: 1,
    toolCallId: H1_PROOF_SEARCH_CALL_ID,
    hitCount: Array.isArray(search.hits) ? search.hits.length : 0,
    pathDigest: createHash("sha256").update(hit.path).digest("hex"),
    snippetDigest: createHash("sha256").update(hit.snippet).digest("hex"),
    startLine: hit.startLine,
    endLine: hit.endLine,
    readTargetDerivedFromResult: true,
  });
  return {
    relativePath: hit.path,
    startLine: hit.startLine,
    maxLines: hit.endLine - hit.startLine + 1,
  };
}
