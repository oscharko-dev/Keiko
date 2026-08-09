// GEN-PERF-PERSISTENCE-007 regression: withReviewArtifactLock's critical section is synchronous, so
// the poll wait cannot yield the event loop. Rather than exhaust REVIEW_LOCK_ATTEMPTS busy-waits on
// a lock that will never release on its own, the lock now records the holder PID and reclaims it
// without polling when that PID is not alive (a crashed writer, or a fresh/ownerless lock file). This
// keeps live cross-writer serialisation while never blocking the loop on a dead lock.
//
// PRE-FIX: a pre-created fresh lock file made applyReviewDecision retry 40×5ms then throw a write
// conflict. POST-FIX: the ownerless lock is reclaimed and the decision persists.
//
// The reclaim tests count SLEEPS, not milliseconds. A wall-clock ceiling measures the runner, not
// the code: it was widened from 250ms to 500ms after one flake and then failed at 1024ms on a
// loaded runner, while a machine fast enough could pass it even after a partial regression toward
// polling. Zero sleeps is the property itself, and it holds on any machine.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  applyReviewDecision,
  loadRunReviewState,
  QualityIntelligenceReviewWriteConflict,
} from "../reviewStore.js";

const RUN_ID = "run-lock-persistence-007";
const LIVE_LOCK_EXPECTED_POLLS = 40;
const LIVE_LOCK_EXPECTED_SLEEPS = 39;
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
  it.each([
    ["is ownerless", ""],
    ["records a PID that is not alive", "2147483646\n"],
  ])("reclaims a fresh lock that %s without busy-waiting once", (_label, lockContents) => {
    const evidenceDir = freshEvidenceDir();
    const lockPath = reviewLockPath(evidenceDir);
    writeFileSync(lockPath, lockContents);
    const sleepSpy = vi.spyOn(Atomics, "wait");

    try {
      approveRun(evidenceDir);

      // ZERO sleeps is the invariant, stated exactly. The busy-wait path this distinguishes from
      // sleeps LIVE_LOCK_EXPECTED_SLEEPS times, so any regression toward polling shows up as a
      // non-zero count on the very first retry — a strictly tighter bound than the wall-clock
      // ceiling this replaces, which measured the runner rather than the code and had to be
      // widened once already before flaking again at 1024ms on a loaded runner.
      expect(sleepSpy).not.toHaveBeenCalled();
      expect(loadRunReviewState(RUN_ID, evidenceDir)?.runState).toBe("approved");
      expect(() => readFileSync(lockPath, "utf8")).toThrow();
    } finally {
      sleepSpy.mockRestore();
    }
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

  it("does not reclaim a lock held by a live foreign process", () => {
    const evidenceDir = freshEvidenceDir();
    const lockPath = reviewLockPath(evidenceDir);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: "ignore",
    });
    const killSpy = vi.spyOn(process, "kill");
    const sleepSpy = vi.spyOn(Atomics, "wait");
    try {
      if (holder.pid === undefined) throw new Error("expected child process pid");
      writeFileSync(lockPath, `${String(holder.pid)}\n`);

      expect((): void => {
        approveRun(evidenceDir);
      }).toThrow(QualityIntelligenceReviewWriteConflict);
      expect(killSpy).toHaveBeenCalledTimes(LIVE_LOCK_EXPECTED_POLLS);
      expect(killSpy.mock.calls.every(([pid, signal]) => pid === holder.pid && signal === 0)).toBe(
        true,
      );
      expect(sleepSpy).toHaveBeenCalledTimes(LIVE_LOCK_EXPECTED_SLEEPS);
      expect(sleepSpy.mock.calls.every(([_view, _index, _value, ms]) => ms === 5)).toBe(true);
      expect(readFileSync(lockPath, "utf8")).toBe(`${String(holder.pid)}\n`);
    } finally {
      sleepSpy.mockRestore();
      killSpy.mockRestore();
      holder.kill();
    }
  });

  it("removes a lock when the protected review write fails after acquisition", () => {
    const evidenceDir = freshEvidenceDir();
    const expected = new Error("redactor failed");

    expect(() =>
      applyReviewDecision({
        runId: RUN_ID,
        evidenceDir,
        action: "approve",
        scope: "run",
        actor: { actorId: "reviewer", displayLabel: "Reviewer" },
        now: "2026-07-03T10:00:00.000Z",
        redact: () => {
          throw expected;
        },
      }),
    ).toThrow(expected);
    expect(() => readFileSync(reviewLockPath(evidenceDir), "utf8")).toThrow();
  });
});
