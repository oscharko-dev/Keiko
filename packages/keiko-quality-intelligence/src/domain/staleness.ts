// Source-fingerprint drift detection and per-test staleness model (Epic #735, Issue #742).
//
// Pure function, no IO, deterministic. Compares persisted envelope fingerprints from a previous
// QI run against current source fingerprints to classify each test-case candidate as fresh or
// stale. A candidate is stale on ANY of its source envelopes changing (hash differs → "source-changed")
// or disappearing from the current scan (envelope absent → "source-removed"). The removed case takes
// precedence over changed. Candidates with no resolvable envelope (unknown atoms) are treated as
// stale to prevent silently keeping invalid tests.

/** A reason why a single candidate is stale. */
export interface StalenessReason {
  readonly candidateId: string;
  readonly reason: "source-changed" | "source-removed";
  readonly envelopeId: string;
}

/** Partitioned staleness report for a full run. */
export interface StalenessResult {
  readonly fresh: readonly string[];
  readonly changedStale: readonly StalenessReason[];
  readonly orphanedStale: readonly StalenessReason[];
}

export interface CompareStalenessArgs {
  /** Fingerprints persisted with the original run (from manifest.sourceFingerprints). */
  readonly oldFingerprints: readonly { envelopeId: string; integrityHashSha256Hex: string }[];
  /** Optional atom-level fingerprints persisted with the original run (post-fix runs only). */
  readonly oldAtomFingerprints?: readonly {
    atomId: string;
    envelopeId: string;
    canonicalHashSha256Hex: string;
    replacementGroupId?: string;
    replacementOrdinal?: number;
  }[];
  /** Evidence refs from the manifest (atomId → envelopeId mapping). */
  readonly evidenceRefs: readonly { envelopeId: string; atomId: string }[];
  /** Candidates to classify. */
  readonly candidates: readonly { id: string; derivedFromAtomIds: readonly string[] }[];
  /** Fingerprints from re-ingesting the current sources right now. */
  readonly currentFingerprints: readonly { envelopeId: string; integrityHashSha256Hex: string }[];
  /** Optional atom-level fingerprints from re-ingesting the current sources right now. */
  readonly currentAtomFingerprints?: readonly {
    atomId: string;
    envelopeId: string;
    canonicalHashSha256Hex: string;
    replacementGroupId?: string;
    replacementOrdinal?: number;
  }[];
}

/** Build a map from atomId → envelopeId from the manifest evidenceRefs. */
function buildAtomToEnvelopeMap(
  evidenceRefs: readonly { envelopeId: string; atomId: string }[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const ref of evidenceRefs) {
    map.set(ref.atomId, ref.envelopeId);
  }
  return map;
}

/** Build a map from envelopeId → hash for a fingerprint array. */
function buildFingerprintMap(
  fingerprints: readonly { envelopeId: string; integrityHashSha256Hex: string }[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const fp of fingerprints) {
    map.set(fp.envelopeId, fp.integrityHashSha256Hex);
  }
  return map;
}

/** Distinct envelopeIds in first-seen evidenceRefs order (deterministic tie-breaking). */
function envelopeOrderOf(
  evidenceRefs: readonly { envelopeId: string; atomId: string }[],
): readonly string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const ref of evidenceRefs) {
    if (!seen.has(ref.envelopeId)) {
      order.push(ref.envelopeId);
      seen.add(ref.envelopeId);
    }
  }
  return order;
}

interface ClassifyContext {
  readonly atomToEnvelope: ReadonlyMap<string, string>;
  readonly oldMap: ReadonlyMap<string, string>;
  readonly currentMap: ReadonlyMap<string, string>;
  readonly envelopeOrder: readonly string[];
  readonly oldAtoms: ReadonlyMap<
    string,
    {
      readonly envelopeId: string;
      readonly canonicalHashSha256Hex: string;
      readonly replacementGroupId?: string;
      readonly replacementOrdinal?: number;
    }
  >;
  readonly currentAtoms: ReadonlyMap<
    string,
    {
      readonly envelopeId: string;
      readonly canonicalHashSha256Hex: string;
      readonly replacementGroupId?: string;
      readonly replacementOrdinal?: number;
    }
  >;
  readonly currentReplacementAtomIdsByOldAtomId: ReadonlyMap<string, string>;
  readonly oldAtomIdsByEnvelope: ReadonlyMap<string, readonly string[]>;
  readonly currentAtomIdsByEnvelope: ReadonlyMap<string, readonly string[]>;
}

