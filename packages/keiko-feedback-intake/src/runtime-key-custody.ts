import type { PgLiveKeyIdsSnapshot } from "./postgres-live-key-snapshot.js";
import type { IntakeSecretKey, IntakeSecretProvider } from "./types.js";

interface LiveKeySnapshotRepository {
  liveKeyIdsSnapshot(now: Date): Promise<PgLiveKeyIdsSnapshot>;
}

interface KeyCustodySnapshots {
  readonly abuse: readonly IntakeSecretKey[];
  readonly dedupe: readonly IntakeSecretKey[];
}

export function assertIndependentKeyCustody(
  abuseKeys: readonly IntakeSecretKey[],
  dedupeKeys: readonly IntakeSecretKey[],
): void {
  for (const abuse of abuseKeys) {
    for (const dedupe of dedupeKeys) {
      if (Buffer.from(abuse.key).equals(Buffer.from(dedupe.key))) {
        throw new Error("Feedback key classes must be independent");
      }
    }
  }
}

function assertLiveKeyCustody(
  mounted: readonly IntakeSecretKey[],
  liveKeyIds: readonly string[],
): void {
  const mountedIds = new Set(mounted.map((key) => key.id));
  if (liveKeyIds.some((keyId) => !mountedIds.has(keyId))) {
    throw new Error("Feedback secret custody is unavailable");
  }
}

export function snapshotIndependentKeyCustody(
  abuseKeys: IntakeSecretProvider,
  dedupeKeys: IntakeSecretProvider,
  now: Date,
): KeyCustodySnapshots {
  const abuseSnapshot = abuseKeys.snapshot(now);
  const dedupeSnapshot = dedupeKeys.snapshot(now);
  const abuse = [abuseSnapshot.active, ...abuseSnapshot.predecessors];
  const dedupe = [dedupeSnapshot.active, ...dedupeSnapshot.predecessors];
  assertIndependentKeyCustody(abuse, dedupe);
  return { abuse, dedupe };
}

export async function assertRepositoryKeyCustody(
  repository: LiveKeySnapshotRepository,
  abuseKeys: IntakeSecretProvider,
  dedupeKeys: IntakeSecretProvider,
  now: Date,
): Promise<void> {
  const mounted = snapshotIndependentKeyCustody(abuseKeys, dedupeKeys, now);
  const live = await repository.liveKeyIdsSnapshot(now);
  assertLiveKeyCustody(mounted.abuse, live.abuse);
  assertLiveKeyCustody(mounted.dedupe, live.dedupe);
}
