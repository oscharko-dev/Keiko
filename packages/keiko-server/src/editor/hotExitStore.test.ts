import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSecretVault } from "@oscharko-dev/keiko-security/secret-vault";
import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_TTL_MS,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";
import { createEditorHotExitStore } from "./hotExitStore.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const VAULT_KEY = Buffer.alloc(32, 0x71).toString("base64");
const ROTATED_VAULT_KEY = Buffer.alloc(32, 0x72).toString("base64");
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(REAL_TMPDIR, "keiko-hot-exit-"));
  tmpDirs.push(dir);
  return dir;
}

function snapshot(overrides: Partial<EditorHotExitSnapshotV1> = {}): EditorHotExitSnapshotV1 {
  return {
    schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
    workspaceRoot: "/repo",
    relativePath: "src/app.ts",
    content: "const token = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n",
    baseVersion: { sizeBytes: 16, modifiedAt: 1, contentHash: "a".repeat(64) },
    contentHash: "b".repeat(64),
    savedContentHash: "a".repeat(64),
    updatedAt: 1_000,
    paneId: "pane-1",
    windowId: "editor-1",
    ...overrides,
  };
}

describe("editor hot-exit server store", () => {
  it("stores recoverable content encrypted at rest under a hashed ref", () => {
    const stateDir = tempStateDir();
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });
    // updatedAt must be realistic (near the real clock): write() now prunes against the server's
    // own Date.now() (KEIKO-0367), so a synthetic epoch-relative timestamp would already read as
    // TTL-expired and be reaped on write.
    const stored = snapshot({ updatedAt: Date.now() });

    const result = store.write(
      stored,
      store.snapshotRefFor(stored.workspaceRoot, stored.relativePath),
    );
    const recovered = store.read(result.snapshotRef, stored.updatedAt + 1);

    expect(result.snapshotRef).toMatch(/^hot-exit:[a-f0-9]{64}$/u);
    expect(result.snapshotRef).not.toContain("/repo");
    expect(result.snapshotRef).not.toContain("src/app.ts");
    expect(recovered?.content).toBe(stored.content);
    const vaultBytes = readFileSync(join(stateDir, "editor-hot-exit", "snapshots.vault"), "utf8");
    expect(vaultBytes).not.toContain(stored.content);
    expect(vaultBytes).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("deletes expired entries on read", () => {
    const stateDir = tempStateDir();
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });
    // r6: read()'s TTL check is anchored to the server receipt clock recorded at write time
    // (Date.now() inside write()), not the persisted client updatedAt -- so nowMs values passed
    // to read() must be offsets from that same real-clock write moment, not a tiny synthetic
    // epoch, to land on either side of the TTL boundary.
    const writeNow = Date.now();
    const seeded = snapshot({ updatedAt: writeNow });
    const result = store.write(
      seeded,
      store.snapshotRefFor(seeded.workspaceRoot, seeded.relativePath),
    );

    expect(store.read(result.snapshotRef, writeNow + EDITOR_HOT_EXIT_TTL_MS + 2)).toBeNull();
    expect(store.read(result.snapshotRef, writeNow + 1_001)).toBeNull();
  });

  it("treats an undecryptable snapshot entry as a miss and removes it", () => {
    const stateDir = tempStateDir();
    const original = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });
    const seeded = snapshot();
    const result = original.write(
      seeded,
      original.snapshotRefFor(seeded.workspaceRoot, seeded.relativePath),
    );
    const rotated = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: ROTATED_VAULT_KEY },
    });

    expect(rotated.read(result.snapshotRef, 1_001)).toBeNull();

    expect(original.read(result.snapshotRef, 1_001)).toBeNull();
  });

  it("skips undecryptable old entries while writing a fresh snapshot", () => {
    const stateDir = tempStateDir();
    const original = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });
    const seeded = snapshot();
    original.write(seeded, original.snapshotRefFor(seeded.workspaceRoot, seeded.relativePath));
    const rotated = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: ROTATED_VAULT_KEY },
    });
    // updatedAt must be realistic (near the real clock) for the same reason as above: write()
    // prunes against Date.now(), so a synthetic epoch-relative timestamp would be reaped on write.
    const next = snapshot({
      relativePath: "src/next.ts",
      content: "next edit\n",
      updatedAt: Date.now(),
    });

    const result = rotated.write(
      next,
      rotated.snapshotRefFor(next.workspaceRoot, next.relativePath),
    );

    expect(rotated.read(result.snapshotRef, next.updatedAt + 1)?.content).toBe("next edit\n");
    const vaultBytes = readFileSync(join(stateDir, "editor-hot-exit", "snapshots.vault"), "utf8");
    expect(vaultBytes).not.toContain("next edit");
  });

  // KEIKO-0367: the write-time budget prune must use the server's own clock, never the untrusted
  // client-supplied snapshot.updatedAt, as "now" when deciding whether OTHER entries in the shared
  // store have expired. A single write carrying an anomalously far-future updatedAt (clock skew,
  // unit-confusion bug) must not be able to evict every other currently-cached snapshot.
  it("does not evict other entries when a write carries a far-future client timestamp", () => {
    const stateDir = tempStateDir();
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });
    const now = Date.now();
    const firstSnapshot = snapshot({ relativePath: "src/first.ts", updatedAt: now });
    const secondSnapshot = snapshot({ relativePath: "src/second.ts", updatedAt: now });
    const first = store.write(
      firstSnapshot,
      store.snapshotRefFor(firstSnapshot.workspaceRoot, firstSnapshot.relativePath),
    );
    const second = store.write(
      secondSnapshot,
      store.snapshotRefFor(secondSnapshot.workspaceRoot, secondSnapshot.relativePath),
    );

    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1_000;
    const thirdSnapshot = snapshot({ relativePath: "src/third.ts", updatedAt: now + tenYearsMs });
    store.write(
      thirdSnapshot,
      store.snapshotRefFor(thirdSnapshot.workspaceRoot, thirdSnapshot.relativePath),
    );

    expect(store.read(first.snapshotRef)?.content).toBe(snapshot().content);
    expect(store.read(second.snapshotRef)?.content).toBe(snapshot().content);
  });

  // Regression: the KEIKO-0367 fix moved the write-time budget prune from the untrusted client
  // updatedAt to the server's own Date.now(). That correctly stops a single write from evicting
  // OTHER cached entries (covered above), but prune() also runs the TTL-expiry branch over the
  // incoming ref itself: a client clock more than one TTL window behind the server makes the
  // just-added metadata look already expired, so prune deletes it from the index before the
  // vault.set() persist gate is even reached. write() still returns a success-shaped result
  // (snapshotRef + contentSizeBytes) even though nothing was written to the vault -- a silent
  // failure with no recovery snapshot on the far side.
  it("still persists a write whose client clock is far behind the server (clock skew)", () => {
    const stateDir = tempStateDir();
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });
    // Client clock is more than one TTL window behind the server's real Date.now().
    const staleUpdatedAt = Date.now() - 10 * EDITOR_HOT_EXIT_TTL_MS;
    const stale = snapshot({ updatedAt: staleUpdatedAt });

    const result = store.write(
      stale,
      store.snapshotRefFor(stale.workspaceRoot, stale.relativePath),
    );

    // Prove the write path actually persisted the entry, using a nowMs consistent with the
    // fixture's own (stale) clock rather than the real wall clock -- this isolates the write-time
    // persistence bug from read()'s TTL policy (asserted below).
    expect(store.read(result.snapshotRef, staleUpdatedAt + 1)?.content).toBe(stale.content);
    // r6: the TTL basis the store tracks internally is now the server's own receipt clock
    // (Date.now() at write time), never the untrusted client-supplied updatedAt -- so a client
    // clock that is far behind the server no longer makes the very next read() (at the real
    // wall clock) treat a just-written snapshot as already expired. The persisted payload's
    // `updatedAt` field (contract data shown to the user) stays the untouched client value;
    // only the internal eviction/TTL bookkeeping moved to server-arrival time.
    expect(store.read(result.snapshotRef)?.content).toBe(stale.content);
  });

  // r8: r6 anchored the TTL basis to the server's own receipt clock, but only in the in-process
  // metaIndex -- the persisted vault payload never carried that receipt time. After a Keiko
  // restart (fresh process, fresh store instance, empty metaIndex) the very first read() of a
  // ref has no warm meta entry to consult, so it fell straight back to the persisted (client-
  // supplied, untrusted) `updatedAt`. A snapshot from a client clock more than one TTL window
  // behind the server is then TTL-deleted on the first recovery read after restart -- precisely
  // the crash/restart scenario hot-exit exists to survive.
  it("recovers a snapshot on cold read after a restart even when the client clock is far behind the server", () => {
    const stateDir = tempStateDir();
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });
    const staleUpdatedAt = Date.now() - 10 * EDITOR_HOT_EXIT_TTL_MS;
    const stale = snapshot({ updatedAt: staleUpdatedAt });
    const ref = store.snapshotRefFor(stale.workspaceRoot, stale.relativePath);
    store.write(stale, ref);

    // Simulate a Keiko restart: a brand-new store instance over the same on-disk stateDir has no
    // in-process metaIndex at all, exactly like the scale/cold-start tests model a cold process.
    const restarted = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });

    expect(restarted.read(ref)?.content).toBe(stale.content);
  });

  // r8: a stored record written before this fix (or by any writer that never persisted a server
  // receipt timestamp) must keep working under the pre-existing client-updatedAt TTL fallback --
  // adding the new field must be backward-compatible, never a crash or a hard requirement.
  it("still applies the legacy client-updatedAt TTL fallback for a stored record with no persisted server receipt", () => {
    const stateDir = tempStateDir();
    const storePath = join(stateDir, "editor-hot-exit", "snapshots.vault");
    const vault = createLocalSecretVault({
      key: Buffer.from(VAULT_KEY, "base64"),
      storePath,
    });
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
      vault,
    });
    const fresh = snapshot({ updatedAt: Date.now() });
    const freshRef = store.snapshotRefFor(fresh.workspaceRoot, fresh.relativePath);
    const stale = snapshot({
      relativePath: "src/legacy.ts",
      updatedAt: Date.now() - 10 * EDITOR_HOT_EXIT_TTL_MS,
    });
    const staleRef = store.snapshotRefFor(stale.workspaceRoot, stale.relativePath);
    // Seed the vault directly with the pre-fix stored shape (no `serverReceivedAt` field),
    // bypassing store.write() so no server receipt time is ever recorded for these entries.
    for (const [ref, entry] of [[freshRef, fresh] as const, [staleRef, stale] as const]) {
      vault.set(
        ref,
        JSON.stringify({
          schemaVersion: 1,
          content: entry.content,
          baseVersion: entry.baseVersion,
          contentHash: entry.contentHash,
          savedContentHash: entry.savedContentHash,
          contentSizeBytes: Buffer.byteLength(entry.content, "utf8"),
          updatedAt: entry.updatedAt,
          paneId: entry.paneId,
          windowId: entry.windowId,
        }),
      );
    }

    // A legacy record within the TTL window (measured against its own client updatedAt) still
    // reads back successfully.
    expect(store.read(freshRef)?.content).toBe(fresh.content);
    // A legacy record whose client updatedAt is far in the past still expires under the old
    // fallback semantics -- unchanged behaviour for records that never got a server receipt.
    expect(store.read(staleRef)).toBeNull();
  });
});