const UNKNOWN_ENVELOPE = "unknown";
const REQUIREMENTS_ENVELOPE_PREFIX = "qi-src-req-";
const ALIGN_INSERT_DELETE_COST = 3;
const ALIGN_SUBSTITUTE_COST = 4;
const ALIGN_CROSS_OLD_ATOM_COST = 10;

const staleReason = (
  candidateId: string,
  reason: StalenessReason["reason"],
  envelopeId: string,
): StalenessReason => ({ candidateId, reason, envelopeId });

interface AtomFingerprintEntry {
  readonly atomId: string;
  readonly envelopeId: string;
  readonly canonicalHashSha256Hex: string;
  readonly replacementGroupId?: string;
  readonly replacementOrdinal?: number;
}

interface ReplacementEntry {
  readonly atomId: string;
  readonly canonicalHashSha256Hex: string;
  readonly replacementGroupId: string;
  readonly replacementOrdinal: number;
}

function buildAtomFingerprintMap(
  fingerprints: readonly AtomFingerprintEntry[] | undefined,
): ReadonlyMap<
  string,
  {
    readonly envelopeId: string;
    readonly canonicalHashSha256Hex: string;
    readonly replacementGroupId?: string;
    readonly replacementOrdinal?: number;
  }
> {
  const map = new Map<
    string,
    {
      readonly envelopeId: string;
      readonly canonicalHashSha256Hex: string;
      readonly replacementGroupId?: string;
      readonly replacementOrdinal?: number;
    }
  >();
  for (const fp of fingerprints ?? []) {
    map.set(fp.atomId, {
      envelopeId: fp.envelopeId,
      canonicalHashSha256Hex: fp.canonicalHashSha256Hex,
      ...(fp.replacementGroupId !== undefined ? { replacementGroupId: fp.replacementGroupId } : {}),
      ...(fp.replacementOrdinal !== undefined ? { replacementOrdinal: fp.replacementOrdinal } : {}),
    });
  }
  return map;
}

function replacementEntriesByGroup(
  fingerprints: readonly AtomFingerprintEntry[] | undefined,
): ReadonlyMap<string, readonly ReplacementEntry[]> {
  const groups = new Map<string, ReplacementEntry[]>();
  for (const fp of fingerprints ?? []) {
    if (fp.replacementGroupId === undefined || fp.replacementOrdinal === undefined) continue;
    const entry: ReplacementEntry = {
      atomId: fp.atomId,
      canonicalHashSha256Hex: fp.canonicalHashSha256Hex,
      replacementGroupId: fp.replacementGroupId,
      replacementOrdinal: fp.replacementOrdinal,
    };
    const group = groups.get(fp.replacementGroupId);
    if (group === undefined) {
      groups.set(fp.replacementGroupId, [entry]);
    } else {
      group.push(entry);
    }
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.replacementOrdinal - b.replacementOrdinal);
  }
  return groups;
}

function alignmentPairCost(
  oldEntry: ReplacementEntry,
  currentEntry: ReplacementEntry,
  oldAtomIds: ReadonlySet<string>,
): number {
  if (oldEntry.atomId === currentEntry.atomId) return 0;
  if (currentEntry.canonicalHashSha256Hex === oldEntry.canonicalHashSha256Hex) return 0;
  return oldAtomIds.has(currentEntry.atomId) ? ALIGN_CROSS_OLD_ATOM_COST : ALIGN_SUBSTITUTE_COST;
}

function replacementEntryAt(entries: readonly ReplacementEntry[], index: number): ReplacementEntry {
  const entry = entries[index];
  if (entry === undefined) throw new Error("Replacement alignment index out of bounds.");
  return entry;
}

function matrixValue(matrix: readonly (readonly number[])[], row: number, col: number): number {
  const value = matrix[row]?.[col];
  if (value === undefined) throw new Error("Replacement alignment matrix index out of bounds.");
  return value;
}

