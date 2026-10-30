// The review root's crash-recovery registry (ADR-0182 D3, ADR-0098, Issue #4133).
//
// A review worktree and its private refs live in the user's repository (an administrative entry
// and refs under `refs/keiko-review/`), so cleanup after a crash must know WHICH repository to
// visit. The registry records that before Git creates anything: every worktree by its leaf and
// every private ref Keiko wrote, with the repository root and creation time. It lives inside the
// owner-private review root, is written atomically (temporary file, then rename) and is read
// fail-closed: an unreadable or malformed file is treated as empty and quarantined, never parsed
// leniently.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { reportReviewFailure } from "../diagnostics.js";

const REGISTRY_FILE = "registry.json";
const REGISTRY_VERSION = 1;
const MAX_ENTRIES = 10_000;
const LEAF = /^r-[a-f0-9]{24}$/u;
const PRIVATE_REF = /^refs\/keiko-review\/[A-Za-z0-9._/-]{1,200}$/u;

interface ReviewWorktreeRecord {
  readonly leaf: string;
  readonly repositoryRoot: string;
  readonly createdAtMs: number;
}

export interface ReviewPrivateRefRecord {
  readonly ref: string;
  readonly repositoryRoot: string;
  readonly createdAtMs: number;
  /** The pull request a ref belongs to; absent for a local range. */
  readonly pullRequestNumber?: number | undefined;
}

interface ReviewRegistrySnapshot {
  readonly worktrees: readonly ReviewWorktreeRecord[];
  readonly refs: readonly ReviewPrivateRefRecord[];
}

const EMPTY: ReviewRegistrySnapshot = { worktrees: [], refs: [] };

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asWorktree(value: unknown): ReviewWorktreeRecord | undefined {
  const record = value as Partial<ReviewWorktreeRecord> | null;
  if (typeof record !== "object" || record === null) return undefined;
  const { leaf, repositoryRoot, createdAtMs } = record;
  if (typeof leaf !== "string" || !LEAF.test(leaf)) return undefined;
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) return undefined;
  return isTimestamp(createdAtMs) ? { leaf, repositoryRoot, createdAtMs } : undefined;
}

function isPrivateRef(value: unknown): value is string {
  return typeof value === "string" && PRIVATE_REF.test(value) && !value.includes("..");
}

function isRepositoryRoot(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value);
}

function asRef(value: unknown): ReviewPrivateRefRecord | undefined {
  const record = value as Partial<ReviewPrivateRefRecord> | null;
  if (typeof record !== "object" || record === null) return undefined;
  const { ref, repositoryRoot, createdAtMs, pullRequestNumber } = record;
  if (!isPrivateRef(ref) || !isRepositoryRoot(repositoryRoot) || !isTimestamp(createdAtMs)) {
    return undefined;
  }
  if (pullRequestNumber !== undefined && !isTimestamp(pullRequestNumber)) return undefined;
  return {
    ref,
    repositoryRoot,
    createdAtMs,
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
  };
}

function parseSnapshot(text: string): ReviewRegistrySnapshot | undefined {
  const value = JSON.parse(text) as { version?: unknown; worktrees?: unknown; refs?: unknown };
  if (value.version !== REGISTRY_VERSION) return undefined;
  if (!Array.isArray(value.worktrees) || !Array.isArray(value.refs)) return undefined;
  const worktrees = (value.worktrees as unknown[]).map(asWorktree);
  const refs = (value.refs as unknown[]).map(asRef);
  if (worktrees.includes(undefined) || refs.includes(undefined)) return undefined;
  return {
    worktrees: worktrees as ReviewWorktreeRecord[],
    refs: refs as ReviewPrivateRefRecord[],
  };
}

export interface ReviewRegistry {
  read(): Promise<ReviewRegistrySnapshot>;
  update(change: (snapshot: ReviewRegistrySnapshot) => ReviewRegistrySnapshot): Promise<void>;
}

/** Ensures the owner-private review root exists (0700). */
export async function ensureReviewRoot(reviewRoot: string): Promise<void> {
  await mkdir(reviewRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(reviewRoot, 0o700);
}

async function readSnapshot(reviewRoot: string): Promise<ReviewRegistrySnapshot> {
  const file = join(reviewRoot, REGISTRY_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw error;
  }
  let snapshot: ReviewRegistrySnapshot | undefined;
  try {
    snapshot = parseSnapshot(text);
  } catch (error) {
    reportReviewFailure("review.worktree.registry-read", undefined, error);
    snapshot = undefined;
  }
  if (snapshot !== undefined) return snapshot;
  // A malformed registry is quarantined, not trusted; the orphan sweep still finds every review
  // directory on disk, and private refs without a record are swept as unreferenced.
  await rename(file, join(reviewRoot, `${REGISTRY_FILE}.invalid-${randomUUID()}`));
  return EMPTY;
}

async function writeSnapshot(reviewRoot: string, snapshot: ReviewRegistrySnapshot): Promise<void> {
  if (snapshot.worktrees.length + snapshot.refs.length > MAX_ENTRIES) {
    throw new RangeError("review registry is full");
  }
  await ensureReviewRoot(reviewRoot);
  const temporary = join(reviewRoot, `.${REGISTRY_FILE}.${randomUUID()}.tmp`);
  const body = JSON.stringify({ version: REGISTRY_VERSION, ...snapshot });
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, join(reviewRoot, REGISTRY_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A registry whose updates are serialized, so concurrent runs never lose each other's records. */
export function createReviewRegistry(reviewRoot: string): ReviewRegistry {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    // The caller awaits `next` and sees its failure; the queue only needs to keep moving.
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    read: () => serialized(() => readSnapshot(reviewRoot)),
    update: (change) =>
      serialized(async () => {
        await writeSnapshot(reviewRoot, change(await readSnapshot(reviewRoot)));
      }),
  };
}
