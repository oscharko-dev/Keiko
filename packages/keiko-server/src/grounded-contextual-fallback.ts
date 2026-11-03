import {
  isLexicalQueryGroupKey,
  type ContextPackDiagnostics,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { ContentEvidenceIdentity } from "./grounded-evidence-selection.js";

export interface ContextualFallbackCandidate extends ContentEvidenceIdentity {
  readonly scopePath: string;
}

function contentPeerIdentity(atom: EvidenceAtom): string | undefined {
  const group = atom.metrics?.lexicalQueryGroupKey;
  return isLexicalQueryGroupKey(group)
    ? JSON.stringify([atom.provenance.queryFingerprint, group])
    : undefined;
}

function withRetainedContentPeers(
  ranked: readonly EvidenceAtom[],
  retained: ReadonlyMap<string, EvidenceAtom>,
): readonly EvidenceAtom[] {
  const rankedPaths = new Set(ranked.map((atom) => atom.scopePath));
  const groups = new Set(ranked.flatMap((atom) => contentPeerIdentity(atom) ?? []));
  // Diagnostics show only a bounded preview. A retained same-query content peer must not
  // disappear merely because generic path matches fill that preview. Keep its seeds first;
  // additional peers keep producer order and still face the existing final three-file grant.
  return [
    ...ranked,
    ...[...retained.values()].filter((atom) => {
      const identity = contentPeerIdentity(atom);
      return !rankedPaths.has(atom.scopePath) && identity !== undefined && groups.has(identity);
    }),
  ];
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
  const ranked = (diagnostics?.rankedCandidates ?? []).flatMap((candidate) => {
    const atom = byPath.get(candidate.scopePath);
    return atom === undefined ? [] : [atom];
  });
  return withRetainedContentPeers(ranked, byPath).map((atom) => ({
    scopePath: atom.scopePath,
    stableId: atom.stableId,
    queryFingerprint: atom.provenance.queryFingerprint,
  }));
}

function currentContextualFallbackAtoms(
  candidates: readonly ContextualFallbackCandidate[],
  atoms: readonly EvidenceAtom[],
): readonly EvidenceAtom[] {
  if (atoms.some((atom) => atom.provenance.tool.startsWith("repo.semanticSearch"))) return [];
  const current = new Map(atoms.map((atom) => [atom.stableId, atom]));
  return candidates.flatMap((candidate) => {
    const atom = current.get(candidate.stableId);
    return atom?.scopePath === candidate.scopePath &&
      atom.lineRange !== undefined &&
      atom.provenance.kind === "lexical-search" &&
      atom.provenance.tool === "repo.searchText" &&
      atom.provenance.queryFingerprint === candidate.queryFingerprint
      ? [atom]
      : [];
  });
}

/** An omitted/replaced atom or a different query cannot inherit the earlier producer's position. */
export function currentContextualFallbackOrder(
  candidates: readonly ContextualFallbackCandidate[],
  atoms: readonly EvidenceAtom[],
): readonly string[] {
  return currentContextualFallbackAtoms(candidates, atoms).map((atom) => atom.scopePath);
}

/** A peer must match the same query groups, not merely the same number of unrelated groups. */
export function currentContextualFallbackGroups(
  candidates: readonly ContextualFallbackCandidate[],
  atoms: readonly EvidenceAtom[],
): ReadonlyMap<string, string> {
  const current = currentContextualFallbackAtoms(candidates, atoms);
  if (new Set(current.map((atom) => atom.provenance.queryFingerprint)).size !== 1) {
    return new Map();
  }
  return new Map(
    current.flatMap((atom) => {
      const group = atom.metrics?.lexicalQueryGroupKey;
      return group === undefined ? [] : [[atom.scopePath, group] as const];
    }),
  );
}