function setMatrixValue(matrix: number[][], row: number, col: number, value: number): void {
  const rowValues = matrix[row];
  if (rowValues === undefined) {
    throw new Error("Replacement alignment matrix index out of bounds.");
  }
  rowValues[col] = value;
}

function buildAlignmentCostMatrix(
  oldEntries: readonly ReplacementEntry[],
  currentEntries: readonly ReplacementEntry[],
  oldAtomIds: ReadonlySet<string>,
): readonly (readonly number[])[] {
  const matrix: number[][] = Array.from({ length: oldEntries.length + 1 }, () =>
    Array.from({ length: currentEntries.length + 1 }, () => 0),
  );
  for (let oldIndex = 1; oldIndex <= oldEntries.length; oldIndex += 1) {
    setMatrixValue(matrix, oldIndex, 0, oldIndex * ALIGN_INSERT_DELETE_COST);
  }
  for (let currentIndex = 1; currentIndex <= currentEntries.length; currentIndex += 1) {
    setMatrixValue(matrix, 0, currentIndex, currentIndex * ALIGN_INSERT_DELETE_COST);
  }
  for (let oldIndex = 1; oldIndex <= oldEntries.length; oldIndex += 1) {
    for (let currentIndex = 1; currentIndex <= currentEntries.length; currentIndex += 1) {
      const pairCost = alignmentPairCost(
        replacementEntryAt(oldEntries, oldIndex - 1),
        replacementEntryAt(currentEntries, currentIndex - 1),
        oldAtomIds,
      );
      const pair = matrixValue(matrix, oldIndex - 1, currentIndex - 1) + pairCost;
      const deletion = matrixValue(matrix, oldIndex - 1, currentIndex) + ALIGN_INSERT_DELETE_COST;
      const insertion = matrixValue(matrix, oldIndex, currentIndex - 1) + ALIGN_INSERT_DELETE_COST;
      setMatrixValue(matrix, oldIndex, currentIndex, Math.min(pair, deletion, insertion));
    }
  }
  return matrix;
}

function alignReplacementEntries(
  oldEntries: readonly ReplacementEntry[],
  currentEntries: readonly ReplacementEntry[],
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  const oldAtomIds = new Set(oldEntries.map((entry) => entry.atomId));
  const costs = buildAlignmentCostMatrix(oldEntries, currentEntries, oldAtomIds);
  let oldIndex = oldEntries.length;
  let currentIndex = currentEntries.length;
  while (oldIndex > 0 && currentIndex > 0) {
    const oldEntry = replacementEntryAt(oldEntries, oldIndex - 1);
    const currentEntry = replacementEntryAt(currentEntries, currentIndex - 1);
    const pairCost = alignmentPairCost(oldEntry, currentEntry, oldAtomIds);
    const currentCost = matrixValue(costs, oldIndex, currentIndex);
    const pair = matrixValue(costs, oldIndex - 1, currentIndex - 1) + pairCost;
    const deletion = matrixValue(costs, oldIndex - 1, currentIndex) + ALIGN_INSERT_DELETE_COST;
    const insertion = matrixValue(costs, oldIndex, currentIndex - 1) + ALIGN_INSERT_DELETE_COST;
    if (pairCost === 0 && currentCost === pair) {
      mapping.set(oldEntry.atomId, currentEntry.atomId);
      oldIndex -= 1;
      currentIndex -= 1;
    } else if (currentCost === insertion) {
      currentIndex -= 1;
    } else if (currentCost === deletion) {
      oldIndex -= 1;
    } else {
      mapping.set(oldEntry.atomId, currentEntry.atomId);
      oldIndex -= 1;
      currentIndex -= 1;
    }
  }
  return mapping;
}

function buildReplacementAtomMap(
  oldFingerprints: readonly AtomFingerprintEntry[] | undefined,
  currentFingerprints: readonly AtomFingerprintEntry[] | undefined,
): ReadonlyMap<string, string> {
  const oldGroups = replacementEntriesByGroup(oldFingerprints);
  const currentGroups = replacementEntriesByGroup(currentFingerprints);
  const mapping = new Map<string, string>();
  for (const [groupId, oldEntries] of oldGroups) {
    const currentEntries = currentGroups.get(groupId);
    if (currentEntries === undefined) continue;
    for (const [oldAtomId, currentAtomId] of alignReplacementEntries(oldEntries, currentEntries)) {
      mapping.set(oldAtomId, currentAtomId);
    }
  }
  return mapping;
}

