// GEN-PERF-PERSISTENCE-007 regression: withReviewArtifactLock's critical section is synchronous, so
// the poll wait cannot yield the event loop. Rather than exhaust REVIEW_LOCK_ATTEMPTS busy-waits on
// a lock that will never release on its own, the lock now records the holder PID and reclaims it
// without polling when that PID is not alive (a crashed writer, or a fresh/ownerless lock file). This
// keeps live cross-writer serialisation while never blocking the loop on a dead lock.
//
// PRE-FIX: a pre-created fresh lock file made applyReviewDecision retry 40×5ms then throw a write
// conflict. POST-FIX: the ownerless lock is reclaimed and the decision persists.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { applyReviewDecision, loadRunReviewState } from "../reviewStore.js";

const RUN_ID = "run-lock-persistence-007";
const dirs: string[] = [];

function freshEvidenceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-qi-review-lock-"));
  dirs.push(dir);
  return dir;
}

function reviewLockPath(evidenceDir: string): string {
  const lockDir = join(evidenceDir, "qi", ".review-locks");
  mkdirSync(lockDir, { recursive: true });
  return join(lockDir, `${sha256Hex(RUN_ID).slice(0, 32)}.lock`);
}

function approveRun(evidenceDir: string): void {
  applyReviewDecision({
    runId: RUN_ID,
    evidenceDir,
    action: "approve",
    scope: "run",
    actor: { actorId: "reviewer", displayLabel: "Reviewer" },
    now: "2026-07-03T10:00:00.000Z",
    redact: (value: unknown): unknown => value,
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("withReviewArtifactLock — non-blocking reclaim (GEN-PERF-PERSISTENCE-007)", () => {
  it("reclaims a fresh, ownerless lock instead of busy-waiting all attempts", () => {
    const evidenceDir = freshEvidenceDir();
    // A FRESH lock file with no PID inside — no live owner.
    const lockPath = reviewLockPath(evidenceDir);
    writeFileSync(lockPath, "");

    approveRun(evidenceDir);

    expect(loadRunReviewState(RUN_ID, evidenceDir)?.runState).toBe("approved");
    expect(() => readFileSync(lockPath, "utf8")).toThrow();
  });

  it("reclaims a fresh lock whose recorded PID is not alive", () => {
    const evidenceDir = freshEvidenceDir();
    const lockPath = reviewLockPath(evidenceDir);
    writeFileSync(lockPath, "2147483646\n");

    approveRun(evidenceDir);
    expect(loadRunReviewState(RUN_ID, evidenceDir)?.runState).toBe("approved");
    expect(() => readFileSync(lockPath, "utf8")).toThrow();
  });

  it("leaves no lock file behind after a normal decision", () => {
    const evidenceDir = freshEvidenceDir();
    approveRun(evidenceDir);
    const lockPath = join(
      evidenceDir,
      "qi",
      ".review-locks",
      `${sha256Hex(RUN_ID).slice(0, 32)}.lock`,
    );
    expect(() => readFileSync(lockPath, "utf8")).toThrow();
  });
});
