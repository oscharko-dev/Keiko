// Registry-linked executable proofs (#3532) for the Activity Log STORAGE evidence server-log.ts
// itself emits: segment lifecycle, retention, pressure, pins and the sink's own failure evidence.
//
// Kept in a dedicated file (never `server-log.test.ts`) because several concurrent streams edit
// that file's existing suites; every proof below drives the same exported production entry points
// (`createFileServerLogSink`, `pinActivityLogWindow`, `formatServerLogLine`) that file already
// covers, and reads back real persisted lines via `readPersistedActivityLog` / `expectActivityLogProof`
// — never a hand-built event or registration object (AGENTS.md section 7 / this task's rule 1).
//
// `logGitChangeApply` (chat-activity.ts) is reused purely as a stable, already-registered "vehicle"
// event: it accepts an injectable `ServerLogSink`, so it is the simplest way to hand the real file
// sink a VALID, production-computed, registered event without constructing one here.

import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogSegmentFileName,
  type ActivityLogSegmentIdentity,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  expectActivityLogProof,
  expectActivityLogStderrProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { logGitChangeApply } from "../chat-activity.js";
import {
  closeFileServerLogSinks,
  createFileServerLogSink,
  formatServerLogLine,
  listActivityLogFiles,
  pinActivityLogWindow,
  resetServerLogFailureNotices,
  serverLogProcessIdentity,
} from "./server-log.js";
import type { ServerLogIdentity } from "./server-log.js";

// A one-shot hook the mutation test arms explicitly; every other test in this file leaves it
// disarmed, so the real filesystem behaves normally for them. Mirrors the swap technique
// `server-log.test.ts` itself uses ("reports an event location as unknown when a peer swaps the
// segment after its write"), reimplemented here because that file cannot be edited (see header).
const swapHook = vi.hoisted(() => ({ armed: false, logsDir: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>): number => {
      const [fd, buffer, offset, length] = args as unknown as readonly [
        number,
        Buffer,
        number,
        number,
      ];
      const written = actual.writeSync(fd, buffer, offset, length);
      const logsDir = swapHook.logsDir;
      if (swapHook.armed && logsDir !== null) {
        const text = buffer.subarray(offset, offset + written).toString("utf8");
        if (text.includes('"op":"server-log.safe-open"')) {
          swapHook.armed = false;
          const activeName = actual
            .readdirSync(logsDir)
            .find((name) => name.endsWith(".active.jsonl"));
          if (activeName !== undefined) {
            actual.renameSync(join(logsDir, activeName), join(logsDir, "peer-moved-proof.jsonl"));
            actual.writeFileSync(join(logsDir, activeName), "", { mode: 0o600 });
          }
        }
      }
      return written;
    },
  };
});

