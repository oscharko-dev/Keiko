import {
  CODING_REPOSITORY_LIMITS,
  type CodingRepositoryResult,
  type CodingRepositoryTruncationReason,
} from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { clampToBytes, type SearchResult } from "./repoSearch.js";
import type { CandidateSet } from "./repoSearchScan.js";

function outputBytes(result: CodingRepositoryResult): number {
  return new TextEncoder().encode(JSON.stringify(result)).length;
}

export function boundCodingRepositoryResult(
  result: CodingRepositoryResult,
): CodingRepositoryResult {
  if (!result.ok || outputBytes(result) <= CODING_REPOSITORY_LIMITS.outputBytes) return result;
  const truncationReasons: CodingRepositoryTruncationReason[] = [
    ...new Set<CodingRepositoryTruncationReason>([...result.truncationReasons, "output-limit"]),
  ];
  if (result.kind === "search") {
    const hits = [...result.hits];
    while (
      hits.length > 0 &&
      outputBytes({ ...result, hits, truncationReasons }) > CODING_REPOSITORY_LIMITS.outputBytes
    )
      hits.pop();
    return { ...result, hits, truncationReasons };
  }
  let excerpt = { ...result.excerpt, snippetTruncated: true };
  while (
    outputBytes({ ...result, excerpt, truncationReasons }) > CODING_REPOSITORY_LIMITS.outputBytes
  ) {
    if (excerpt.snippet.length === 0) return { ok: false, reason: "failed" };
    excerpt = {
      ...excerpt,
      snippet: clampToBytes(
        excerpt.snippet,
        Math.floor(new TextEncoder().encode(excerpt.snippet).length / 2),
      ).excerpt,
    };
  }
  return { ...result, excerpt, truncationReasons };
}

export function searchTruncationReasons(
  result: SearchResult,
  inventory: CandidateSet,
  skippedFiles: number,
): CodingRepositoryTruncationReason[] {
  const reasons = new Set<CodingRepositoryTruncationReason>();
  if (inventory.diagnostics.maxFilesPrunedByDiscovery > 0) reasons.add("inventory-limit");
  if (inventory.diagnostics.depthPrunedByDiscovery > 0) reasons.add("depth-limit");
  if (skippedFiles > 0) reasons.add("file-too-large");
  if (
    result.filesScanned >= CODING_REPOSITORY_LIMITS.scannedFiles &&
    result.coverage.reasons.includes("file-cap")
  )
    reasons.add("file-limit");
  if (result.coverage.reasons.includes("match-cap")) reasons.add("result-limit");
  return [...reasons];
}
