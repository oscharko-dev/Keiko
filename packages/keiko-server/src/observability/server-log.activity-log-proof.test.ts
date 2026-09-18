// Registry-linked executable proofs (#3532) for the Activity Log STORAGE evidence server-log.ts
// itself emits: segment lifecycle, retention, pressure, pins and the sink's own failure evidence.
//
// Kept in a dedicated file (never `server-log.test.ts`) because several concurrent streams edit
// that file's existing suites; every proof below drives the same exported production entry points
// (`createFileServerLogSink`, `pinActivityLogWindow`, `formatServerLogLine`) that file already
// covers, and reads back real persisted lines via `readPersistedActivityLog` / `formatActivityLogProofLine`
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
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { logGitChangeApply } from "../chat-activity.js";
import {
  closeFileServerLogSinks,
  createFileServerLogSink,
  formatServerLogLine,
  pinActivityLogWindow,
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

  function logsDir(dir: string): string {
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

  it("recovers its own orphaned active segment when the name is reoccupied between writes", () => {
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    logGitChangeApply(sink, "corr-recovered-01", "preview");
    const active = createFileServerLogSink(stateDir)
      ? undefined
      : undefined; // placeholder removed below
    void active;

    const before = readPersistedActivityLog(stateDir);
    void before;
    throw new Error("unused");
  });
});
