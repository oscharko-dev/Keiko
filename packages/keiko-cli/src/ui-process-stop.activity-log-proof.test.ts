// Activity Log proofs for the `cli.lifecycle.stop-*` operations (#3532 proof backlog, partition
// p4-cli). Every op here is emitted from inside `terminateUiProcess` — none of the individual
// `emit*` helpers are exported — so each proof drives the real function through the same
// deterministic `performance.now()` stubbing technique already proven in `ui-process-stop.test.ts`
// (read, not edited) rather than waiting out the real grace/escalation budgets.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { writeExclusivePidFile } from "./state-paths.js";
import { terminateUiProcess } from "./ui-process-stop.js";

const tempRoots: string[] = [];
const TEST_LAUNCH_ID = "c".repeat(32);

function makeStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-ui-stop-proof-"));
  tempRoots.push(root);
  return root;
}

function recordingSink(): { readonly sink: SecurityLogSink; readonly events: SecurityLogEvent[] } {
  const events: SecurityLogEvent[] = [];
  return { events, sink: { write: (event): void => void events.push(event) } };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ui-process-stop activity log proofs", () => {
  // One escalated POSIX run exercises three of the four pending ops in a single deterministic
  // pass: the initial SIGTERM request, the escalation decision after the grace budget elapses, and
  // the SIGKILL failure inside that escalation. `performance.now()` is stubbed exactly as the
  // existing suite does (start, then past-budget) so the grace wait never actually sleeps.
  it("persists stop-requested, stop-escalated and stop-escalation-failed across one escalated stop", async () => {
    const stateDir = makeStateDir();
    const pid = 424_242;
    writeExclusivePidFile(join(stateDir, "ui.pid"), pid, TEST_LAUNCH_ID);
    const { sink, events } = recordingSink();
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    let alive = true;
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      const outcome = await terminateUiProcess({
        pid,
        stateDir,
        stopTimeoutMs: 1,
        platform: "linux",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => alive,
        killProcess: (killedPid, signal) => {
          killed.push([killedPid, signal]);
          if (signal === "SIGKILL") {
            alive = false;
            throw Object.assign(new Error("denied"), { code: "EPERM" });
          }
        },
        securityLogSink: sink,
        escalate: true,
        launchId: TEST_LAUNCH_ID,
        verifyLaunchIdentity: () => true,
      });
      expect(outcome).toEqual({ confirmed: true, escalated: true });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killed).toEqual([
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);

    const requested = events.find((event) => event.op === "cli.lifecycle.stop-requested");
    const requestedLine = formatActivityLogProofLine(requested ?? {});
    const requestedRecord = expectActivityLogProof(
      "cli.lifecycle.stop-requested.channel",
      requestedLine,
    );
    expect(requestedRecord).toMatchObject({ channel: "sigterm" });

    const escalated = events.find((event) => event.op === "cli.lifecycle.stop-escalated");
    const escalatedLine = formatActivityLogProofLine(escalated ?? {});
    const escalatedRecord = expectActivityLogProof(
      "cli.lifecycle.stop-escalated.disposition",
      escalatedLine,
    );
    // POSIX never runs the Windows tree-kill helper; the escalation event still fires so the
    // process lifecycle always records that an escalation decision was made.
    expect(escalatedRecord).toMatchObject({ windowsTreeKill: "not-attempted" });

    const escalationFailed = events.find(
      (event) => event.op === "cli.lifecycle.stop-escalation-failed",
    );
    const escalationFailedLine = formatActivityLogProofLine(escalationFailed ?? {});
    const escalationFailedRecord = expectActivityLogProof(
      "cli.lifecycle.stop-escalation-failed.kind",
      escalationFailedLine,
    );
    expect(escalationFailedRecord).toMatchObject({ failureKind: "EPERM" });
  });

  it("persists stop-request-failed when the initial POSIX SIGTERM is refused", async () => {
    const stateDir = makeStateDir();
    const pid = 424_243;
    writeExclusivePidFile(join(stateDir, "ui.pid"), pid, TEST_LAUNCH_ID);
    const { sink, events } = recordingSink();

    await terminateUiProcess({
      pid,
      stateDir,
      stopTimeoutMs: 10_000,
      platform: "darwin",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => false,
      killProcess: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
      securityLogSink: sink,
      escalate: true,
      launchId: TEST_LAUNCH_ID,
      verifyLaunchIdentity: () => true,
    });

    expect(events.map((event) => event.op)).toEqual(["cli.lifecycle.stop-request-failed"]);
    const line = formatActivityLogProofLine(events[0] ?? {});
    const record = expectActivityLogProof("cli.lifecycle.stop-request-failed.kind", line);
    expect(record).toMatchObject({ failureKind: "EPERM" });
    expect(record.errorKind).toBe("unavailable");
  });
});
