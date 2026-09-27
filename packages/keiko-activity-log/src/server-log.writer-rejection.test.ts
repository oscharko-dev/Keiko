// In-process proofs for the writer-ownership rejection path (ADR-0179). The cross-graph proofs in
// `server-log.writer-ownership.test.ts` run in child processes and a worker thread; these drive the
// same process owner slot inside this test process, so every rejection branch is exercised where
// its assertions and coverage can see it. Each test restores the slot it replaced.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  expectActivityLogStderrProof,
  expectRegisteredActivityLogLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  ActivityLogWriterOwnershipError,
  claimActivityLogWriterOwnership,
  closeFileServerLogSinks,
  createFileServerLogSink,
  resetServerLogFailureNotices,
} from "./server-log.js";

const WRITER_OWNER_KEY = Symbol.for("@oscharko-dev/keiko-activity-log/process-writer-owner");
const THIS_FILE_FRAME =
  /^packages\/keiko-activity-log\/src\/server-log\.writer-rejection\.test\.ts:\d+:\d+$/;

interface OwnerSlot {
  readonly reject: (stateDir: string, rejected: unknown, correlationId: unknown) => void;
}

const roots: string[] = [];
let savedSlot: { readonly present: boolean; readonly value: unknown } | undefined;
let stderrWrite: MockInstance<typeof process.stderr.write>;

function stateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-writer-rejection-"));
  roots.push(root);
  return root;
}

// Replaces the process owner slot for one test; `afterEach` puts the previous value back.
function replaceOwnerSlot(value: unknown): void {
  savedSlot ??= {
    present: Reflect.has(globalThis, WRITER_OWNER_KEY),
    value: Reflect.get(globalThis, WRITER_OWNER_KEY),
  };
  Reflect.set(globalThis, WRITER_OWNER_KEY, value);
}

function restoreOwnerSlot(): void {
  if (savedSlot === undefined) return;
  if (savedSlot.present) Reflect.set(globalThis, WRITER_OWNER_KEY, savedSlot.value);
  else Reflect.deleteProperty(globalThis, WRITER_OWNER_KEY);
  savedSlot = undefined;
}

function currentOwner(): OwnerSlot {
  return Reflect.get(globalThis, WRITER_OWNER_KEY) as OwnerSlot;
}

// The one stderr notice a rejection that cannot reach a writer leaves behind.
function writerRejectionNotice(): Record<string, unknown> {
  const notices = stderrWrite.mock.calls.map(([chunk]) => String(chunk).trimEnd());
  expect(notices).toHaveLength(1);
  return expectActivityLogStderrProof("server-log.write-failed.stderr-line", notices[0] ?? "");
}

beforeEach(() => {
  stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  resetServerLogFailureNotices();
  resetActivityLogLossCountersForTests();
});

afterEach(() => {
  restoreOwnerSlot();
  closeFileServerLogSinks();
  resetServerLogFailureNotices();
  vi.restoreAllMocks();
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Activity Log writer rejection inside one process", () => {
  it("persists a rejected claim through the owner with its correlation, error kind and frames", () => {
    const stateDir = stateDirectory();
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    // What another graph hands the owner: its own error, whose stack names the rejected call.
    currentOwner().reject(stateDir, new Error("second graph"), "rejected-call-correlation");
    // An older graph passes neither: the line still persists, with the sanctioned fallback.
    currentOwner().reject(stateDir, undefined, 42);
    sink.close?.();

    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "activity-log.writer-rejected",
    ).map((line) => expectRegisteredActivityLogLine("activity-log.writer-rejected", line));
    expect(lines).toHaveLength(2);
    const [evidenced, skewed] = lines;
    expect(evidenced).toMatchObject({
      level: "error",
      errorKind: "conflict",
      correlationId: "rejected-call-correlation",
      reason: "process-writer-owned",
      frames: expect.arrayContaining([expect.stringMatching(THIS_FILE_FRAME)]) as unknown,
    });
    expect(skewed).toMatchObject({
      level: "error",
      errorKind: "conflict",
      correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
    });
    expect(skewed).not.toHaveProperty("frames");
    expect(activityLogLossCounters()["persistence-failed"]).toBe(0);
  });

  it("hands a live owner the error it throws and the attempted operation's correlation", () => {
    const reject = vi.fn();
    replaceOwnerSlot({ graphToken: {}, reject });
    const stateDir = stateDirectory();

    let thrown: unknown;
    try {
      claimActivityLogWriterOwnership(stateDir, "claim-correlation");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ActivityLogWriterOwnershipError);
    expect(reject).toHaveBeenCalledExactlyOnceWith(stateDir, thrown, "claim-correlation");
    expect(activityLogLossCounters()["persistence-failed"]).toBe(0);
  });

  it.each([
    ["a primitive", "foreign"],
    ["a version-skewed shape", { graphToken: "foreign" }],
    ["an uncallable reject", { graphToken: {}, reject: "not callable" }],
    ["a missing graph token", { graphToken: null, reject: (): void => undefined }],
    [
      "a hostile accessor",
      {
        get graphToken(): never {
          throw new Error("hostile owner slot");
        },
        reject: (): void => undefined,
      },
    ],
  ])("fails closed with counted, correlated evidence for %s in the slot", (_name, slot) => {
    replaceOwnerSlot(slot);

    expect(() => {
      claimActivityLogWriterOwnership(stateDirectory(), "foreign-slot-claim");
    }).toThrow(ActivityLogWriterOwnershipError);

    expect(activityLogLossCounters()["persistence-failed"]).toBe(1);
    expect(writerRejectionNotice()).toMatchObject({
      correlationId: "foreign-slot-claim",
      errorKind: "conflict",
      failedOp: "activity-log.writer-rejected",
      loss: "event-dropped",
    });
  });

  it("counts the loss when the owner has not opened a log it could persist to", async () => {
    replaceOwnerSlot(undefined);
    vi.resetModules();
    // A fresh graph that owns the slot but has never opened a log: its registry of logs is empty.
    const owner = await import("./server-log.js");
    const contracts = await import("@oscharko-dev/keiko-contracts/runtime/observability");
    const stateDir = stateDirectory();
    owner.claimActivityLogWriterOwnership(stateDir);
    contracts.resetActivityLogLossCountersForTests();

    currentOwner().reject(stateDir, new Error("second graph"), "no-log-claim");

    expect(contracts.activityLogLossCounters()["persistence-failed"]).toBe(1);
    expect(writerRejectionNotice()).toMatchObject({
      correlationId: "no-log-claim",
      errorKind: "conflict",
      failedOp: "activity-log.writer-rejected",
    });
  });

  it("refuses a writer outside the main thread with counted, correlated evidence", async () => {
    replaceOwnerSlot(undefined);
    vi.doMock("node:worker_threads", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:worker_threads")>()),
      isMainThread: false,
    }));
    vi.resetModules();
    const worker = await import("./server-log.js");
    const contracts = await import("@oscharko-dev/keiko-contracts/runtime/observability");
    contracts.resetActivityLogLossCountersForTests();

    expect(() => {
      worker.claimActivityLogWriterOwnership(stateDirectory(), "worker-claim");
    }).toThrow(worker.ActivityLogWriterOwnershipError);

    // The worker never took the slot, so the main realm's owner is unchanged.
    expect(Reflect.get(globalThis, WRITER_OWNER_KEY)).toBeUndefined();
    expect(contracts.activityLogLossCounters()["persistence-failed"]).toBe(1);
    expect(writerRejectionNotice()).toMatchObject({
      correlationId: "worker-claim",
      errorKind: "conflict",
      failedOp: "activity-log.writer-rejected",
    });
  });
});
