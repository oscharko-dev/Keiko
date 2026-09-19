// Activity Log proof for `portable.windows-alert.spawn-failed` (#3532 proof backlog, partition
// p4-cli). The private emitter `logWindowsAlertSpawnFailure` fires from inside the exported
// `runDetachedWindowsAlert` when the detached alert child reports a spawn error. Driving it with an
// identity check that authenticates a synthetic Windows system root (so resolution succeeds on any
// host platform) and a fake spawned child whose `"error"` listener fires synchronously reaches the
// real emitter without spawning a real process or requiring a Windows host.
import { describe, expect, it } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { runDetachedWindowsAlert } from "./portable-launch-notifier.js";

describe("portable-launch-notifier activity log proof", () => {
  it("persists portable.windows-alert.spawn-failed when the detached Windows alert child errors", () => {
    const events: SecurityLogEvent[] = [];
    const securityLogSink: SecurityLogSink = { write: (event): void => void events.push(event) };
    const reportedLines: string[] = [];

    runDetachedWindowsAlert(
      "the portable launch failed",
      { SystemRoot: String.raw`C:\Windows` },
      (_command, _args, _options) => ({
        // The real `DetachedAlertChild` contract only ever calls this with `"error"`; no branch is
        // needed to match that one listener the production code registers.
        on: (_event, listener): undefined => {
          listener(Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
          return undefined;
        },
        unref: (): void => undefined,
      }),
      (line): void => void reportedLines.push(line),
      // identityCheck: authenticates the synthetic SystemRoot above so resolution succeeds
      // regardless of the host platform running this test, reaching the spawn step it targets.
      () => true,
      securityLogSink,
      // existsAsFile: the resolved PowerShell path is treated as present.
      () => true,
    );

    expect(reportedLines).toEqual([
      "keiko portable launch: the failure alert could not be shown\n",
    ]);
    expect(events).toHaveLength(1);
    const line = formatActivityLogProofLine(events[0] ?? {});
    const record = expectActivityLogProof("portable.windows-alert.spawn-failed.emitted-line", line);
    expect(record).toMatchObject({
      surface: "portable-failure-alert",
      failureKind: "ENOENT",
      errorKind: "unavailable",
      level: "error",
    });
  });
});
