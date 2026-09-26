// GEN-PERF-PERSISTENCE-007 regression: the EvidenceStore.update critical section is synchronous, so
// a poll wait cannot yield the event loop. Rather than busy-wait (Atomics.wait) up to the 5s lock
// timeout on a lock that will never release on its own, acquireManifestLock now records the holder
// PID and reclaims without polling when that PID is not alive (a crashed writer, or a fresh/ownerless
// lock file) — so a fresh, non-stale, ownerless lock no longer blocks the loop for seconds.
//
// PRE-FIX: a freshly-created lock file (current mtime, no live owner) forces a 5s busy-wait and then
// throws (deadline exceeded). POST-FIX: it is reclaimed and the update succeeds.

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeEvidenceStore } from "./store.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-evidence-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("acquireManifestLock — non-blocking reclaim (GEN-PERF-PERSISTENCE-007)", () => {
  it("reclaims a fresh, ownerless lock instead of failing after the 5s timeout", () => {
    const dir = freshDir();
    const store = createNodeEvidenceStore(dir);
    store.put("run-1", "[1]");

    // A FRESH lock file (current mtime => NOT mtime-stale) with no PID inside — i.e. no live owner.
    const lockPath = join(dir, "run-1.lock");
    writeFileSync(lockPath, "");

    expect(store.update?.("run-1", (existing) => `${existing ?? "[]"},2`)).toMatch(/run-1\.json$/);

    expect(store.get("run-1")).toBe("[1],2");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a fresh lock whose recorded PID is not alive", () => {
    const dir = freshDir();
    const store = createNodeEvidenceStore(dir);
    store.put("run-1", "[1]");

    // A dead PID that is extremely unlikely to be live (max 32-bit pid range sentinel).
    const lockPath = join(dir, "run-1.lock");
    writeFileSync(lockPath, "2147483646\n");

    expect(store.update?.("run-1", (existing) => `${existing ?? "[]"},2`)).toMatch(/run-1\.json$/);
    expect(store.get("run-1")).toBe("[1],2");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("stamps the acquiring process PID into the lock during the critical section", () => {
    const dir = freshDir();
    const store = createNodeEvidenceStore(dir);
    store.put("run-1", "[1]");

    let pidInsideCriticalSection: string | undefined;
    store.update?.("run-1", (existing) => {
      // The lock is held while this callback runs — read its stamped owner.
      pidInsideCriticalSection = readFileSync(join(dir, "run-1.lock"), "utf8");
      return `${existing ?? "[]"},2`;
    });

    expect(pidInsideCriticalSection?.trim()).toBe(String(process.pid));
    // Lock removed after release.
    expect(existsSync(join(dir, "run-1.lock"))).toBe(false);
  });
});

// KEIKO-0119 / KEIKO-1029: the fast reclaim above reads "lock file present but carrying no live
// owner" as "abandoned". A lock created empty and stamped afterwards is indistinguishable from
// that state for as long as the stamp is outstanding, so a concurrent acquirer can delete a lock
// its live owner is still forming and both processes enter the critical section. The window is
// closed by never publishing an unstamped lock, and by releasing only the file we still own.
describe("acquireManifestLock — mutual exclusion across processes", () => {
  it("writes the owner stamp before the lock is observable at its canonical path", async () => {
    // The window is entirely inside one synchronous acquisition, so it cannot be observed from
    // another task. Observe it at the stamp itself instead: when the owner PID is written, the
    // canonical lock path must not exist yet. Creating the lock first and stamping it afterwards
    // — the shape this pins against — makes that assertion false.
    const dir = freshDir();
    const lockPath = join(dir, "run-1.lock");
    const stamp = `${String(process.pid)}\n`;
    const lockExistedAtStamp: boolean[] = [];

    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      default: actualFs,
      writeSync: (...args: readonly unknown[]): number => {
        if (args[1] === stamp) lockExistedAtStamp.push(actualFs.existsSync(lockPath));
        return (actualFs.writeSync as (...forwarded: readonly unknown[]) => number)(...args);
      },
    }));
    const { createNodeEvidenceStore: createStore } = await import("./store.js");

    const store = createStore(dir);
    store.put("run-1", "[1]");
    store.update?.("run-1", (existing) => `${existing ?? "[]"},2`);

    expect(lockExistedAtStamp).toEqual([false]);
    expect(store.get("run-1")).toBe("[1],2");
    expect(existsSync(lockPath)).toBe(false);
    // The staging file used to publish the lock is not left behind in the evidence directory.
    expect(readdirSync(dir).filter((name) => name.includes("pidtmp"))).toEqual([]);
  });

  it("wraps a staging failure as EvidenceWriteError and leaves no temp file behind", async () => {
    // Staging the owner stamp can fail for reasons unrelated to contention (disk full, EACCES, a
    // transient fs fault). That throw must not escape the evidence boundary raw: a Node fs error
    // carries the absolute evidence path in its message (CWE-209), and the half-created .pidtmp
    // must still be cleaned up.
    const dir = freshDir();

    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      default: actualFs,
      fsyncSync: (): void => {
        throw Object.assign(new Error(`ENOSPC: no space left on device, fsync '${dir}/x.pidtmp'`), {
          code: "ENOSPC",
        });
      },
    }));
    const { createNodeEvidenceStore: createStore } = await import("./store.js");
    const { EvidenceWriteError } = await import("./errors.js");

    const store = createStore(dir);
    expect(() => {
      store.update?.("run-1", (existing) => `${existing ?? "[]"},2`);
    }).toThrow(EvidenceWriteError);
    expect(readdirSync(dir).filter((name) => name.includes("pidtmp"))).toEqual([]);
  });

  it("does not remove a lock that another process reclaimed and now holds", () => {
    const dir = freshDir();
    const store = createNodeEvidenceStore(dir);
    store.put("run-1", "[1]");
    const lockPath = join(dir, "run-1.lock");

    store.update?.("run-1", (existing) => {
      // Simulate a concurrent process reclaiming this lock (as stale or ownerless) and taking
      // ownership: same path, different file. Releasing by path alone would drop that holder out
      // of its own critical section.
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, "2147483646\n");
      return `${existing ?? "[]"},2`;
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe("2147483646");
  });
});