describe("Activity Log storage evidence proofs (#3532)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-log-proof-"));
    swapHook.armed = false;
    swapHook.logsDir = null;
  });

  afterEach(() => {
    closeFileServerLogSinks();
    swapHook.armed = false;
    swapHook.logsDir = null;
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function lines(op: string): readonly string[] {
    return persistedActivityLogLines(readPersistedActivityLog(stateDir), op);
  }

  function logsDirOf(dir: string): string {
    return join(dir, "logs");
  }

  it("persists safe-open on first write and a close-reason seal on shutdown", () => {
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    logGitChangeApply(sink, "corr-safe-open-seal-01", "preview");
    sink.close?.();

    const [safeOpenLine] = lines("server-log.safe-open");
    const safeOpen = expectActivityLogProof(
      "server-log.safe-open.emitted-line",
      safeOpenLine ?? "",
    );
    expect(safeOpen).toMatchObject({
      artifactClass: "activity-log",
      persistenceStatus: "opened",
      completeness: "complete",
      loss: "none",
    });

    const [sealedLine] = lines("activity-log.segment.sealed");
    const sealed = expectActivityLogProof(
      "activity-log.segment.sealed.emitted-line",
      sealedLine ?? "",
    );
    expect(sealed).toMatchObject({ sealReason: "close", loss: "none" });
  });

  it("recovers its own orphaned active segment when its name is reoccupied between writes", () => {
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    logGitChangeApply(sink, "corr-recovered-01", "preview");

    const activeBefore = listActivityLogFiles(stateDir).find((file) => file.kind === "active");
    if (activeBefore === undefined) throw new Error("expected an active segment to exist");
    const stalePath = join(logsDirOf(stateDir), "peer-moved-recovery.jsonl");
    renameSync(activeBefore.path, stalePath);
    writeFileSync(activeBefore.path, `${JSON.stringify({ op: "peer" })}\n`, { mode: 0o600 });

    logGitChangeApply(sink, "corr-recovered-02", "preview");

    const [recoveredLine] = lines("activity-log.segment.recovered");
    const recovered = expectActivityLogProof(
      "activity-log.segment.recovered.emitted-line",
      recoveredLine ?? "",
    );
    expect(recovered).toMatchObject({
      recoveryStatus: "sealed",
      recoveryKind: "unsealed",
      ownerState: "same-process",
      tailState: "terminated",
    });
  });

  it("prunes an aged legacy file on the next segment open and reports the exact age count", () => {
    const old = Date.now() - 20 * 86_400_000; // default retention is 14 days
    const dir = logsDirOf(stateDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const legacyPath = join(dir, "server-2020-01-01.log");
    writeFileSync(
      legacyPath,
      `${JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", op: "legacy" })}\n`,
      {
        mode: 0o600,
      },
    );
    utimesSync(legacyPath, old / 1000, old / 1000);

    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    logGitChangeApply(sink, "corr-retention-01", "preview");

    const [prunedLine] = lines("activity-log.retention.pruned");
    const pruned = expectActivityLogProof(
      "activity-log.retention.pruned.emitted-line",
      prunedLine ?? "",
    );
    expect(pruned).toMatchObject({
      retentionStatus: "pruned",
      prunedByAgeCount: 1,
      failedDeletionCount: 0,
    });
  });

  it("reports retention-blocked pressure when a grammar-named file cannot be safely deleted", (ctx) => {
    if (process.platform === "win32") {
      ctx.skip();
      return;
    }
    const outside = mkdtempSync(join(tmpdir(), "keiko-server-log-proof-victim-"));
    try {
      const victim = join(outside, "victim.jsonl");
      writeFileSync(victim, "outside-content", { mode: 0o600 });
      const dir = logsDirOf(stateDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const old = Date.now() - 40 * 86_400_000;
      const symlinkName = activityLogSegmentFileName(
        { startMs: old, pid: 424_242, instanceId: "eeeeeeee", index: 1 },
        "sealed",
      );
      symlinkSync(victim, join(dir, symlinkName));
      const hardlink = join(dir, "server-2020-02-01.log");
      linkSync(victim, hardlink);
      utimesSync(hardlink, old / 1000, old / 1000);

      const sink = createFileServerLogSink(stateDir, { level: "debug" });
      logGitChangeApply(sink, "corr-pressure-01", "preview");

      const [pressureLine] = lines("activity-log.pressure");
      const pressure = expectActivityLogProof(
        "activity-log.pressure.emitted-line",
        pressureLine ?? "",
      );
      expect(pressure).toMatchObject({
        pressureState: "retention-blocked",
        errorKind: "durability-failed",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("creates a window pin and persists its evidence through the real pin path", () => {
    const now = Date.now();
    const result = pinActivityLogWindow(stateDir, {
      scope: { kind: "window", fromMs: now - 60_000, toMs: now + 60_000 },
      expiresAtMs: now + 3_600_000,
      correlationId: "corr-pin-created-01",
    });
    expect(result.status).toBe("pinned");

    const [pinLine] = lines("activity-log.pin.created");
    const pin = expectActivityLogProof("activity-log.pin.created.emitted-line", pinLine ?? "");
    expect(pin).toMatchObject({
      pinStatus: "created",
      pinKind: "window",
      pinReason: "incident",
      loss: "none",
    });
  });

  it("expires a pin once its window has passed and releases it on the next pin's retention pass", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-18T10:00:00.000Z"));
      const t0 = Date.now();
      const first = pinActivityLogWindow(stateDir, {
        scope: { kind: "window", fromMs: t0 - 1_000, toMs: t0 + 1_000 },
        expiresAtMs: t0 + 2_000,
        correlationId: "corr-pin-expire-01",
      });
      expect(first.status).toBe("pinned");

      vi.setSystemTime(new Date(t0 + 10_000));
      const second = pinActivityLogWindow(stateDir, {
        scope: { kind: "window", fromMs: t0 + 9_000, toMs: t0 + 11_000 },
        expiresAtMs: t0 + 3_600_000,
        correlationId: "corr-pin-expire-02",
      });
      expect(second.status).toBe("pinned");

      const [expiredLine] = lines("activity-log.pin.expired");
      const expired = expectActivityLogProof(
        "activity-log.pin.expired.emitted-line",
        expiredLine ?? "",
      );
      expect(expired).toMatchObject({ expiryReason: "expired", removalStatus: "removed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports quota exhaustion once a pinned window cannot fit inside a tiny pin quota", () => {
    const env = { KEIKO_LOG_PIN_QUOTA_BYTES: "1" };
    const dir = logsDirOf(stateDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const identity: ActivityLogSegmentIdentity = {
      startMs: Date.now() - 120_000,
      pid: process.pid,
      instanceId: "aaaaaaaa",
      index: 1,
    };
    const segmentPath = join(dir, activityLogSegmentFileName(identity, "sealed"));
    const line = `${JSON.stringify({ ts: "2026-09-18T00:00:00.000Z", op: "seeded" })}\n`;
    writeFileSync(segmentPath, line.repeat(200), { mode: 0o600 });

    const now = Date.now();
    const first = pinActivityLogWindow(
      stateDir,
      {
        scope: { kind: "window", fromMs: now - 130_000, toMs: now + 1_000 },
        expiresAtMs: now + 3_600_000,
        correlationId: "corr-pin-quota-01",
      },
      env,
    );
    expect(first.status).toBe("pinned");
    expect(first.status === "pinned" ? first.quotaStatus : undefined).toBe("exceeded");

    pinActivityLogWindow(
      stateDir,
      {
        scope: { kind: "window", fromMs: now, toMs: now + 2_000 },
        expiresAtMs: now + 3_600_000,
        correlationId: "corr-pin-quota-02",
      },
      env,
    );

    const [quotaLine] = lines("activity-log.pin.quota-exhausted");
    const quota = expectActivityLogProof(
      "activity-log.pin.quota-exhausted.emitted-line",
      quotaLine ?? "",
    );
    expect(quota).toMatchObject({ pinQuotaBytes: 1 });
    expect((quota.unprotectedSegmentCount as number) > 0).toBe(true);
  });

  it("replaces a pathologically oversized line with the registered drop marker", () => {
    const identity: ServerLogIdentity = { ...serverLogProcessIdentity(), seq: 1 };
    const extra: Record<string, string> = {};
    for (let index = 0; index < 48; index += 1) {
      extra[`probeField${String(index).padStart(2, "0")}`] = "A".repeat(159);
    }
    const line = formatServerLogLine(
      {
        category: "diagnostic",
        op: "server-log-proof.oversized-probe",
        correlationId: "corr-oversized-01",
        extra,
      },
      new Date(),
      identity,
    );

    const record = expectActivityLogProof("server-log.line-dropped.registered-line", line);
    expect(record).toMatchObject({
      failedOp: "server-log-proof.oversized-probe",
      completeness: "unknown",
      loss: "event-dropped",
    });
    expect(record.droppedLineBytes as number).toBeGreaterThan(8_192);
  });

  it("persists target-mutated when a peer swaps the active segment mid-write", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    swapHook.logsDir = logsDirOf(stateDir);
    swapHook.armed = true;
    const sink = createFileServerLogSink(stateDir, { level: "debug" });

    logGitChangeApply(sink, "corr-mutation-01", "preview");

    const [mutatedLine] = lines("server-log.target-mutated");
    const mutated = expectActivityLogProof(
      "server-log.target-mutated.registered-line",
      mutatedLine ?? "",
    );
    expect(mutated).toMatchObject({
      failedOp: "server-log.safe-open",
      errorKind: "target-mutated",
      completeness: "unknown",
      loss: "event-location-unknown",
    });
  });

  // The write failure a mid-write swap causes never reaches the file: `reportServerLogFailure`
  // writes it as the emergency stderr notice, an incomplete line of an unavailable writer.
  it("writes the write-failed notice to stderr when a peer swaps the active segment", () => {
    // Notices are throttled per window; the previous swap in this file already used this one.
    resetServerLogFailureNotices();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    swapHook.logsDir = logsDirOf(stateDir);
    swapHook.armed = true;
    const sink = createFileServerLogSink(stateDir, { level: "debug" });

    logGitChangeApply(sink, "corr-mutation-02", "preview");

    const notices = stderrWrite.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((text) => text.includes('"op":"server-log.write-failed"'));
    expect(notices.length).toBeGreaterThan(0);
    const notice = expectActivityLogStderrProof(
      "server-log.write-failed.stderr-line",
      notices[0] ?? "",
    );
    expect(notice).toMatchObject({
      loss: "event-location-unknown",
      compatibilityState: "incomplete",
      writerCapability: "unavailable",
    });
    expect(readPersistedActivityLog(stateDir)).not.toContain('"op":"server-log.write-failed"');
  });
});
