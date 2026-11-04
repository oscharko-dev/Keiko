/** An entry of an in-memory Jira session store that is owned by one Chat and counts its bytes. */
interface OwnedBytes {
  readonly id: string;
  readonly owner: string;
  readonly bytes: number;
}

function largestOwner(entries: Iterable<OwnedBytes>): string | undefined {
  const held = new Map<string, number>();
  for (const entry of entries) held.set(entry.owner, (held.get(entry.owner) ?? 0) + entry.bytes);
  return [...held.entries()].sort(([, left], [, right]) => right - left)[0]?.[0];
}

/**
 * Brings a store under its shared byte budget. The owner holding the most pays first, whoever
 * asked last, and gives up the entry `evictFor` names (its oldest evictable one); a store with
 * nothing left to evict stops there.
 */
export function trimOwnedBytes<Entry extends OwnedBytes>(
  entries: Map<string, Entry>,
  limit: number,
  evictFor: (owner: string) => Entry | undefined,
): void {
  let total = 0;
  for (const entry of entries.values()) total += entry.bytes;
  while (total > limit) {
    const owner = largestOwner(entries.values());
    const victim = owner === undefined ? undefined : evictFor(owner);
    if (victim === undefined) return;
    entries.delete(victim.id);
    total -= victim.bytes;
  }
}