function buildAtomIdsByEnvelope(
  fingerprints:
    | readonly {
        atomId: string;
        envelopeId: string;
        canonicalHashSha256Hex: string;
      }[]
    | undefined,
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const fp of fingerprints ?? []) {
    const current = map.get(fp.envelopeId);
    if (current === undefined) {
      map.set(fp.envelopeId, [fp.atomId]);
    } else {
      current.push(fp.atomId);
    }
  }
  return map;
}

function replacementAtomIdForMissingCurrentAtom(
  atomId: string,
  ctx: ClassifyContext,
): string | undefined {
  return ctx.currentReplacementAtomIdsByOldAtomId.get(atomId);
}

function positionalRequirementReplacementAtomId(
  atomId: string,
  envelopeId: string,
  ctx: ClassifyContext,
): string | undefined {
  const oldAtomIds = ctx.oldAtomIdsByEnvelope.get(envelopeId) ?? [];
  const currentAtomIds = ctx.currentAtomIdsByEnvelope.get(envelopeId) ?? [];
  const oldIndex = oldAtomIds.indexOf(atomId);
  return oldIndex >= 0 ? currentAtomIds[oldIndex] : undefined;
}

function classifyMissingCurrentAtom(
  candidateId: string,
  atomId: string,
  envelopeId: string,
  ctx: ClassifyContext,
): StalenessReason {
  if (!ctx.currentMap.has(envelopeId)) {
    return staleReason(candidateId, "source-removed", envelopeId);
  }
  const replacementAtomId = replacementAtomIdForMissingCurrentAtom(atomId, ctx);
  if (replacementAtomId !== undefined && !ctx.oldAtoms.has(replacementAtomId)) {
    return staleReason(candidateId, "source-changed", envelopeId);
  }
  if (!envelopeId.startsWith(REQUIREMENTS_ENVELOPE_PREFIX)) {
    return staleReason(candidateId, "source-removed", envelopeId);
  }
  const currentAtomAtSamePosition = positionalRequirementReplacementAtomId(atomId, envelopeId, ctx);
  if (currentAtomAtSamePosition !== undefined && !ctx.oldAtoms.has(currentAtomAtSamePosition)) {
    return staleReason(candidateId, "source-changed", envelopeId);
  }
  return staleReason(candidateId, "source-removed", envelopeId);
}

function classifyCandidateWithAtomFingerprints(
  candidate: { readonly id: string; readonly derivedFromAtomIds: readonly string[] },
  ctx: ClassifyContext,
): StalenessReason | null {
  if (candidate.derivedFromAtomIds.length === 0) {
    return staleReason(candidate.id, "source-removed", UNKNOWN_ENVELOPE);
  }
  let changedEnvelopeId: string | undefined;
  for (const atomId of candidate.derivedFromAtomIds) {
    const oldAtom = ctx.oldAtoms.get(atomId);
    if (oldAtom === undefined) {
      return staleReason(candidate.id, "source-changed", UNKNOWN_ENVELOPE);
    }
    const currentAtom = ctx.currentAtoms.get(atomId);
    if (currentAtom !== undefined) {
      if (currentAtom.canonicalHashSha256Hex !== oldAtom.canonicalHashSha256Hex) {
        changedEnvelopeId ??= oldAtom.envelopeId;
      }
      continue;
    }
    const missingCurrentAtomReason = classifyMissingCurrentAtom(
      candidate.id,
      atomId,
      oldAtom.envelopeId,
      ctx,
    );
    if (missingCurrentAtomReason.reason === "source-changed") {
      changedEnvelopeId ??= oldAtom.envelopeId;
      continue;
    }
    return missingCurrentAtomReason;
  }
  return changedEnvelopeId === undefined
    ? null
    : staleReason(candidate.id, "source-changed", changedEnvelopeId);
}

