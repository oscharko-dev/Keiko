import type {
  ContextPackDiagnostics,
  EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { ContentEvidenceIdentity } from "./grounded-evidence-selection.js";

export interface ContextualFallbackCandidate extends ContentEvidenceIdentity {
  readonly scopePath: string;
}

/** Capture the lexical producer's ordering with its actual same-search content identities. */
export function captureContextualFallbackCandidates(
  atoms: readonly EvidenceAtom[],
  diagnostics: ContextPackDiagnostics | undefined,
): readonly ContextualFallbackCandidate[] {
  if (atoms.some((atom) => atom.provenance.tool.startsWith("repo.semanticSearch"))) return [];
  const byPath = new Map<string, EvidenceAtom>();
  for (const atom of atoms) {
    if (
      atom.provenance.kind === "lexical-search" &&
      atom.provenance.tool === "repo.searchText" &&
      atom.lineRange !== undefined &&
      !byPath.has(atom.scopePath)
    )
      byPath.set(atom.scopePath, atom);
  }
  return (diagnostics?.rankedCandidates ?? []).flatMap((candidate) => {
    const atom = byPath.get(candidate.scopePath);
    return atom === undefined
      ? []
      : [
          {
            scopePath: atom.scopePath,
            stableId: atom.stableId,
            queryFingerprint: atom.provenance.queryFingerprint,
          },
        ];
  });
}

/** An omitted/replaced atom or a different query cannot inherit the earlier producer's position. */
export function currentContextualFallbackOrder(
  candidates: readonly ContextualFallbackCandidate[],
  atoms: readonly EvidenceAtom[],
): readonly string[] {
  if (atoms.some((atom) => atom.provenance.tool.startsWith("repo.semanticSearch"))) return [];
  const current = new Map(atoms.map((atom) => [atom.stableId, atom]));
  return candidates
    .filter((candidate) => {
      const atom = current.get(candidate.stableId);
      return (
        atom?.scopePath === candidate.scopePath &&
        atom.lineRange !== undefined &&
        atom.provenance.kind === "lexical-search" &&
        atom.provenance.tool === "repo.searchText" &&
        atom.provenance.queryFingerprint === candidate.queryFingerprint
      );
    })
    .map((candidate) => candidate.scopePath);
}
