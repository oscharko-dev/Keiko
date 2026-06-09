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
    { readonly envelopeId: string; readonly canonicalHashSha256Hex: string }
  >;
  readonly currentAtoms: ReadonlyMap<
    string,
    { readonly envelopeId: string; readonly canonicalHashSha256Hex: string }
  >;
}

const UNKNOWN_ENVELOPE = "unknown";
const REQUIREMENTS_ENVELOPE_PREFIX = "qi-src-req-";

const staleReason = (
  candidateId: string,
  reason: StalenessReason["reason"],
  envelopeId: string,
): StalenessReason => ({ candidateId, reason, envelopeId });

function buildAtomFingerprintMap(
  fingerprints:
    | readonly {
        atomId: string;
        envelopeId: string;
        canonicalHashSha256Hex: string;
      }[]
    | undefined,
): ReadonlyMap<string, { readonly envelopeId: string; readonly canonicalHashSha256Hex: string }> {
  const map = new Map<string, { readonly envelopeId: string; readonly canonicalHashSha256Hex: string }>();
  for (const fp of fingerprints ?? []) {
    map.set(fp.atomId, {
      envelopeId: fp.envelopeId,
      canonicalHashSha256Hex: fp.canonicalHashSha256Hex,
    });
  }
  return map;
}

function classifyMissingCurrentAtom(
  candidateId: string,
  envelopeId: string,
  ctx: ClassifyContext,
): StalenessReason {
  if (!ctx.currentMap.has(envelopeId)) {
    return staleReason(candidateId, "source-removed", envelopeId);
  }
  return envelopeId.startsWith(REQUIREMENTS_ENVELOPE_PREFIX)
    ? staleReason(candidateId, "source-changed", envelopeId)
    : staleReason(candidateId, "source-removed", envelopeId);
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
    const missingCurrentAtomReason = classifyMissingCurrentAtom(candidate.id, oldAtom.envelopeId, ctx);
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
    ctx.oldAtoms.size > 0 && candidate.derivedFromAtomIds.every((atomId) => ctx.oldAtoms.has(atomId));
  if (hasAtomMetadata) {
    return classifyCandidateWithAtomFingerprints(candidate, ctx);
  }
  if (candidate.derivedFromAtomIds.length === 0) {
    return staleReason(candidate.id, "source-removed", UNKNOWN_ENVELOPE);
  }
  if (candidate.derivedFromAtomIds.some((atomId) => !ctx.atomToEnvelope.has(atomId))) {
    return staleReason(candidate.id, "source-changed", UNKNOWN_ENVELOPE);
  }
  return classifyEnvelopeLevelCandidate(candidate.id, orderedCandidateEnvelopeIds(candidate, ctx), ctx);
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
