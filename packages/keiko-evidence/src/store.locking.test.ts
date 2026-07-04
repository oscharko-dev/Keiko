// GEN-PERF-PERSISTENCE-007 regression: the EvidenceStore.update critical section is synchronous, so
// a poll wait cannot yield the event loop. Rather than busy-wait (Atomics.wait) up to the 5s lock
// timeout on a lock that will never release on its own, acquireManifestLock now records the holder
// PID and reclaims IMMEDIATELY when that PID is not alive (a crashed writer, or a fresh/ownerless
// lock file) — so a fresh, non-stale, ownerless lock no longer blocks the loop for seconds.
//
// PRE-FIX: a freshly-created lock file (current mtime, no live owner) forces a 5s busy-wait and then
// throws (deadline exceeded). POST-FIX: it is reclaimed instantly and the update succeeds fast.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("acquireManifestLock — non-blocking reclaim (GEN-PERF-PERSISTENCE-007)", () => {
  it("reclaims a fresh, ownerless lock instantly instead of busy-waiting the 5s timeout", () => {
    const dir = freshDir();
    const store = createNodeEvidenceStore(dir);
    store.put("run-1", "[1]");

    // A FRESH lock file (current mtime => NOT mtime-stale) with no PID inside — i.e. no live owner.
    const lockPath = join(dir, "run-1.lock");
    writeFileSync(lockPath, "");

    const start = performance.now();
    expect(store.update?.("run-1", (existing) => `${existing ?? "[]"},2`)).toMatch(/run-1\.json$/);
    const elapsedMs = performance.now() - start;

    // Did NOT block on the 5s busy-wait: well under 100ms proves instant PID-liveness reclaim.
    expect(elapsedMs).toBeLessThan(100);
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

    const start = performance.now();
    expect(store.update?.("run-1", (existing) => `${existing ?? "[]"},2`)).toMatch(/run-1\.json$/);
    expect(performance.now() - start).toBeLessThan(100);
    expect(store.get("run-1")).toBe("[1],2");
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
