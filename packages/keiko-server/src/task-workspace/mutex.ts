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

import { comparablePath } from "@oscharko-dev/keiko-git";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

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

// A single edited file. The plain file-save route's optimistic-concurrency check is a
// check-then-act (KEIKO-0495): two saves carrying the same baseVersion could both pass
// verification and the second silently overwrite the first. Lowest tier — every key a file write
// takes sits in this one tier, so it can never participate in a multi-key deadlock.
//
// Keyed by the canonicalized PATH, deliberately not by dev+ino. The write replaces the target by
// atomic rename, so the inode changes on every single save: an inode key would let a second request
// that resolves mid-rename derive a different key and enter the "critical" section concurrently —
// the exact race this lock exists to prevent, on the common path rather than an exotic one. The
// path is stable across the replacement.
//
// comparablePath is the same rule containsPath uses to decide "same file", so the exact key agrees
// with containment. But it is NFC + lowercase, not full Unicode case folding, and lowercasing
// SPLITS alias classes a case-insensitive filesystem merges: "ς" and "Σ" lowercase to different
// characters. Two saves spelled that way would take different keys and both enter the section.
//
// The second key closes that. Uppercasing collapses every class lowercasing splits ("ς"/"σ"/"Σ" all
// uppercase to "Σ"), so it is a strictly coarser partition. For a lock key that asymmetry is exactly
// the right direction: collapsing too much only serializes two saves that did not need it, while
// collapsing too little lets a real race through. Both keys are taken together, so the lock is at
// least as strong as either alone.
//
// The alias key is taken on EVERY platform, deliberately. `process.platform` describes the host,
// not the semantics of the mounted filesystem: a Linux host can carry a casefolded ext4 directory,
// a network mount, or a case-insensitive image, and on any of those a platform-gated alias key
// would leave exactly the gap it exists to close. Gating on the host was the wrong question.
//
// Paying for it unconditionally is cheap by the same asymmetry: on a genuinely byte-exact
// filesystem "a.txt" and "A.txt" then share the alias key and serialize when they need not, which
// costs a little concurrency between two saves. Missing the alias costs a lost update.
export function fileWriteKeys(realPath: string): readonly string[] {
  const comparable = comparablePath(realPath);
  return [`file:${comparable}`, `file-alias:${aliasFold(comparable)}`];
}

// Fold to a form that collapses the four alias classes JavaScript's built-in casing splits:
//   - Greek final sigma "ς" vs "Σ"/"σ" (lowercasing splits, uppercasing collapses)
//   - dotless "ı" vs "I" (same)
//   - ligatures "ﬁ" vs "fi" (NFKC collapses)
//   - eszett "ß"/"ẞ" — toUpperCase alone splits ("ß"→"SS", "ẞ"→"ẞ"). Chaining lowerCase→upperCase
//     via ß collapses both to "SS".
// This is not full Unicode case folding — a real casefolding library would be more correct — but
// it closes the four classes actual filesystems collapse, and it fails only in the safe direction
// (over-serialising two saves that did not need to lock together).
function aliasFold(comparable: string): string {
  return comparable.normalize("NFKC").toLowerCase().toUpperCase();
}

function keyTier(key: string): number {
  if (key.startsWith("active:")) return 0;
  if (key.startsWith("ws:")) return 1;
  if (key.startsWith("repo:")) return 2;
  if (key.startsWith("prov:")) return 3;
  if (key.startsWith("file:")) return 4;
  if (key.startsWith("file-alias:")) return 4;
  return 5;
}

function compareKeys(a: string, b: string): number {
  const tierDelta = keyTier(a) - keyTier(b);
  if (tierDelta !== 0) return tierDelta;
  return compareStrings(a, b);
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
