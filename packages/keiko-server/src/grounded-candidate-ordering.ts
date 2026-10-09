import type { CandidateFile } from "@oscharko-dev/keiko-contracts/connected-context";
import type { SearchAnchor } from "@oscharko-dev/keiko-workflows";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
export function orderForDistinctEvidencePaths(
  kept: readonly CandidateFile[],
  anchors: readonly SearchAnchor[],
  priorityPaths: Set<string>,
  _addressedPaths: ReadonlySet<string> = new Set(),
): readonly CandidateFile[] {
  const selected = new Set(kept.slice(0, 1));
  for (const anchor of anchors) {
    if (anchor.kind === "literal" || anchor.weight < 0.7) continue;
    const term = anchor.term.toLowerCase();
    const candidate =
      [...selected].find((entry) => entry.scopePath.toLowerCase().includes(term)) ??
      kept.find((entry) => entry.scopePath.toLowerCase().includes(term));
    if (candidate !== undefined) {
      selected.add(candidate);
      priorityPaths.add(candidate.scopePath);
    }
  }
  const names = new Set(
    [...selected].map((candidate) => basename(candidate.scopePath).toLowerCase()),
  );
  for (const candidate of kept) {
    const name = basename(candidate.scopePath).toLowerCase();
    if (names.has(name)) continue;
    names.add(name);
    selected.add(candidate);
  }
  return [...selected, ...kept.filter((candidate) => !selected.has(candidate))];
}
