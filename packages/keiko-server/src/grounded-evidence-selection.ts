import type {
  CandidateFile,
  EvidenceAtom,
  OmittedContextEntry,
  SelectedScope,
} from "@oscharko-dev/keiko-contracts";

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
const MAX_EVIDENCE_ATOMS_PER_FILE = 12;
const TRACE_RANGE_SLOTS_PER_FILE = 4;
const CONTEXT_RANGE_SLOTS_PER_FILE = 2;

export interface GroundedCandidateSelectionInput {
  readonly kept: readonly CandidateFile[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly scopeKind: SelectedScope["kind"];
  readonly filesReadMax: number | null;
  readonly protectedContentPaths?: ReadonlySet<string>;
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
  kept: readonly CandidateFile[],
  limit: number,
  protectedContentPaths: ReadonlySet<string> | undefined,
): readonly CandidateFile[] {
  const bestScore = kept[0]?.score;
  if (bestScore === undefined || limit === 0) return [];
  const relativeFloor = bestScore * MIN_RELATIVE_CANDIDATE_SCORE;
  return kept
    .filter(
      (candidate) =>
        candidate.score >= relativeFloor ||
        protectedContentPaths?.has(candidate.scopePath) === true,
    )
    .slice(0, limit);
}

function selectionReasonFor(
  candidate: CandidateFile,
  selectedPaths: ReadonlySet<string>,
  relativeFloor: number | undefined,
  protectedContentPaths: ReadonlySet<string> | undefined,
): OmittedContextEntry["reason"] | undefined {
  if (selectedPaths.has(candidate.scopePath)) return undefined;
  return relativeFloor !== undefined &&
    candidate.score < relativeFloor &&
    protectedContentPaths?.has(candidate.scopePath) !== true
    ? "low-relevance"
    : "budget-exhausted";
}

function compareOmitted(a: OmittedContextEntry, b: OmittedContextEntry): number {
  return a.scopePath.localeCompare(b.scopePath);
}

export function selectGroundedCandidateFiles(
  input: GroundedCandidateSelectionInput,
): GroundedCandidateSelection {
  const limit = boundedFileLimit(input);
  const selected =
    input.scopeKind === "files"
      ? input.kept.slice(0, limit)
      : selectedWorkspaceCandidates(input.kept, limit, input.protectedContentPaths);
  const selectedPaths = new Set(selected.map((candidate) => candidate.scopePath));
  const relativeFloor =
    input.scopeKind === "files" || input.kept[0] === undefined
      ? undefined
      : input.kept[0].score * MIN_RELATIVE_CANDIDATE_SCORE;
  const newlyOmitted = input.kept.flatMap((candidate) => {
    const reason = selectionReasonFor(
      candidate,
      selectedPaths,
      relativeFloor,
      input.protectedContentPaths,
    );
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

function compareByContextRange(a: EvidenceAtom, b: EvidenceAtom): number {
  return rangeSpan(b) - rangeSpan(a) || compareByScore(a, b);
}

function compareByTracePriority(a: EvidenceAtom, b: EvidenceAtom): number {
  return tracePriority(b) - tracePriority(a) || compareByScore(a, b);
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
  const selected = new Map<string, EvidenceAtom>();
  for (const atom of [...unique]
    .filter((entry) => tracePriority(entry) > 0)
    .sort(compareByTracePriority)
    .slice(0, TRACE_RANGE_SLOTS_PER_FILE)) {
    selected.set(atom.stableId, atom);
  }
  for (const atom of [...unique]
    .sort(compareByContextRange)
    .slice(0, CONTEXT_RANGE_SLOTS_PER_FILE)) {
    if (selected.size >= MAX_EVIDENCE_ATOMS_PER_FILE) break;
    selected.set(atom.stableId, atom);
  }
  for (const atom of [...unique].sort(compareByScore)) {
    if (selected.size >= MAX_EVIDENCE_ATOMS_PER_FILE) break;
    selected.set(atom.stableId, atom);
  }
  return [...deduplicateRanges([...selected.values()])].sort(compareByScore);
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
    selected.push(...selectAtomsForPath(grouped.get(scopePath) ?? [], preferLocatedDefinitions));
  }
  return selected;
}