function orderedCandidateEnvelopeIds(
  candidate: { readonly derivedFromAtomIds: readonly string[] },
  ctx: ClassifyContext,
): readonly string[] {
  const envelopeIds = new Set<string>();
  for (const atomId of candidate.derivedFromAtomIds) {
    const envelopeId = ctx.atomToEnvelope.get(atomId);
    if (envelopeId !== undefined) envelopeIds.add(envelopeId);
  }
  return ctx.envelopeOrder.filter((envelopeId) => envelopeIds.has(envelopeId));
}

function classifyEnvelopeLevelCandidate(
  candidateId: string,
  orderedEnvelopeIds: readonly string[],
  ctx: ClassifyContext,
): StalenessReason | null {
  for (const envelopeId of orderedEnvelopeIds) {
    if (!ctx.currentMap.has(envelopeId)) {
      return staleReason(candidateId, "source-removed", envelopeId);
    }
  }
  for (const envelopeId of orderedEnvelopeIds) {
    const oldHash = ctx.oldMap.get(envelopeId);
    const currentHash = ctx.currentMap.get(envelopeId);
    if (currentHash !== undefined && oldHash !== currentHash) {
      return staleReason(candidateId, "source-changed", envelopeId);
    }
  }
  return null;
}

/**
 * Classify ONE candidate. Returns the dominant staleness reason, or null when fresh.
 * Removed (envelope gone from the current scan) takes precedence over changed (hash differs);
 * an unresolvable atom is treated as changed so an invalid test is never silently kept fresh.
 */
function classifyCandidate(
  candidate: { readonly id: string; readonly derivedFromAtomIds: readonly string[] },
  ctx: ClassifyContext,
): StalenessReason | null {
  const hasAtomMetadata =
    ctx.oldAtoms.size > 0 &&
    candidate.derivedFromAtomIds.every((atomId) => ctx.oldAtoms.has(atomId));
  if (hasAtomMetadata) {
    return classifyCandidateWithAtomFingerprints(candidate, ctx);
  }
  if (candidate.derivedFromAtomIds.length === 0) {
    return staleReason(candidate.id, "source-removed", UNKNOWN_ENVELOPE);
  }
  if (candidate.derivedFromAtomIds.some((atomId) => !ctx.atomToEnvelope.has(atomId))) {
    return staleReason(candidate.id, "source-changed", UNKNOWN_ENVELOPE);
  }
  return classifyEnvelopeLevelCandidate(
    candidate.id,
    orderedCandidateEnvelopeIds(candidate, ctx),
    ctx,
  );
}

/**
 * Classify each candidate as fresh or stale based on whether their source envelopes have changed
 * since the run was persisted. Pure, deterministic; candidate input order is preserved.
 */
export function compareStaleness(args: CompareStalenessArgs): StalenessResult {
  const ctx: ClassifyContext = {
    atomToEnvelope: buildAtomToEnvelopeMap(args.evidenceRefs),
    oldMap: buildFingerprintMap(args.oldFingerprints),
    currentMap: buildFingerprintMap(args.currentFingerprints),
    envelopeOrder: envelopeOrderOf(args.evidenceRefs),
    oldAtoms: buildAtomFingerprintMap(args.oldAtomFingerprints),
    currentAtoms: buildAtomFingerprintMap(args.currentAtomFingerprints),
    currentReplacementAtomIdsByOldAtomId: buildReplacementAtomMap(
      args.oldAtomFingerprints,
      args.currentAtomFingerprints,
    ),
    oldAtomIdsByEnvelope: buildAtomIdsByEnvelope(args.oldAtomFingerprints),
    currentAtomIdsByEnvelope: buildAtomIdsByEnvelope(args.currentAtomFingerprints),
  };

  const fresh: string[] = [];
  const changedStale: StalenessReason[] = [];
  const orphanedStale: StalenessReason[] = [];

  for (const candidate of args.candidates) {
    const reason = classifyCandidate(candidate, ctx);
    if (reason === null) {
      fresh.push(candidate.id);
    } else if (reason.reason === "source-removed") {
      orphanedStale.push(reason);
    } else {
      changedStale.push(reason);
    }
  }

  return { fresh, changedStale, orphanedStale };
}
