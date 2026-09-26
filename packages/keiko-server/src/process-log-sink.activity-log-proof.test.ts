// Activity Log proof for `command.terminated` (#3532). Kept in a file of its own, separate from
// process-log-sink.test.ts, which a concurrent stream owns: this file's only job is to drive the
// real `logCommandTermination` emitter and prove its persisted line against the registered
// operation contract.

import { describe, expect, it } from "vitest";
import type { CommandTerminationEvidence } from "@oscharko-dev/keiko-contracts";
import { createBufferedServerLogSink } from "./observability/server-log.js";
import { logCommandTermination } from "./process-log-sink.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

describe("logCommandTermination — Activity Log proof", () => {
  it("writes a body-free command.terminated line carrying the childPid, reason and verified tree-kill disposition", () => {
    const sink = createBufferedServerLogSink();
    const evidence: CommandTerminationEvidence = {
      reason: "timeout",
      childPid: 4321,
      windowsTreeKill: "not-attempted",
    };

    logCommandTermination(sink, "req-command-terminated-0001", evidence);

    expect(sink.events).toHaveLength(1);
    const [line] = sink.events;
    expect(line).toMatchObject({
      category: "diagnostic",
      op: "command.terminated",
      correlationId: "req-command-terminated-0001",
      extra: { reason: "timeout", childPid: 4321, windowsTreeKill: "not-attempted" },
    });
    const proven = expectActivityLogProof(
      "command.terminated.line",
      formatActivityLogProofLine(line ?? {}),
    );
    expect(proven).toMatchObject({ reason: "timeout", childPid: 4321 });
  });

  it("carries the escalation disposition only on the SIGKILL-escalation line", () => {
    const sink = createBufferedServerLogSink();
    const evidence: CommandTerminationEvidence = {
      reason: "abort",
      childPid: 4322,
      windowsTreeKill: "failed",
      escalation: "succeeded",
    };

    logCommandTermination(sink, "req-command-terminated-0002", evidence);

    const [line] = sink.events;
    expect(line?.extra).toMatchObject({ escalation: "succeeded" });
  });
});
