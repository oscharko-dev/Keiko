import type {
  CandidateFile,
  EvidenceAtom,
  OmittedContextEntry,
  SelectedScope,
} from "@oscharko-dev/keiko-contracts";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

export interface ContentEvidenceIdentity {
  readonly stableId: string;
  readonly queryFingerprint: string;
}

export function certifiedContentPaths(
  atoms: readonly EvidenceAtom[],
  identities: readonly ContentEvidenceIdentity[],
): ReadonlySet<string> {
  const certified = new Map(
    identities.map((identity) => [identity.stableId, identity.queryFingerprint]),
  );
  return new Set(
    atoms
      .filter(
        (atom) =>
          ((atom.provenance.kind === "lexical-search" &&
            atom.provenance.tool === "repo.searchText") ||
            (atom.provenance.kind === "file-listing" &&
              atom.provenance.tool === "repo.findFiles")) &&
          atom.lineRange !== undefined &&
          certified.get(atom.stableId) === atom.provenance.queryFingerprint,
      )
      .map((atom) => atom.scopePath),
  );
}

const MIN_RELATIVE_CANDIDATE_SCORE = 0.55;

export interface GroundedCandidateSelectionInput {
  readonly kept: readonly CandidateFile[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly scopeKind: SelectedScope["kind"];
  readonly filesReadMax: number | null;
  readonly protectedContentPaths?: ReadonlySet<string>;
  // Recorded by explicit target/implementation ordering, never inferred from array position.
  readonly priorityPaths?: ReadonlySet<string>;
  readonly pathOnlyPaths?: ReadonlySet<string>;
  readonly nowMs: number;
}

export interface GroundedCandidateSelection {
  readonly kept: readonly CandidateFile[];
  readonly omitted: readonly OmittedContextEntry[];
}

function boundedFileLimit(input: GroundedCandidateSelectionInput): number {
  return input.filesReadMax === null
    ? input.kept.length
    : Math.max(0, Math.floor(input.filesReadMax));
}

function selectedWorkspaceCandidates(
  input: GroundedCandidateSelectionInput,
  limit: number,
  relativeFloor: number | undefined,
): readonly CandidateFile[] {
  if (relativeFloor === undefined || limit === 0) return [];
  const priorities: CandidateFile[] = [];
  const evidence: CandidateFile[] = [];
  const paths: CandidateFile[] = [];
  const remaining: CandidateFile[] = [];
  for (const candidate of input.kept) {
    if (input.priorityPaths?.has(candidate.scopePath) === true) priorities.push(candidate);
    else if (clearsRelativeFloor(candidate, input, relativeFloor)) remaining.push(candidate);
  }
  for (const candidate of remaining) {
    if (input.pathOnlyPaths?.has(candidate.scopePath) === true) paths.push(candidate);
    else evidence.push(candidate);
  }
  return [...priorities, ...evidence, ...paths].slice(0, limit);
}

function clearsRelativeFloor(
  candidate: CandidateFile,
  input: GroundedCandidateSelectionInput,
  relativeFloor: number,
): boolean {
  return (
    candidate.score >= relativeFloor ||
    input.protectedContentPaths?.has(candidate.scopePath) === true
  );
}

export function pathOnlyEvidencePaths(atoms: readonly EvidenceAtom[]): ReadonlySet<string> {
  return new Set(
    [...atomsByPath(atoms)]
      .filter(([, entries]) =>
        entries.every(
          (atom) => atom.lineRange === undefined && atom.provenance.kind === "file-listing",
        ),
      )
      .map(([scopePath]) => scopePath),
  );
}

function relativeScoreFloor(input: GroundedCandidateSelectionInput): number | undefined {
  if (input.scopeKind === "files" || input.kept.length === 0) return undefined;
  const strongest = input.kept.reduce((score, candidate) => Math.max(score, candidate.score), 0);
  return strongest * MIN_RELATIVE_CANDIDATE_SCORE;
}

function selectionReasonFor(
  candidate: CandidateFile,
  selectedPaths: ReadonlySet<string>,
  relativeFloor: number | undefined,
  input: GroundedCandidateSelectionInput,
): OmittedContextEntry["reason"] | undefined {
  if (selectedPaths.has(candidate.scopePath)) return undefined;
  return relativeFloor !== undefined &&
    candidate.score < relativeFloor &&
    input.protectedContentPaths?.has(candidate.scopePath) !== true &&
    input.priorityPaths?.has(candidate.scopePath) !== true
    ? "low-relevance"
    : "budget-exhausted";
}

function compareOmitted(a: OmittedContextEntry, b: OmittedContextEntry): number {
  return compareStrings(a.scopePath, b.scopePath);
}

export function selectGroundedCandidateFiles(
  input: GroundedCandidateSelectionInput,
): GroundedCandidateSelection {
  const limit = boundedFileLimit(input);
  const relativeFloor = relativeScoreFloor(input);
  const selected =
    input.scopeKind === "files"
      ? input.kept.slice(0, limit)
      : selectedWorkspaceCandidates(input, limit, relativeFloor);
  const selectedPaths = new Set(selected.map((candidate) => candidate.scopePath));
  const newlyOmitted = input.kept.flatMap((candidate) => {
    const reason = selectionReasonFor(candidate, selectedPaths, relativeFloor, input);
    return reason === undefined
      ? []
      : [{ scopePath: candidate.scopePath, reason, omittedAtMs: input.nowMs }];
  });
  return {
    kept: selected,
    omitted: [...input.omitted, ...newlyOmitted].sort(compareOmitted),
  };
}

function atomRangeKey(atom: EvidenceAtom): string {
  const range = atom.lineRange;
  return range === undefined ? "*" : `${String(range.startLine)}-${String(range.endLine)}`;
}

export function tracePriority(atom: EvidenceAtom): number {
  if (atom.provenance.tool === "repo.selectedFile" && atom.lineRange !== undefined) return 2;
  if (atom.provenance.tool === "discovered-symbol-definition") return 2;
  if (atom.provenance.tool === "repo.symbolFileDiscovery" && atom.lineRange !== undefined) return 2;
  if (atom.provenance.tool === "structural-edge-target") return 1;
  return 0;
}

function strongerAtom(a: EvidenceAtom, b: EvidenceAtom): EvidenceAtom {
  const priorityDelta = tracePriority(a) - tracePriority(b);
  if (priorityDelta !== 0) return priorityDelta > 0 ? a : b;
  if (a.score !== b.score) return a.score > b.score ? a : b;
  return a.stableId.localeCompare(b.stableId) <= 0 ? a : b;
}

function deduplicateRanges(atoms: readonly EvidenceAtom[]): readonly EvidenceAtom[] {
  const byRange = new Map<string, EvidenceAtom>();
  for (const atom of atoms) {
    const key = atomRangeKey(atom);
    const existing = byRange.get(key);
    byRange.set(key, existing === undefined ? atom : strongerAtom(existing, atom));
  }
  return [...byRange.values()];
}

function rangeSpan(atom: EvidenceAtom): number {
  const range = atom.lineRange;
  return range === undefined ? 0 : range.endLine - range.startLine + 1;
}

function compareByScore(a: EvidenceAtom, b: EvidenceAtom): number {
  return b.score - a.score || rangeSpan(b) - rangeSpan(a) || a.stableId.localeCompare(b.stableId);
}

function withoutRedundantDiscoveryHeaders(
  atoms: readonly EvidenceAtom[],
  preferLocatedDefinitions: boolean,
): readonly EvidenceAtom[] {
  if (!preferLocatedDefinitions) return atoms;
  const locatedQueries = new Set(
    atoms
      .filter((atom) => atom.lineRange !== undefined && tracePriority(atom) === 2)
      .map((atom) => atom.provenance.queryFingerprint),
  );
  return atoms.filter(
    (atom) =>
      !(
        atom.lineRange === undefined &&
        atom.provenance.kind === "file-listing" &&
        atom.provenance.tool === "repo.findFiles" &&
        locatedQueries.has(atom.provenance.queryFingerprint)
      ),
  );
}

function selectAtomsForPath(
  atoms: readonly EvidenceAtom[],
  preferLocatedDefinitions: boolean,
): readonly EvidenceAtom[] {
  const unique = deduplicateRanges(
    withoutRedundantDiscoveryHeaders(atoms, preferLocatedDefinitions),
  );
  return [...unique].sort(compareByScore);
}

function atomsByPath(atoms: readonly EvidenceAtom[]): ReadonlyMap<string, readonly EvidenceAtom[]> {
  const grouped = new Map<string, EvidenceAtom[]>();
  for (const atom of atoms) {
    const entries = grouped.get(atom.scopePath) ?? [];
    entries.push(atom);
    grouped.set(atom.scopePath, entries);
  }
  return grouped;
}

export function selectGroundedEvidenceAtoms(
  atoms: readonly EvidenceAtom[],
  selectedPaths: ReadonlySet<string>,
  _scopeId: string,
  preferLocatedDefinitions = false,
): readonly EvidenceAtom[] {
  const grouped = atomsByPath(atoms);
  const selected: EvidenceAtom[] = [];
  for (const scopePath of selectedPaths) {
    for (const atom of selectAtomsForPath(grouped.get(scopePath) ?? [], preferLocatedDefinitions))
      selected.push(atom);
  }
  return selected;
}
