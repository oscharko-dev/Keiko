// In-process keyed async mutex for managed task-workspace mutations (Issue #449, Epic #443, ADR-0093 D1).
//
// Every mutating workspace flow is optimistic check-then-write: it reads the instance, evaluates the
// advisory lock, `await`s a Git-adapter spawn, then `store.upsert`s. The window between the live check
// and the persisted write is a TOCTOU gap — two concurrent `provision()` calls for the same (repo, task)
// both pass the gates and both race `git worktree add`. This registry closes that window by SERIALIZING
// the whole critical section within the single server process: `runExclusive(keys, fn)` queues a flow
// behind any in-flight holder of an overlapping key and runs it only once it has exclusive access.
//
// It composes with — never replaces — the persisted advisory `WorkspaceLock`. The mutex grants TURN
// ORDER (same-process serialization); the advisory lock grants OWNERSHIP (across-restart / across-actor).
// The existing cross-actor `LOCK_CONTENTION` rejection therefore stays INSIDE the wrapped section: two
// requests from the same process queue and run one at a time, while a request from a different actor
// still hits the advisory check after the queue drains and is still rejected. The mutex is pure
// in-process JavaScript: no spawn, no filesystem, no new adapter verb, no allowlist entry (SC3). On a
// process crash it simply vanishes — nothing it protected survives either, and the durable record is the
// persisted advisory lock + visible lifecycle state (#447 reconciliation/repair resolve any stale lock).

export interface WorkspaceMutexRegistry {
  // Runs `fn()` with exclusive access to every key in `keys`, queuing behind any in-flight holder of an
  // overlapping key. Keys are acquired in a single canonical order so that, even when a flow takes more
  // than one key, no hold-and-wait cycle can form (deadlock is structurally impossible). The value or
  // throw of `fn` propagates to the caller unchanged.
  readonly runExclusive: <T>(keys: readonly string[], fn: () => Promise<T> | T) => Promise<T>;
}

// ─── key scheme ────────────────────────────────────────────────────────────────────────────────────
// Four contended resources, four key prefixes. The canonical acquisition order is the tier order
// below (active → ws → repo → prov), then lexicographic, so a multi-key flow never deadlocks.

export function activePointerKey(repositoryId: string): string {
  return `active:${repositoryId}`;
}

export function workspaceKey(workspaceId: string): string {
  return `ws:${workspaceId}`;
}

export function repositoryKey(repositoryId: string): string {
  return `repo:${repositoryId}`;
}

export function provisionKey(repositoryId: string, taskId: string): string {
  return `prov:${repositoryId}:${taskId}`;
}

function keyTier(key: string): number {
  if (key.startsWith("active:")) return 0;
  if (key.startsWith("ws:")) return 1;
  if (key.startsWith("repo:")) return 2;
  if (key.startsWith("prov:")) return 3;
  return 4;
}

function compareKeys(a: string, b: string): number {
  const tierDelta = keyTier(a) - keyTier(b);
  if (tierDelta !== 0) return tierDelta;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createWorkspaceMutexRegistry(): WorkspaceMutexRegistry {
  // One tail promise per held key. The tail resolves when the current holder of that key releases. The
  // map only holds keys with an active or queued holder; a key's entry is deleted once its chain drains,
  // so the map can never grow unbounded.
  const tails = new Map<string, Promise<void>>();

  const runExclusive = <T>(keys: readonly string[], fn: () => Promise<T> | T): Promise<T> => {
    const ordered = [...new Set(keys)].sort(compareKeys);
    // Synchronous critical region: capture the predecessor tails of every requested key and install our
    // release gate as their new tail in ONE uninterrupted step (no `await` here), so two concurrent
    // callers cannot interleave their capture/install and both think they acquired the same key. The
    // Promise executor runs synchronously, so `releaseGate` is assigned before any use (definite-assign).
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const predecessors: Promise<void>[] = [];
    for (const key of ordered) {
      const prev = tails.get(key);
      if (prev !== undefined) predecessors.push(prev);
      tails.set(key, gate);
    }
    return (async (): Promise<T> => {
      try {
        await Promise.all(predecessors);
        return await fn();
      } finally {
        releaseGate();
        for (const key of ordered) {
          if (tails.get(key) === gate) tails.delete(key);
        }
      }
    })();
  };

  return { runExclusive };
}
