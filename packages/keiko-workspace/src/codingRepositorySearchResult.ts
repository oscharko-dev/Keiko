import {
  CODING_REPOSITORY_LIMITS,
  type CodingRepositoryResult,
  type CodingRepositoryTruncationReason,
} from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { clampToBytes } from "./repoSearch.js";

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
